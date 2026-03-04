import { useState, useRef, useCallback } from 'react'
import { streamGenerate } from '../lib/ollama'

/**
 * useOllama
 * Hook for streaming Ollama generation with loading and abort support.
 */
export default function useOllama() {
  const [output, setOutput] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  const generate = useCallback(async ({ prompt, model = 'llama3.2:3b', onToken }) => {
    setGenerating(true)
    setError(null)
    setOutput('')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      let full = ''
      for await (const token of streamGenerate({ prompt, model, signal: controller.signal })) {
        full += token
        setOutput(full)
        onToken?.(token)
      }
      return full
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message)
      }
      return null
    } finally {
      setGenerating(false)
      abortRef.current = null
    }
  }, [])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    setOutput('')
    setError(null)
  }, [])

  return { output, generating, error, generate, abort, reset }
}
