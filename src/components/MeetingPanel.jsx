import { useState, useEffect, useRef, useCallback } from 'react'
import useAudioCapture from '../hooks/useAudioCapture'

const STATUS = {
  idle: { label: 'Ready', color: 'text-gray-500', dot: 'bg-gray-600' },
  recording: { label: 'Recording', color: 'text-red-400', dot: 'bg-red-500 animate-pulse' },
  paused: { label: 'Paused', color: 'text-yellow-400', dot: 'bg-yellow-500' },
}

export default function MeetingPanel({
  activeMeetingId,
  setActiveMeetingId,
  transcript,
  setTranscript,
  onGoToNotes,
}) {
  const [status, setStatus] = useState('idle')
  const [startError, setStartError] = useState(null)
  const [audioWarning, setAudioWarning] = useState(null)
  const [meetingTitle, setMeetingTitle] = useState('Untitled Meeting')
  const [editingTitle, setEditingTitle] = useState(false)
  const [seqRef] = useState({ current: 0 })
  const [startTime, setStartTime] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  // Audio output devices for "Listen through" selector
  const [outputDevices, setOutputDevices] = useState([])
  const [preferredOutput, setPreferredOutput] = useState('')
  // Microphone device for capturing the user's own voice
  const [micDevice, setMicDevice] = useState('')
  const timerRef = useRef(null)
  const transcriptEndRef = useRef(null)
  const hasTeamsAIOutput = outputDevices.some((name) => name.toLowerCase().includes('teams ai output'))

  const meetingIdRef = useRef(activeMeetingId)
  meetingIdRef.current = activeMeetingId

  // Load available audio output devices for the "Listen through" selector
  useEffect(() => {
    window.electronAPI.listAudioOutputs().then((names) => {
      setOutputDevices(names)
      // Default to the first device that looks like AirPods/Bluetooth, else first
      const bt = names.find((n) => /airpods|beats|bose|sony|headphone/i.test(n))
      setPreferredOutput(bt || names[0] || '')
    })
  }, [])

  const onChunk = useCallback(
    async (text) => {
      if (!text.trim()) return
      const ts = new Date().toISOString()
      const seq = seqRef.current++
      setTranscript((prev) => prev + (prev ? ' ' : '') + text.trim())

      if (meetingIdRef.current) {
        await window.electronAPI.db.insertTranscript(meetingIdRef.current, seq, text.trim(), ts)
      }
    },
    [setTranscript]
  )

  const { start, stop, pause, resume, audioDevices, selectedDevice, setSelectedDevice, workerStatus, workerError } =
    useAudioCapture({ onChunk, micDeviceId: micDevice })

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  // Timer
  useEffect(() => {
    if (status === 'recording') {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000))
      }, 1000)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [status, startTime])

  // Auto-pick a mic: prefer whatever non-BlackHole input is available
  useEffect(() => {
    if (audioDevices.length === 0) return
    const nonBH = audioDevices.find((d) => !d.label.toLowerCase().includes('blackhole'))
    if (nonBH && !micDevice) setMicDevice(nonBH.deviceId)
  }, [audioDevices])

  async function handleStart() {
    setStartError(null)
    setAudioWarning(null)
    try {
      // Rebuild the Multi-Output Device to route audio through the user's preferred
      // output device (e.g. AirPods in A2DP mode) AND BlackHole simultaneously.
      // If the preferred device is a Bluetooth headset in HFP call mode, the aggregate
      // creation will fail (sample rate mismatch: HFP is 16 kHz, BlackHole is 48 kHz).
      // In that case fall back to the current system default so BlackHole still captures.
      if (preferredOutput) {
        const audioResult = await window.electronAPI.ensureAudioWith(preferredOutput)
        if (!audioResult.success) {
          console.warn('[audio] ensure-audio-with failed:', audioResult.error)
          setAudioWarning(
            `"${preferredOutput}" is unavailable (likely in call mode). ` +
            `Audio is routing through your system default instead. ` +
            `To use AirPods: set Teams Microphone to MacBook Pro Microphone, not AirPods.`
          )
          // Fall back so BlackHole is at least in the audio path
          await window.electronAPI.ensureAudio()
        }
      } else {
        await window.electronAPI.ensureAudio()
      }

      const now = new Date().toISOString()
      const id = await window.electronAPI.db.insertMeeting(meetingTitle, now)
      setActiveMeetingId(id)
      meetingIdRef.current = id
      setTranscript('')
      seqRef.current = 0
      setStartTime(Date.now())
      setElapsed(0)
      setStatus('recording')
      await start()
    } catch (err) {
      setStatus('idle')
      setStartError(err.message || String(err))
    }
  }

  async function handleStop() {
    stop()
    setStatus('idle')
    clearInterval(timerRef.current)

    if (meetingIdRef.current) {
      const now = new Date().toISOString()
      await window.electronAPI.db.endMeeting(meetingIdRef.current, now, elapsed)
    }
  }

  async function handlePause() {
    pause()
    setStatus('paused')
  }

  async function handleResume() {
    await resume()
    setStatus('recording')
  }

  async function handleRename(newTitle) {
    setMeetingTitle(newTitle)
    setEditingTitle(false)
    if (meetingIdRef.current) {
      await window.electronAPI.db.renameMeeting(meetingIdRef.current, newTitle)
    }
  }

  function formatTime(secs) {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = secs % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const st = STATUS[status]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${st.dot}`} />
        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              autoFocus
              defaultValue={meetingTitle}
              className="bg-transparent text-white font-semibold text-sm w-full outline-none border-b border-teams-purple"
              onBlur={(e) => handleRename(e.target.value || 'Untitled Meeting')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(e.target.value || 'Untitled Meeting')
                if (e.key === 'Escape') setEditingTitle(false)
              }}
            />
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              className="text-sm font-semibold text-white hover:text-gray-300 truncate block text-left"
            >
              {meetingTitle}
            </button>
          )}
          <span className={`text-xs ${st.color}`}>
            {st.label}
            {status !== 'idle' && ` · ${formatTime(elapsed)}`}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {status === 'idle' && (
            <button
              onClick={handleStart}
              className="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors"
            >
              Start
            </button>
          )}
          {status === 'recording' && (
            <>
              <button
                onClick={handlePause}
                className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm transition-colors"
              >
                Pause
              </button>
              <button
                onClick={handleStop}
                className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm transition-colors"
              >
                Stop
              </button>
            </>
          )}
          {status === 'paused' && (
            <>
              <button
                onClick={handleResume}
                className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm transition-colors"
              >
                Resume
              </button>
              <button
                onClick={handleStop}
                className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm transition-colors"
              >
                Stop
              </button>
            </>
          )}
          {transcript && status === 'idle' && (
            <button
              onClick={onGoToNotes}
              className="px-3 py-1.5 rounded-lg bg-teams-purple hover:bg-teams-purple-dark text-white text-sm transition-colors"
            >
              Summarize →
            </button>
          )}
        </div>
      </div>

      {/* Device selectors */}
      {status === 'idle' && (
        <div className="px-6 py-3 border-b border-gray-800 space-y-2">
          {/* Listen through — which real speaker/headphones to use */}
          {outputDevices.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-24 flex-shrink-0">Listen through:</span>
              <select
                value={preferredOutput}
                onChange={(e) => setPreferredOutput(e.target.value)}
                className="text-xs bg-gray-800 text-gray-300 rounded px-2 py-1 border border-gray-700 outline-none flex-1 min-w-0"
              >
                {outputDevices.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Capture — should be BlackHole */}
          {audioDevices.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-24 flex-shrink-0">Capture from:</span>
              <select
                value={selectedDevice}
                onChange={(e) => setSelectedDevice(e.target.value)}
                className="text-xs bg-gray-800 text-gray-300 rounded px-2 py-1 border border-gray-700 outline-none flex-1 min-w-0"
              >
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
                ))}
              </select>
            </div>
          )}

          {/* Microphone — user's own voice */}
          {audioDevices.filter((d) => !d.label.toLowerCase().includes('blackhole')).length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-24 flex-shrink-0">Your mic:</span>
              <select
                value={micDevice}
                onChange={(e) => setMicDevice(e.target.value)}
                className="text-xs bg-gray-800 text-gray-300 rounded px-2 py-1 border border-gray-700 outline-none flex-1 min-w-0"
              >
                {audioDevices
                  .filter((d) => !d.label.toLowerCase().includes('blackhole'))
                  .map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
                  ))}
              </select>
            </div>
          )}

          {/* Warn if BlackHole isn't selected as the capture device */}
          {audioDevices.length > 0 &&
            !audioDevices.find((d) => d.deviceId === selectedDevice)?.label?.toLowerCase().includes('blackhole') && (
            <p className="text-xs text-yellow-600">
              Set <strong className="text-yellow-500">Capture from</strong> to BlackHole 2ch to capture Teams audio.
            </p>
          )}

          <p className="text-xs text-gray-600 leading-relaxed">
            In Teams <span className="text-gray-500">→ Settings → Devices</span>, set{' '}
            <strong className="text-gray-400">Speaker</strong> to{' '}
            <strong className="text-gray-400">{hasTeamsAIOutput ? 'Teams AI Output' : 'BlackHole 2ch'}</strong>.
            {' '}If using AirPods, also set{' '}
            <strong className="text-gray-400">Microphone</strong> to{' '}
            <strong className="text-gray-400">MacBook Pro Microphone</strong>{' '}
            so AirPods stay in audio-only (A2DP) mode.
          </p>
        </div>
      )}

      {/* Audio routing warning (shown during recording if preferred output was unavailable) */}
      {audioWarning && status !== 'idle' && (
        <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-800/50">
          <p className="text-xs text-yellow-400">{audioWarning}</p>
        </div>
      )}

      {/* Transcript area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {!transcript && status === 'idle' && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3">
            <div className="text-4xl opacity-30">🎙️</div>
            {startError ? (
              <div className="px-4 py-3 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-xs max-w-sm text-left">
                <p className="font-semibold mb-1">Could not start audio capture:</p>
                <p>{startError}</p>
              </div>
            ) : (
              <>
                <p className="text-gray-500 text-sm">
                  Press <strong className="text-gray-400">Start</strong> to begin capturing your Teams meeting.
                </p>
                <p className="text-xs text-gray-600">
                  Make sure Teams audio is playing through your speakers — BlackHole will capture it automatically.
                </p>
              </>
            )}
          </div>
        )}
        {transcript && (
          <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap font-mono">
            {transcript}
            <span ref={transcriptEndRef} />
          </div>
        )}
        {status === 'recording' && !transcript && (
          <div className="mt-4 flex flex-col gap-2">
            {workerStatus === 'error' ? (
              <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-xs">
                Transcription model failed to load: {workerError}
              </div>
            ) : workerStatus === 'loading' ? (
              <div className="flex items-center gap-2 text-yellow-500 text-sm">
                <svg className="animate-spin w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Loading transcription model — speech will appear once ready…
              </div>
            ) : (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <svg className="animate-spin w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Listening for speech…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
