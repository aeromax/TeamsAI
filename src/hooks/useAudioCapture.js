import { useState, useRef, useEffect } from 'react'

const CHUNK_DURATION_MS = 5000 // 5-second chunks
const WHISPER_RATE = 16000     // Whisper requires 16 kHz

// Pure-JS linear-interpolation resampler — no OfflineAudioContext needed.
function resampleTo16k(buffer, fromRate) {
  if (fromRate === WHISPER_RATE) return buffer
  const ratio = fromRate / WHISPER_RATE
  const outLen = Math.floor(buffer.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const lo = Math.floor(pos)
    const hi = Math.min(lo + 1, buffer.length - 1)
    const frac = pos - lo
    out[i] = buffer[lo] * (1 - frac) + buffer[hi] * frac
  }
  return out
}

/**
 * useAudioCapture
 *
 * Dual-capture: mixes the BlackHole loopback stream (Teams call audio from
 * other participants) with the user's real microphone (their own voice) before
 * sending to Whisper, so both sides of the conversation are transcribed.
 *
 * Props:
 *   onChunk(text)   — called with each transcribed text chunk
 *   micDeviceId     — deviceId for the user's microphone (non-BlackHole input)
 */
export default function useAudioCapture({ onChunk, micDeviceId }) {
  const [audioDevices, setAudioDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState('')
  const [workerStatus, setWorkerStatus] = useState('loading') // loading | ready | error
  const [workerError, setWorkerError] = useState(null)

  const contextRef = useRef(null)
  const streamRef = useRef(null)      // BlackHole stream
  const micStreamRef = useRef(null)   // Microphone stream
  const processorRef = useRef(null)
  const bufferRef = useRef([])
  const chunkTimerRef = useRef(null)
  const isPausedRef = useRef(false)
  const isFlushingRef = useRef(false)
  const nativeSampleRateRef = useRef(44100)

  // Track Whisper thread readiness from main process
  useEffect(() => {
    window.electronAPI.getWhisperStatus().then(({ ready }) => {
      if (ready) setWorkerStatus('ready')
    })
    const remove = window.electronAPI.onWhisperStatus(({ ready, error }) => {
      if (ready) {
        setWorkerStatus('ready')
        setWorkerError(null)
      } else {
        setWorkerStatus('error')
        setWorkerError(error ?? 'Unknown error')
      }
    })
    return remove
  }, [])

  // Enumerate audio input devices
  useEffect(() => {
    async function getDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true })
        const devices = await navigator.mediaDevices.enumerateDevices()
        const inputs = devices.filter((d) => d.kind === 'audioinput')
        setAudioDevices(inputs)
        const blackhole = inputs.find((d) => d.label.toLowerCase().includes('blackhole'))
        setSelectedDevice(blackhole ? blackhole.deviceId : inputs[0]?.deviceId ?? '')
      } catch (err) {
        console.error('[audio] device enumeration failed:', err)
      }
    }
    getDevices()
  }, [])

  async function flushBuffer() {
    if (isPausedRef.current) return
    if (isFlushingRef.current) return
    const buf = bufferRef.current
    bufferRef.current = []
    if (buf.length === 0) return

    isFlushingRef.current = true
    const total = buf.reduce((acc, b) => acc + b.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const b of buf) { merged.set(b, offset); offset += b.length }

    // Skip true silence — all-zero audio wastes an inference pass and can
    // trigger assertion failures in some ONNX Runtime builds.
    let sumSq = 0
    for (let i = 0; i < merged.length; i++) sumSq += merged[i] * merged[i]
    const rms = Math.sqrt(sumSq / merged.length)
    if (rms < 0.0001) {
      console.log('[audio] chunk silent (rms', rms.toFixed(6), '), skipping')
      isFlushingRef.current = false
      return
    }

    try {
      const resampled = resampleTo16k(merged, nativeSampleRateRef.current)
      console.log('[audio] sending', resampled.length, 'samples to Whisper (rms', rms.toFixed(4), ')')
      const result = await window.electronAPI.transcribe(resampled.buffer)
      if (result.success && result.text) onChunk(result.text)
    } catch (err) {
      console.error('[transcribe]', err)
    } finally {
      isFlushingRef.current = false
    }
  }

  async function start() {
    try {
      isPausedRef.current = false

      // ── BlackHole stream (Teams call audio — other participants) ──────────
      console.log('[audio] step 1: opening BlackHole stream...')
      const bhStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDevice ? { exact: selectedDevice } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      streamRef.current = bhStream
      console.log('[audio] step 2: BlackHole stream acquired')

      // ── AudioContext ──────────────────────────────────────────────────────
      const ctx = new AudioContext()
      contextRef.current = ctx
      nativeSampleRateRef.current = ctx.sampleRate
      console.log('[audio] step 3: AudioContext, sampleRate:', ctx.sampleRate)

      if (ctx.setSinkId) {
        await ctx.setSinkId({ type: 'none' })
        console.log('[audio] step 4: sink → none')
      } else {
        console.log('[audio] step 4: setSinkId not available')
      }

      // ── PCM worklet ───────────────────────────────────────────────────────
      const workletCode = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = []; this._len = 0 }
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (ch) {
      this._buf.push(ch.slice())
      this._len += ch.length
      if (this._len >= 4096) {
        const out = new Float32Array(this._len)
        let off = 0
        for (const b of this._buf) { out.set(b, off); off += b.length }
        this.port.postMessage(out, [out.buffer])
        this._buf = []
        this._len = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-processor', PCMProcessor)`

      console.log('[audio] step 5: loading worklet...')
      const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }))
      await ctx.audioWorklet.addModule(blobUrl)
      URL.revokeObjectURL(blobUrl)
      console.log('[audio] step 6: worklet loaded')

      const workletNode = new AudioWorkletNode(ctx, 'pcm-processor')
      workletNode.port.onmessage = (e) => {
        if (isPausedRef.current) return
        bufferRef.current.push(new Float32Array(e.data))
      }

      // Connect BlackHole source → worklet
      const bhSource = ctx.createMediaStreamSource(bhStream)
      bhSource.connect(workletNode)

      // ── Microphone stream (user's own voice) ──────────────────────────────
      if (micDeviceId) {
        try {
          console.log('[audio] step 6b: opening mic stream, device:', micDeviceId)
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: micDeviceId },
              echoCancellation: true,   // reduce echo from speakers
              noiseSuppression: true,
              autoGainControl: true,
            },
          })
          micStreamRef.current = micStream
          // Connect mic → same worklet: Web Audio sums the two inputs together
          const micSource = ctx.createMediaStreamSource(micStream)
          micSource.connect(workletNode)
          console.log('[audio] step 6b: mic stream mixed in')
        } catch (err) {
          // Non-fatal — transcription still works without the user's own voice
          console.warn('[audio] mic stream failed (continuing without):', err.message)
        }
      }

      // Software sink to keep the graph active
      const silentOut = ctx.createMediaStreamDestination()
      workletNode.connect(silentOut)
      processorRef.current = workletNode
      console.log('[audio] step 7: graph connected', micDeviceId ? '(dual-capture)' : '(BlackHole only)')

      chunkTimerRef.current = setInterval(flushBuffer, CHUNK_DURATION_MS)
      console.log('[audio] capture started')
    } catch (err) {
      console.error('[audio] start failed:', err)
      throw err
    }
  }

  function stop() {
    clearInterval(chunkTimerRef.current)
    // Do NOT reset isFlushingRef here — resetting it mid-flush allows a second
    // concurrent ONNX inference call which can SIGTRAP.
    flushBuffer()

    processorRef.current?.port?.close()
    processorRef.current?.disconnect()
    processorRef.current = null

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null

    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null

    contextRef.current?.close()
    contextRef.current = null

    console.log('[audio] capture stopped')
  }

  function pause() {
    isPausedRef.current = true
    clearInterval(chunkTimerRef.current)
  }

  async function resume() {
    isPausedRef.current = false
    chunkTimerRef.current = setInterval(flushBuffer, CHUNK_DURATION_MS)
  }

  useEffect(() => () => stop(), [])

  return {
    start,
    stop,
    pause,
    resume,
    audioDevices,
    selectedDevice,
    setSelectedDevice,
    workerStatus,
    workerError,
  }
}
