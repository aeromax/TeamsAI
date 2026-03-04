/**
 * Whisper Web Worker
 * Runs transcription off the main thread so the UI stays responsive.
 *
 * Message flow:
 *   Receive: { type: 'init', localModelPath: 'model://whisper/' }
 *   Receive: { type: 'transcribe', audio: Float32Array }
 *   Post:    { type: 'ready' }
 *            { type: 'result', text: string }
 *            { type: 'error', error: string }
 */

import { pipeline, env } from '@xenova/transformers'

const MODEL_ID = 'Xenova/whisper-small.en'

// These are set when the 'init' message arrives
env.allowLocalModels = true
env.allowRemoteModels = false

let asr = null
let loading = false
let initialized = false
const queue = []

async function ensurePipeline() {
  if (asr) return asr
  if (loading) {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (asr) { clearInterval(check); resolve() }
      }, 100)
    })
    return asr
  }

  loading = true
  try {
    asr = await pipeline('automatic-speech-recognition', MODEL_ID, {
      quantized: true,
    })
    self.postMessage({ type: 'ready' })
  } catch (err) {
    self.postMessage({ type: 'error', error: `Failed to load Whisper: ${err.message}` })
  } finally {
    loading = false
  }

  return asr
}

async function processQueue() {
  while (queue.length > 0) {
    const { audio } = queue.shift()
    try {
      const pipe = await ensurePipeline()
      if (!pipe) continue

      const result = await pipe(audio, {
        language: 'english',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      })

      const text = result.text?.trim()
      if (text) self.postMessage({ type: 'result', text })
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message })
    }
  }
}

self.onmessage = async (e) => {
  const { type, audio, localModelPath } = e.data

  if (type === 'init') {
    env.localModelPath = localModelPath
    initialized = true
    await ensurePipeline()
    return
  }

  if (type === 'transcribe' && audio) {
    if (!initialized) {
      self.postMessage({ type: 'error', error: 'Worker not initialized — send init first' })
      return
    }
    queue.push({ audio })
    processQueue()
  }
}
