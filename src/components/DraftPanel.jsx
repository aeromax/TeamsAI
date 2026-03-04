import { useState } from 'react'
import { streamGenerate } from '../lib/ollama'

const DRAFT_PROMPT = (context, transcript) => `You are a professional communications assistant. Draft 3 concise, professional Microsoft Teams message replies.

${transcript ? `Meeting context:\n${transcript.slice(0, 1000)}\n\n` : ''}Message/thread to reply to:
${context}

Write exactly 3 numbered reply options. Each should be 1-3 sentences, professional, and ready to send.

DRAFT REPLIES:`

export default function DraftPanel({ meetingId, transcript }) {
  const [context, setContext] = useState('')
  const [drafts, setDrafts] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(null)

  async function handleDraft() {
    if (!context.trim()) {
      setError('Paste the message or thread you want to reply to.')
      return
    }
    setError(null)
    setGenerating(true)
    setDrafts('')

    try {
      let fullText = ''
      for await (const token of streamGenerate({
        prompt: DRAFT_PROMPT(context, transcript),
        model: 'llama3.2:3b',
      })) {
        fullText += token
        setDrafts(fullText)
      }

      // Save to DB
      if (meetingId) {
        await window.electronAPI.db.insertDraft(meetingId, context, fullText)
      }
    } catch (err) {
      setError(`Failed to generate draft: ${err.message}`)
    } finally {
      setGenerating(false)
    }
  }

  function handleCopy(text) {
    navigator.clipboard.writeText(text)
    setCopied(text)
    setTimeout(() => setCopied(null), 2000)
  }

  // Parse the 3 numbered drafts for easy copy
  function parseDrafts(raw) {
    const lines = raw.split('\n')
    const drafts = []
    let current = null

    for (const line of lines) {
      const match = line.match(/^(\d+)\.\s+(.*)$/)
      if (match) {
        if (current) drafts.push(current)
        current = match[2]
      } else if (current && line.trim()) {
        current += ' ' + line.trim()
      }
    }
    if (current) drafts.push(current)
    return drafts.length >= 2 ? drafts : null
  }

  const parsedDrafts = drafts ? parseDrafts(drafts) : null

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white flex-1">Draft Reply</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        {error && (
          <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-xs">
            {error}
          </div>
        )}

        {/* Context input */}
        <div className="flex flex-col gap-2">
          <label className="text-xs text-gray-400 font-medium">
            Paste the Teams message or email thread to reply to:
          </label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="e.g. 'Can you send me the Q4 report and set up a sync this week?'"
            rows={4}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 resize-none outline-none focus:border-teams-purple transition-colors placeholder-gray-600"
          />
          <button
            onClick={handleDraft}
            disabled={generating || !context.trim()}
            className="self-start px-4 py-1.5 rounded-lg bg-teams-purple hover:bg-teams-purple-dark disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {generating ? (
              <span className="flex items-center gap-1.5">
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Drafting…
              </span>
            ) : (
              'Draft Reply'
            )}
          </button>
        </div>

        {/* Drafts output */}
        {drafts && (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs text-gray-400 font-medium uppercase tracking-wide">Draft Replies</h3>

            {parsedDrafts ? (
              parsedDrafts.map((draft, i) => (
                <div
                  key={i}
                  className="bg-gray-900 border border-gray-700 rounded-lg p-4 flex flex-col gap-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs text-gray-500 font-medium">Option {i + 1}</span>
                    <button
                      onClick={() => handleCopy(draft)}
                      className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors flex-shrink-0"
                    >
                      {copied === draft ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-sm text-gray-200 leading-relaxed">{draft}</p>
                </div>
              ))
            ) : (
              <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 relative">
                <button
                  onClick={() => handleCopy(drafts)}
                  className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                >
                  {copied === drafts ? '✓ Copied' : 'Copy'}
                </button>
                <pre className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{drafts}</pre>
              </div>
            )}
          </div>
        )}

        {!drafts && !generating && (
          <div className="flex flex-col items-center justify-center flex-1 text-center gap-3">
            <div className="text-4xl opacity-30">✉️</div>
            <p className="text-gray-500 text-sm">
              Paste a Teams message above and click Draft Reply to get 3 AI-generated options.
            </p>
            {transcript && (
              <p className="text-xs text-gray-600">
                Meeting context will be used to make replies more relevant.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
