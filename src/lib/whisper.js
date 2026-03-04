import { pipeline, env } from '@xenova/transformers'

const MODEL_ID = 'Xenova/whisper-small.en'
// model:// is a custom Electron protocol that serves files from the local whisper cache dir.
// This avoids all browser fetch restrictions in the renderer context.
const MODEL_BASE_URL = 'model://whisper/'

let pipelineInstance = null

/**
 * Get (or initialize) the Whisper ASR pipeline.
 * Reads model files via the local model:// protocol — no network access required.
 * @returns {Promise<pipeline>}
 */
export async function getWhisperPipeline() {
  if (pipelineInstance) return pipelineInstance

  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = MODEL_BASE_URL

  pipelineInstance = await pipeline('automatic-speech-recognition', MODEL_ID, {
    quantized: true,
  })

  return pipelineInstance
}

/**
 * Transcribe a Float32Array of 16kHz PCM audio.
 * @param {Float32Array} audio
 * @returns {Promise<string>}
 */
export async function transcribe(audio) {
  const pipe = await getWhisperPipeline()
  const result = await pipe(audio, {
    language: 'english',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  })
  return result.text?.trim() ?? ''
}
