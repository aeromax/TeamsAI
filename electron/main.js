const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net } = require('electron')
const path = require('path')
const { spawn, spawnSync, execSync } = require('child_process')
const fs = require('fs')
const { Worker: NodeWorker } = require('worker_threads')

// Catch SIGTRAP before it can kill the process — ONNX Runtime 1.14.x on ARM64
// triggers software breakpoints on certain quantized operations.  Logging it
// instead of crashing means the main window stays alive.
process.on('SIGTRAP', () => {
  console.error('[main] SIGTRAP caught — likely an ONNX Runtime assertion on ARM64')
})

// Must be called synchronously before app.whenReady()
protocol.registerSchemesAsPrivileged([{
  scheme: 'model',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}])

// Database — imported after app is ready (path depends on app.getPath)
let dbModule = null
function getDB() {
  if (!dbModule) dbModule = require('./db')
  return dbModule
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Paths
const resourcesDir = isDev
  ? path.join(__dirname, '..', 'resources')
  : process.resourcesPath

const ollamaBinPath = path.join(resourcesDir, 'bin', 'ollama')
const setupAudioBinPath = path.join(resourcesDir, 'bin', 'setup-audio')
const setupAudioSourcePath = path.join(__dirname, '..', 'swift', 'setup-audio', 'main.swift')

// Find BlackHole pkg by prefix — handles versioned filenames like BlackHole2ch-0.6.1.pkg
function findBlackholePkg() {
  const entries = fs.readdirSync(resourcesDir)
  const pkg = entries.find((f) => f.startsWith('BlackHole') && f.endsWith('.pkg'))
  return pkg ? path.join(resourcesDir, pkg) : null
}

function ensureSetupAudioBinary() {
  if (fs.existsSync(setupAudioBinPath)) return

  if (!isDev) {
    console.warn('[main] setup-audio binary missing in packaged resources:', setupAudioBinPath)
    return
  }

  if (!fs.existsSync(setupAudioSourcePath)) {
    console.warn('[main] setup-audio source missing:', setupAudioSourcePath)
    return
  }

  try {
    fs.mkdirSync(path.dirname(setupAudioBinPath), { recursive: true })
    const result = spawnSync('swiftc', [setupAudioSourcePath, '-o', setupAudioBinPath], { encoding: 'utf8' })
    if (result.status === 0 && fs.existsSync(setupAudioBinPath)) {
      fs.chmodSync(setupAudioBinPath, '755')
      console.log('[main] Built setup-audio binary for dev:', setupAudioBinPath)
      return
    }
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
    console.error('[main] Failed to build setup-audio binary.', output || `swiftc exited with ${result.status}`)
  } catch (err) {
    console.error('[main] Failed to compile setup-audio binary:', err.message)
  }
}

const userDataDir = app.getPath('userData')
const ollamaUserBinPath = path.join(userDataDir, 'bin', 'ollama')
const OLLAMA_MAC_ZIP_URL = 'https://ollama.com/download/Ollama-darwin.zip'
const modelsDir = path.join(userDataDir, 'models', 'ollama')
const whisperCacheDir = path.join(userDataDir, 'models', 'whisper')

// ── Whisper model download (Node.js HTTPS — bypasses renderer fetch restrictions) ─

const WHISPER_MODEL_ID = 'Xenova/whisper-small.en'
const WHISPER_MODEL_DIR = path.join(whisperCacheDir, 'Xenova', 'whisper-small.en')
const WHISPER_HF_BASE = `https://huggingface.co/${WHISPER_MODEL_ID}/resolve/main`
const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/encoder_model.onnx',            // FP32 — avoids ARM64 INT8 NEON SIGTRAP in onnxruntime 1.14
  'onnx/decoder_model_merged.onnx',
]

// ONNX files that must exist for non-quantized mode; downloaded automatically if missing.
const NON_QUANTIZED_ONNX = [
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged.onnx',
]

// Downloads url to dest using Electron's net.fetch (handles redirects, HTTPS, proxies).
// Streams to a .tmp file first, then atomically renames on success.
// Must be called after app is ready (net.fetch is only available then).
async function downloadFile(url, dest, onProgress) {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': 'TeamsAI/1.0' },
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${path.basename(dest)}`)
  }

  const total = parseInt(res.headers.get('content-length') || '0', 10)
  let received = 0
  const tmp = dest + '.tmp'
  const file = fs.createWriteStream(tmp)

  try {
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      file.write(Buffer.from(value))
      if (total && onProgress) onProgress(received / total)
    }
    await new Promise((resolve, reject) => file.close((err) => err ? reject(err) : resolve()))
    fs.renameSync(tmp, dest)
  } catch (err) {
    try { file.destroy() } catch {}
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

// Downloads any missing non-quantized ONNX files so the whisper thread can start.
// Called automatically at launch when the old quantized-only files are present.
async function ensureNonQuantizedWhisper() {
  const missing = NON_QUANTIZED_ONNX.filter((f) => {
    const dest = path.join(WHISPER_MODEL_DIR, f)
    return !fs.existsSync(dest) || fs.statSync(dest).size < 1000
  })
  if (missing.length === 0) return

  console.log('[main] Non-quantized ONNX files missing — auto-downloading:', missing)
  for (const file of missing) {
    const dest = path.join(WHISPER_MODEL_DIR, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    mainWindow?.webContents.send('whisper:status', { ready: false, error: `Downloading model update (${file})…` })
    console.log('[main] Downloading', file, '…')
    try {
      await downloadFile(`${WHISPER_HF_BASE}/${file}`, dest)
      console.log('[main] Downloaded', file)
    } catch (err) {
      console.error('[main] Failed to download', file, err.message)
    }
  }
}

let mainWindow = null
let ollamaProcess = null

// ── Whisper worker thread ──────────────────────────────────────────────────────

let whisperThread = null
let whisperReady = false
const transcribeCallbacks = new Map()
let transcribeIdCounter = 0

function startWhisperThread() {
  whisperThread = new NodeWorker(path.join(__dirname, 'whisper-thread.js'))
  whisperReady = false

  whisperThread.on('message', (msg) => {
    if (msg.type === 'ready') {
      whisperReady = true
      mainWindow?.webContents.send('whisper:status', { ready: true })
    } else if (msg.type === 'result') {
      const cb = transcribeCallbacks.get(msg.id)
      if (cb) { transcribeCallbacks.delete(msg.id); cb(null, msg.text) }
    } else if (msg.type === 'error') {
      console.error('[whisper thread]', msg.error)
      if (msg.id != null) {
        const cb = transcribeCallbacks.get(msg.id)
        if (cb) { transcribeCallbacks.delete(msg.id); cb(new Error(msg.error)) }
      } else {
        mainWindow?.webContents.send('whisper:status', { ready: false, error: msg.error })
      }
    }
  })

  whisperThread.on('error', (err) => {
    console.error('[whisper thread crash]', err)
    mainWindow?.webContents.send('whisper:status', { ready: false, error: err.message })
  })

  // If the worker exits unexpectedly (e.g. SIGTRAP from ONNX Runtime), fail any
  // pending callbacks and notify the renderer so the UI can show an error.
  whisperThread.on('exit', (code) => {
    console.error(`[whisper thread] exited with code ${code}`)
    for (const [id, cb] of transcribeCallbacks) {
      cb(new Error(`Whisper worker exited (code ${code})`))
    }
    transcribeCallbacks.clear()
    if (code !== 0) {
      // Attempt to restart the worker after a short delay so the app
      // stays functional even if the first boot crashed.
      mainWindow?.webContents.send('whisper:status', { ready: false, error: `Worker exited (code ${code}), restarting…` })
      console.log('[main] Restarting Whisper thread in 2 s…')
      setTimeout(startWhisperThread, 2000)
    }
  })

  whisperThread.postMessage({ type: 'init', whisperCacheDir })
  console.log('[main] Whisper thread started')
}

// ── Ollama ────────────────────────────────────────────────────────────────────

// Electron doesn't inherit the shell's PATH, so include common Homebrew locations
const MAC_PATH = [
  '/opt/homebrew/bin',  // Apple Silicon
  '/usr/local/bin',     // Intel
  '/usr/bin',
  '/bin',
  process.env.PATH || '',
].join(':')

function ollamaEnv() {
  return {
    ...process.env,
    PATH: MAC_PATH,
    OLLAMA_MODELS: modelsDir,
    OLLAMA_NO_ANALYTICS: '1',
    OLLAMA_HOST: '127.0.0.1:11434',
  }
}

function ollamaBin() {
  if (fs.existsSync(ollamaBinPath)) return ollamaBinPath
  if (fs.existsSync(ollamaUserBinPath)) return ollamaUserBinPath

  // Check common install locations (Homebrew, system)
  const candidates = [
    '/opt/homebrew/bin/ollama',
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  // Ask the shell — handles app-bundle installs and unusual paths
  try {
    const found = execSync(`PATH="${MAC_PATH}" which ollama 2>/dev/null`, {
      encoding: 'utf8',
      shell: '/bin/zsh',
    }).trim()
    if (found && fs.existsSync(found)) return found
  } catch {}

  return null // not found
}

async function ensureOllamaRuntime(event = null, model = null) {
  const existing = ollamaBin()
  if (existing) return { success: true, path: existing, downloaded: false }

  if (process.platform !== 'darwin') {
    return {
      success: false,
      error: 'Automatic Ollama install is only supported on macOS. Install from https://ollama.com/download.',
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'teamsai-ollama-'))
  const zipPath = path.join(tmpDir, 'Ollama-darwin.zip')
  const extractedBin = path.join(tmpDir, 'Ollama.app', 'Contents', 'Resources', 'ollama')

  try {
    event?.sender.send('setup:pull-progress', { model, line: 'Downloading Ollama runtime…', pct: 0 })
    await downloadFile(OLLAMA_MAC_ZIP_URL, zipPath, (p) => {
      event?.sender.send('setup:pull-progress', {
        model,
        line: 'Downloading Ollama runtime…',
        pct: Math.max(1, Math.round(p * 100)),
      })
    })

    const unzipResult = spawnSync('unzip', ['-q', zipPath, '-d', tmpDir], { encoding: 'utf8' })
    if (unzipResult.status !== 0) {
      const output = `${unzipResult.stdout || ''}${unzipResult.stderr || ''}`.trim()
      throw new Error(output || `unzip exited with ${unzipResult.status}`)
    }
    if (!fs.existsSync(extractedBin)) {
      throw new Error('Downloaded archive does not contain Ollama.app CLI binary')
    }

    fs.mkdirSync(path.dirname(ollamaUserBinPath), { recursive: true })
    fs.copyFileSync(extractedBin, ollamaUserBinPath)
    fs.chmodSync(ollamaUserBinPath, '755')

    event?.sender.send('setup:pull-progress', { model, line: 'Ollama runtime ready', pct: 100 })
    return { success: true, path: ollamaUserBinPath, downloaded: true }
  } catch (err) {
    return { success: false, error: `Failed to install Ollama runtime automatically: ${err.message}` }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

function ollamaUnavailableHint() {
  const bin = ollamaBin()
  if (bin) {
    return `Ollama binary found at ${bin} but server never became reachable on :11434.`
  }
  if (app.isPackaged) {
    return `Bundled Ollama runtime missing at ${ollamaBinPath}. Setup can auto-download Ollama to ${ollamaUserBinPath}.`
  }
  return `Ollama binary not found. Setup can auto-download Ollama, or you can place it at ${ollamaBinPath}.`
}

async function isOllamaRunning() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForOllama(maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 600))
  }
  return false
}

async function startOllama() {
  // If the Ollama menu-bar app (or any other instance) is already running, reuse it
  if (await isOllamaRunning()) {
    console.log('[main] Ollama already running on :11434 — reusing existing server')
    return
  }

  const bin = ollamaBin()
  if (!bin) {
    console.error('[main]', ollamaUnavailableHint())
    return
  }

  fs.mkdirSync(modelsDir, { recursive: true })

  ollamaProcess = spawn(bin, ['serve'], {
    env: ollamaEnv(),
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  ollamaProcess.stdout.on('data', (d) => console.log('[ollama]', d.toString().trim()))
  ollamaProcess.stderr.on('data', (d) => console.error('[ollama]', d.toString().trim()))
  ollamaProcess.on('error', (err) => console.error('[ollama] failed to start:', err.message))
  ollamaProcess.on('exit', (code) => console.log('[ollama] exited with code', code))

  console.log('[main] Ollama starting from:', bin)
}

function stopOllama() {
  if (ollamaProcess && !ollamaProcess.killed) {
    ollamaProcess.kill('SIGTERM')
    ollamaProcess = null
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for better-sqlite3 in renderer via preload
      webSecurity: true,
    },
    show: false,
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  ensureSetupAudioBinary()

  // Serve local Whisper model files to the renderer/workers without browser restrictions
  protocol.handle('model', async (request) => {
    const pathname = new URL(request.url).pathname.replace(/^\//, '')
    const filePath = path.join(whisperCacheDir, pathname)
    try {
      const data = await fs.promises.readFile(filePath)
      const contentType = filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream'
      return new Response(data, { headers: { 'Content-Type': contentType } })
    } catch (err) {
      console.error('[model protocol] not found:', filePath, err.code)
      return new Response('Not found', { status: 404 })
    }
  })

  await startOllama()

  // Check synchronously whether the non-quantized ONNX files are already present.
  const needsOnnxDownload = NON_QUANTIZED_ONNX.some((f) => {
    const dest = path.join(WHISPER_MODEL_DIR, f)
    return !fs.existsSync(dest) || fs.statSync(dest).size < 1000
  })

  if (!needsOnnxDownload) {
    // Files ready — normal startup order.
    startWhisperThread()
    createWindow()
  } else {
    // New non-quantized model files needed — create window first so the renderer
    // can show the "Downloading model update…" status, then download, then start the thread.
    createWindow()
    mainWindow.webContents.once('did-finish-load', async () => {
      await ensureNonQuantizedWhisper()
      startWhisperThread()
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopOllama()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopOllama()
})

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// --- Setup ---

function checkBlackHoleInstalled() {
  // Primary check: use setup-audio status (CoreAudio-level check).
  if (fs.existsSync(setupAudioBinPath)) {
    const tmpBin = '/tmp/teamsai-setup-audio'
    try {
      fs.copyFileSync(setupAudioBinPath, tmpBin)
      fs.chmodSync(tmpBin, '755')
      const { spawnSync } = require('child_process')
      const result = spawnSync(tmpBin, ['status'], { encoding: 'utf8' })
      const output = ((result.stdout || '') + (result.stderr || '')).toLowerCase()
      if (output.includes('blackhole: found')) return { found: true }
    } catch {}
    finally {
      try { fs.unlinkSync(tmpBin) } catch {}
    }
  }

  // Fallback: detect BlackHole from macOS audio device inventory.
  try {
    const { spawnSync } = require('child_process')
    const result = spawnSync('system_profiler', ['SPAudioDataType'], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const output = ((result.stdout || '') + (result.stderr || '')).toLowerCase()
    if (output.includes('blackhole')) return { found: true }
  } catch {}

  return { found: false }
}

ipcMain.handle('setup:install-blackhole', async () => {
  // If BlackHole already exists on the system, skip package lookup/install.
  const check = checkBlackHoleInstalled()
  if (check.found) {
    return { success: true, skipped: true }
  }

  const pkgPath = findBlackholePkg()
  if (!pkgPath) {
    return { success: false, error: 'BlackHole package not found in resources.' }
  }
  // Copy to /tmp first — installer can't access paths through CloudStorage/OneDrive when running as root
  const tmpPkg = '/tmp/BlackHole2ch.pkg'
  try {
    fs.copyFileSync(pkgPath, tmpPkg)
    execSync(
      `osascript -e 'do shell script "installer -pkg \\"${tmpPkg}\\" -target /" with administrator privileges'`
    )
    fs.unlinkSync(tmpPkg)
    return { success: true }
  } catch (err) {
    try { fs.unlinkSync(tmpPkg) } catch {}
    return { success: false, error: err.message }
  }
})

// Check whether BlackHole device is visible to CoreAudio (returns { found: bool })
ipcMain.handle('setup:check-blackhole', async () => {
  return checkBlackHoleInstalled()
})

// Open macOS Privacy & Security settings pane
ipcMain.handle('setup:open-privacy-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_SystemExtensions')
})

// Shared helper — copies the binary, runs setup-audio with args, returns result
function runSetupAudio(args, sleepFirst = false) {
  if (!fs.existsSync(setupAudioBinPath)) {
    const hint = isDev ? ' Run `npm run compile-swift` and relaunch the app.' : ''
    return { success: false, error: `setup-audio binary not found.${hint}` }
  }
  const tmpBin = '/tmp/teamsai-setup-audio'
  try {
    fs.copyFileSync(setupAudioBinPath, tmpBin)
    fs.chmodSync(tmpBin, '755')
  } catch (err) {
    return { success: false, error: `Could not copy binary: ${err.message}` }
  }
  const { spawnSync } = require('child_process')
  if (sleepFirst) spawnSync('sleep', ['3']) // only needed right after BlackHole install
  const cmdArgs = Array.isArray(args) ? args : [args]
  const result = spawnSync(tmpBin, cmdArgs, { encoding: 'utf8' })
  try { fs.unlinkSync(tmpBin) } catch {}
  const output = (result.stdout || '') + (result.stderr || '')
  console.log(`[setup-audio ${cmdArgs.join(' ')}]`, output.trim(), '| status', result.status)
  return result.status === 0
    ? { success: true, output }
    : { success: false, error: output || `Exited with code ${result.status}` }
}

ipcMain.handle('setup:configure-audio', async () => runSetupAudio('setup', true))

// Rebuild Multi-Output Device using a specific output device (e.g. AirPods) as
// the base so the user keeps hearing through their preferred device.
ipcMain.handle('setup:ensure-audio-with', async (_, deviceName) =>
  runSetupAudio(['setup-with', deviceName], false)
)

// Fallback: rebuild with whatever is currently the system default.
ipcMain.handle('setup:ensure-audio', async () => runSetupAudio('setup', false))

// List available output devices (one per line) so the renderer can populate a selector.
ipcMain.handle('setup:list-outputs', async () => {
  const result = runSetupAudio('list-outputs', false)
  if (!result.success) return []
  return result.output.split('\n').map(s => s.trim()).filter(Boolean)
})

ipcMain.handle('setup:teardown-audio', async () => runSetupAudio('teardown', false))

ipcMain.handle('setup:pull-model', async (event, model) => {
  const runtime = await ensureOllamaRuntime(event, model)
  if (!runtime.success) {
    return { success: false, error: runtime.error }
  }

  if (!(await isOllamaRunning())) {
    await startOllama()
  }

  const ready = await waitForOllama()
  if (!ready) {
    return { success: false, error: ollamaUnavailableHint() }
  }

  try {
    // Check if model is already installed — skip download if so
    const tagsRes = await fetch('http://127.0.0.1:11434/api/tags')
    if (tagsRes.ok) {
      const { models = [] } = await tagsRes.json()
      const modelBase = model.split(':')[0]
      const exists = models.some((m) => m.name === model || m.name.startsWith(modelBase + ':'))
      if (exists) {
        event.sender.send('setup:pull-progress', { model, line: 'Already installed', pct: 100 })
        return { success: true }
      }
    }

    // Pull via HTTP streaming API — avoids CLI binary issues entirely
    const res = await fetch('http://127.0.0.1:11434/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    })

    if (!res.ok) {
      const text = await res.text()
      return { success: false, error: `Pull request failed (${res.status}): ${text}` }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // hold incomplete trailing line

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const json = JSON.parse(line)
          if (json.error) return { success: false, error: json.error }
          const pct =
            json.total && json.completed
              ? Math.round((json.completed / json.total) * 100)
              : null
          event.sender.send('setup:pull-progress', { model, line: json.status || '', pct })
        } catch {}
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('setup:download-whisper', async (event) => {
  try {
    fs.mkdirSync(WHISPER_MODEL_DIR, { recursive: true })

    for (let i = 0; i < WHISPER_FILES.length; i++) {
      const filename = WHISPER_FILES[i]
      const dest = path.join(WHISPER_MODEL_DIR, filename)

      // Skip if already present and valid
      if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
        if (filename.endsWith('.json')) {
          try {
            JSON.parse(fs.readFileSync(dest, 'utf8'))
            event.sender.send('setup:whisper-progress', { filename, fileIndex: i, totalFiles: WHISPER_FILES.length, pct: 100 })
            continue
          } catch {
            fs.unlinkSync(dest) // corrupt — re-download
          }
        } else {
          event.sender.send('setup:whisper-progress', { filename, fileIndex: i, totalFiles: WHISPER_FILES.length, pct: 100 })
          continue
        }
      }

      // Ensure subdirectory exists (e.g. onnx/)
      fs.mkdirSync(path.dirname(dest), { recursive: true })

      event.sender.send('setup:whisper-progress', { filename, fileIndex: i, totalFiles: WHISPER_FILES.length, pct: 0 })

      await downloadFile(`${WHISPER_HF_BASE}/${filename}`, dest, (pct) => {
        const overallPct = Math.round(((i + pct) / WHISPER_FILES.length) * 100)
        event.sender.send('setup:whisper-progress', { filename, fileIndex: i, totalFiles: WHISPER_FILES.length, pct: Math.round(pct * 100), overallPct })
      })

      if (filename.endsWith('.json')) {
        try {
          JSON.parse(fs.readFileSync(dest, 'utf8'))
        } catch {
          fs.unlinkSync(dest)
          return { success: false, error: `${filename} download appears corrupted. Check network.` }
        }
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('setup:get-whisper-cache-dir', () => whisperCacheDir)

// ── Whisper transcription ──────────────────────────────────────────────────────

ipcMain.handle('whisper:transcribe', (event, audioBuffer) => {
  if (!whisperThread || !whisperReady) {
    return { success: false, error: 'Transcription model not ready yet' }
  }
  return new Promise((resolve) => {
    const id = transcribeIdCounter++
    transcribeCallbacks.set(id, (err, text) => {
      if (err) resolve({ success: false, error: err.message })
      else resolve({ success: true, text })
    })
    // Transfer the ArrayBuffer to the worker (zero-copy)
    whisperThread.postMessage({ type: 'transcribe', audio: audioBuffer, id }, [audioBuffer])
  })
})

ipcMain.handle('whisper:status', () => ({ ready: whisperReady }))

ipcMain.handle('setup:get-models-dir', () => modelsDir)

// --- Paths ---

ipcMain.handle('app:get-user-data', () => userDataDir)

// --- Open external ---

ipcMain.handle('shell:open-external', (_, url) => {
  // only allow opening local files
  if (url.startsWith('file://')) shell.openPath(url.replace('file://', ''))
})

// --- Database: Setup ---

ipcMain.handle('db:get-setup', (_, key) => getDB().getSetup(key))
ipcMain.handle('db:set-setup', (_, key, value) => getDB().setSetup(key, value))

// --- Database: Meetings ---

ipcMain.handle('db:insert-meeting', (_, title, startedAt) => {
  const db = getDB()
  const info = db.insertMeeting.run(title, startedAt)
  return info.lastInsertRowid
})

ipcMain.handle('db:end-meeting', (_, id, endedAt, durationS) =>
  getDB().endMeeting.run(endedAt, durationS, id)
)

ipcMain.handle('db:get-meeting', (_, id) => getDB().getMeeting.get(id))

ipcMain.handle('db:list-meetings', () => getDB().listMeetings.all())

ipcMain.handle('db:rename-meeting', (_, id, title) => getDB().renameMeeting.run(title, id))

ipcMain.handle('db:delete-meeting', (_, id) => getDB().deleteMeeting.run(id))

// --- Database: Transcripts ---

ipcMain.handle('db:insert-transcript', (_, meetingId, seq, text, ts) =>
  getDB().insertTranscript.run(meetingId, seq, text, ts)
)

ipcMain.handle('db:get-transcripts', (_, meetingId) =>
  getDB().getTranscripts.all(meetingId)
)

// --- Database: Notes ---

ipcMain.handle('db:upsert-notes', (_, meetingId, content) => {
  const db = getDB()
  const existing = db.getNotes.get(meetingId)
  if (existing) {
    db.updateNotes.run(content, meetingId)
  } else {
    db.upsertNotes.run(meetingId, content)
  }
})

ipcMain.handle('db:get-notes', (_, meetingId) => getDB().getNotes.get(meetingId))

// --- Database: Drafts ---

ipcMain.handle('db:insert-draft', (_, meetingId, context, content) =>
  getDB().insertDraft.run(meetingId, context, content)
)

ipcMain.handle('db:get-drafts', (_, meetingId) => getDB().getDrafts.all(meetingId))

// --- Export ---

ipcMain.handle('export:save-markdown', async (_, { defaultName, content }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('desktop'), defaultName),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (!filePath) return { success: false, cancelled: true }
  fs.writeFileSync(filePath, content, 'utf8')
  return { success: true, filePath }
})
