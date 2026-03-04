/**
 * Whisper Node.js worker thread
 * Runs @xenova/transformers in a proper Node.js environment — no WASM/browser issues.
 *
 * Messages in:  { type: 'init', whisperCacheDir }
 *               { type: 'transcribe', audio: Float32Array buffer, id: number }
 * Messages out: { type: 'ready' }
 *               { type: 'result', text: string, id: number }
 *               { type: 'error', error: string, id?: number }
 */

const { parentPort } = require('worker_threads')

console.log('[whisper-thread] worker started, pid:', process.pid)

const MODEL_ID = 'Xenova/whisper-small.en'

let asr = null

// Serialise all transcription requests — ONNX Runtime is NOT safe for concurrent
// inference on the same pipeline instance and will SIGTRAP if called concurrently.
const queue = []
let processing = false

async function processQueue() {
  if (processing) return
  processing = true
  while (queue.length > 0) {
    const msg = queue.shift()
    const samples = msg.audio.byteLength / 4
    console.log('[whisper-thread] transcribing', samples, 'samples...')
    try {
      const audio = new Float32Array(msg.audio)
      const result = await asr(audio, {
        language: 'english',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      })
      console.log('[whisper-thread] done:', JSON.stringify(result.text?.trim()?.slice(0, 60)))
      parentPort.postMessage({ type: 'result', text: result.text?.trim() ?? '', id: msg.id })
    } catch (err) {
      console.error('[whisper-thread] asr error:', err.message)
      parentPort.postMessage({ type: 'error', error: err.message, id: msg.id })
    }
  }
  processing = false
}

async function init(whisperCacheDir) {
  console.log('[whisper-thread] init(), cacheDir:', whisperCacheDir)

  // Dynamic import because @xenova/transformers ships ESM
  const { pipeline, env } = await import('@xenova/transformers')
  console.log('[whisper-thread] @xenova/transformers imported')

  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = whisperCacheDir  // files at {dir}/Xenova/whisper-small.en/

  console.log('[whisper-thread] loading pipeline...')
  asr = await pipeline('automatic-speech-recognition', MODEL_ID, {
    quantized: false,  // quantized (INT8) triggers ARM64 NEON SIGTRAP on M-series Macs
  })
  console.log('[whisper-thread] pipeline ready!')

  parentPort.postMessage({ type: 'ready' })
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    try {
      await init(msg.whisperCacheDir)
    } catch (err) {
      parentPort.postMessage({ type: 'error', error: `Whisper init failed: ${err.message}` })
    }
    return
  }

  if (msg.type === 'transcribe') {
    if (!asr) {
      parentPort.postMessage({ type: 'error', error: 'Model not loaded yet', id: msg.id })
      return
    }
    queue.push(msg)
    processQueue()
  }
})
