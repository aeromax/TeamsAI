import { useState } from 'react'

const STEPS = [
  { id: 'blackhole', label: 'Installing audio driver', detail: 'BlackHole 2ch virtual audio device' },
  { id: 'audio', label: 'Configuring audio routing', detail: 'Creating Multi-Output Device in CoreAudio' },
  { id: 'ollama', label: 'Downloading AI model', detail: 'llama3.2:3b (~2 GB) — one-time download' },
  { id: 'whisper', label: 'Downloading transcription model', detail: 'Whisper small.en (~240 MB)' },
]

function ProgressBar({ pct }) {
  return (
    <div className="w-full bg-gray-800 rounded-full h-1.5 mt-2">
      <div
        className="bg-teams-purple h-1.5 rounded-full transition-all duration-300"
        style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
      />
    </div>
  )
}

function StepRow({ step, status, pct, error }) {
  const icon = {
    pending: <span className="text-gray-600">○</span>,
    running: (
      <svg className="animate-spin w-4 h-4 text-teams-purple" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
    ),
    waiting: <span className="text-yellow-400">◐</span>,
    done: <span className="text-green-400">✓</span>,
    error: <span className="text-red-400">✗</span>,
  }[status] ?? <span className="text-gray-600">○</span>

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="w-4 flex-shrink-0 flex items-center justify-center">{icon}</div>
        <div>
          <p className={`text-sm font-medium ${status === 'pending' ? 'text-gray-500' : 'text-gray-100'}`}>
            {step.label}
          </p>
          <p className="text-xs text-gray-600">{step.detail}</p>
        </div>
      </div>
      {status === 'running' && pct !== null && <ProgressBar pct={pct} />}
      {status === 'error' && error && (
        <p className="ml-7 text-xs text-red-400 leading-relaxed">{error}</p>
      )}
    </div>
  )
}

// ── Interstitial shown when BlackHole needs Privacy approval ──────────────────
function BlackHoleApprovalPrompt({ onRetry, onOpenSettings }) {
  const [checking, setChecking] = useState(false)

  async function handleRetry() {
    setChecking(true)
    await onRetry()
    setChecking(false)
  }

  return (
    <div className="bg-yellow-950/40 border border-yellow-700/50 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex gap-3">
        <span className="text-2xl flex-shrink-0">🔒</span>
        <div>
          <p className="text-sm font-semibold text-yellow-300 mb-1">
            One more step — approve the audio driver
          </p>
          <p className="text-xs text-gray-400 leading-relaxed">
            macOS requires a <strong className="text-gray-200">restart</strong> before it shows the approval
            prompt for the BlackHole audio driver. Follow these steps in order:
          </p>
        </div>
      </div>

      <ol className="text-xs text-gray-300 space-y-3 ml-2 list-none">
        <li className="flex gap-3">
          <span className="w-5 h-5 rounded-full bg-yellow-700 text-yellow-200 text-xs flex items-center justify-center flex-shrink-0 font-bold">1</span>
          <span><strong>Restart your Mac now.</strong> This is required — macOS won't show the Allow button until after a reboot.</span>
        </li>
        <li className="flex gap-3">
          <span className="w-5 h-5 rounded-full bg-yellow-700 text-yellow-200 text-xs flex items-center justify-center flex-shrink-0 font-bold">2</span>
          <span>After restart, open <strong>System Settings → Privacy &amp; Security</strong> and scroll to the very bottom.</span>
        </li>
        <li className="flex gap-3">
          <span className="w-5 h-5 rounded-full bg-yellow-700 text-yellow-200 text-xs flex items-center justify-center flex-shrink-0 font-bold">3</span>
          <span>You'll see <em>"System software from Existential Audio Inc. was blocked."</em> Click <strong>Allow</strong> and enter your password.</span>
        </li>
        <li className="flex gap-3">
          <span className="w-5 h-5 rounded-full bg-yellow-700 text-yellow-200 text-xs flex items-center justify-center flex-shrink-0 font-bold">4</span>
          <span>Reopen Teams AI, and click <strong>"I've approved it — Continue"</strong> below to finish setup.</span>
        </li>
      </ol>

      <div className="ml-2 mt-1">
        <button
          onClick={onOpenSettings}
          className="w-full py-2 rounded-lg bg-yellow-600 hover:bg-yellow-500 text-white text-sm font-medium transition-colors mb-2"
        >
          Open Privacy &amp; Security (after restart) →
        </button>
        <button
          onClick={handleRetry}
          disabled={checking}
          className="w-full py-2 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {checking ? 'Checking…' : "I've approved it — Continue"}
        </button>
      </div>
    </div>
  )
}

// ── Main wizard ───────────────────────────────────────────────────────────────
export default function SetupWizard({ onComplete }) {
  const [statuses, setStatuses] = useState(Object.fromEntries(STEPS.map((s) => [s.id, 'pending'])))
  const [pcts, setPcts] = useState({})
  const [errors, setErrors] = useState({})
  const [started, setStarted] = useState(false)
  const [allDone, setAllDone] = useState(false)
  // When true, show the BlackHole approval interstitial instead of the step list
  const [needsApproval, setNeedsApproval] = useState(false)

  function setStatus(id, status) {
    setStatuses((prev) => ({ ...prev, [id]: status }))
  }
  function setPct(id, pct) {
    setPcts((prev) => ({ ...prev, [id]: pct }))
  }
  function setError(id, msg) {
    setErrors((prev) => ({ ...prev, [id]: msg }))
  }

  function isBlackHoleMissingError(errorText) {
    const msg = String(errorText || '').toLowerCase()
    return msg.includes('blackhole') && msg.includes('not found')
  }

  function isSetupAudioBinaryMissingError(errorText) {
    const msg = String(errorText || '').toLowerCase()
    return msg.includes('setup-audio binary not found')
  }

  async function runFromAudioStep() {
    setNeedsApproval(false)
    setStatus('audio', 'running')

    const audioResult = await window.electronAPI.configureAudio()
    if (!audioResult.success) {
      if (isSetupAudioBinaryMissingError(audioResult.error)) {
        setStatus('audio', 'done')
        return true
      }
      // If driver is still missing, show approval prompt again
      if (isBlackHoleMissingError(audioResult.error)) {
        setStatus('audio', 'waiting')
        setNeedsApproval(true)
        return false
      }
      setStatus('audio', 'error')
      setError('audio', audioResult.error)
      return false
    }

    setStatus('audio', 'done')
    return true
  }

  function handleStartOrRetry() {
    setStatuses(Object.fromEntries(STEPS.map((s) => [s.id, 'pending'])))
    setPcts({})
    setErrors({})
    setStarted(false)
    setAllDone(false)
    setNeedsApproval(false)
    // Use setTimeout so state resets flush before runSetup reads them
    setTimeout(runSetup, 0)
  }

  async function runSetup() {
    setStarted(true)

    // ── Step 0: Install BlackHole ─────────────────────────────────────────────
    setStatus('blackhole', 'running')
    const blackHoleCheck = await window.electronAPI.checkBlackHole()
    if (!blackHoleCheck.found) {
      const bhResult = await window.electronAPI.installBlackHole()
      if (!bhResult.success) {
        setStatus('blackhole', 'error')
        setError('blackhole', bhResult.error)
        return
      }
    }
    setStatus('blackhole', 'done')

    // ── Step 1: Configure audio routing ──────────────────────────────────────
    setStatus('audio', 'running')
    const audioResult = await window.electronAPI.configureAudio()
    if (!audioResult.success) {
      if (isSetupAudioBinaryMissingError(audioResult.error)) {
        setStatus('audio', 'done')
        await runModelsSetup()
        return
      }
      if (isBlackHoleMissingError(audioResult.error)) {
        setStatus('audio', 'waiting')
        setNeedsApproval(true)
        return
      }
      setStatus('audio', 'error')
      setError('audio', audioResult.error)
      return
    }
    setStatus('audio', 'done')

    await runModelsSetup()
  }

  async function handleApprovalRetry() {
    const ok = await runFromAudioStep()
    if (ok) await runModelsSetup()
  }

  async function runModelsSetup() {
    setNeedsApproval(false)

    // ── Step 2: Ollama model pull ─────────────────────────────────────────────
    setStatus('ollama', 'running')
    const removePullListener = window.electronAPI.onPullProgress(({ model, line, pct }) => {
      if (model === 'llama3.2:3b') setPct('ollama', pct)
    })
    const ollamaResult = await window.electronAPI.pullModel('llama3.2:3b')
    removePullListener()
    if (!ollamaResult.success) {
      setStatus('ollama', 'error')
      setError('ollama', ollamaResult.error)
      return
    }
    setStatus('ollama', 'done')

    // ── Step 3: Whisper model ─────────────────────────────────────────────────
    setStatus('whisper', 'running')
    try {
      const removeListener = window.electronAPI.onWhisperProgress(({ filename, overallPct, pct, fileIndex, totalFiles }) => {
        // Show per-file progress; fall back to file-count-based estimate
        const overall = overallPct ?? Math.round(((fileIndex + (pct ?? 0) / 100) / totalFiles) * 100)
        setPct('whisper', overall)
      })
      const result = await window.electronAPI.downloadWhisper()
      removeListener()
      if (!result.success) {
        setStatus('whisper', 'error')
        setError('whisper', result.error)
        return
      }
      setStatus('whisper', 'done')
    } catch (err) {
      setStatus('whisper', 'error')
      setError('whisper', err.message)
      return
    }

    setAllDone(true)
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-950 px-8">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="text-4xl mb-3">🎙️</div>
          <h1 className="text-2xl font-bold text-white mb-1">Teams AI Setup</h1>
          <p className="text-sm text-gray-400">
            Setting up your local, private AI assistant for Microsoft Teams.
            <br />
            <span className="text-gray-600">All AI processing stays on your Mac — nothing leaves this device.</span>
          </p>
        </div>

        {/* Approval interstitial — replaces steps while waiting */}
        {needsApproval ? (
          <BlackHoleApprovalPrompt
            onOpenSettings={() => window.electronAPI.openPrivacySettings()}
            onRetry={handleApprovalRetry}
          />
        ) : (
          <>
            {/* Steps */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 flex flex-col gap-5 mb-6">
              {STEPS.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  status={statuses[step.id]}
                  pct={pcts[step.id] ?? null}
                  error={errors[step.id] ?? null}
                />
              ))}
            </div>

            {!started && (
              <p className="text-xs text-gray-600 text-center mb-4">
                macOS will ask for your admin password once to install the audio driver.
                This is required by Apple for system audio extensions.
              </p>
            )}

            {!allDone ? (
              <button
                onClick={handleStartOrRetry}
                disabled={started && !Object.values(statuses).includes('error')}
                className="w-full py-3 rounded-lg bg-teams-purple hover:bg-teams-purple-dark disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-colors"
              >
                {Object.values(statuses).includes('error')
                  ? 'Retry Setup'
                  : started
                  ? 'Setting up…'
                  : 'Set Up Teams AI'}
              </button>
            ) : (
              <button
                onClick={onComplete}
                className="w-full py-3 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold transition-colors"
              >
                Start Your First Meeting →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
