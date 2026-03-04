const BASE_URL = 'http://127.0.0.1:11434'

/**
 * Check if Ollama is reachable and ready.
 * @returns {Promise<boolean>}
 */
export async function healthCheck() {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * List available local models.
 * @returns {Promise<string[]>} model names
 */
export async function listModels() {
  const res = await fetch(`${BASE_URL}/api/tags`)
  if (!res.ok) throw new Error(`Ollama list models failed: ${res.status}`)
  const data = await res.json()
  return (data.models || []).map((m) => m.name)
}

/**
 * Stream tokens from Ollama generate API.
 * Yields one string token at a time.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {AbortSignal} [options.signal]
 * @yields {string}
 */
export async function* streamGenerate({ prompt, model = 'llama3.2:3b', signal }) {
  const res = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: true,
      options: {
        temperature: 0.7,
        num_predict: 1024,
      },
    }),
    signal,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Ollama generate failed (${res.status}): ${text}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = decoder.decode(value, { stream: true })
    const lines = chunk.split('\n').filter(Boolean)

    for (const line of lines) {
      try {
        const json = JSON.parse(line)
        if (json.response) yield json.response
        if (json.done) return
      } catch {
        // Ignore partial JSON lines
      }
    }
  }
}

/**
 * Non-streaming generate — returns complete response string.
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @returns {Promise<string>}
 */
export async function generate({ prompt, model = 'llama3.2:3b' }) {
  const res = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  })

  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status}`)
  const data = await res.json()
  return data.response
}
