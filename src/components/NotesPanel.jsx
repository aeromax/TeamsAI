import { useState, useEffect } from 'react'
import { streamGenerate } from '../lib/ollama'

const SUMMARY_PROMPT = (transcript) => `You are a meeting assistant. Given the following meeting transcript, produce:

1) A 3-5 sentence summary of the meeting
2) Bullet-point action items with owners if mentioned (prefix with "[ ] ")
3) Key decisions made (prefix with "→ ")

Keep it concise and professional.

TRANSCRIPT:
${transcript}

OUTPUT:`

export default function NotesPanel({ meetingId, transcript }) {
  const [notes, setNotes] = useState('')
  const [generating, setGenerating] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  // Load existing notes when meetingId changes
  useEffect(() => {
    if (!meetingId) return
    window.electronAPI.db.getNotes(meetingId).then((row) => {
      if (row) setNotes(row.content)
    })
  }, [meetingId])

  async function handleSummarize() {
    if (!transcript) {
      setError('No transcript to summarize. Start a meeting first.')
      return
    }
    setError(null)
    setGenerating(true)
    setNotes('')

    try {
      let fullText = ''
      for await (const token of streamGenerate({
        prompt: SUMMARY_PROMPT(transcript),
        model: 'llama3.2:3b',
      })) {
        fullText += token
        setNotes(fullText)
      }

      // Save to DB
      if (meetingId) {
        await window.electronAPI.db.upsertNotes(meetingId, fullText)
      }
    } catch (err) {
      setError(`Failed to generate summary: ${err.message}`)
    } finally {
      setGenerating(false)
    }
  }

  async function handleSave() {
    if (!meetingId || !notes) return
    await window.electronAPI.db.upsertNotes(meetingId, notes)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleExport() {
    if (!notes) return
    const date = new Date().toISOString().split('T')[0]
    const title = `meeting-notes-${date}.md`
    const markdown = `# Meeting Notes — ${date}\n\n${notes}`
    await window.electronAPI.saveMarkdown({ defaultName: title, content: markdown })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white flex-1">Meeting Notes</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSummarize}
            disabled={generating || !transcript}
            className="px-3 py-1.5 rounded-lg bg-teams-purple hover:bg-teams-purple-dark disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {generating ? (
              <span className="flex items-center gap-1.5">
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Generating…
              </span>
            ) : (
              'Summarize'
            )}
          </button>
          <button
            onClick={handleSave}
            disabled={!notes || !meetingId}
            className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm transition-colors"
          >
            {saved ? '✓ Saved' : 'Save'}
          </button>
          <button
            onClick={handleExport}
            disabled={!notes}
            className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm transition-colors"
          >
            Export .md
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Notes editor */}
      <div className="flex-1 overflow-hidden px-6 py-4">
        {!notes && !generating && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3">
            <div className="text-4xl opacity-30">📝</div>
            <p className="text-gray-500 text-sm">
              {transcript
                ? 'Click Summarize to generate AI meeting notes from your transcript.'
                : 'Start and stop a meeting first, then come here to summarize.'}
            </p>
          </div>
        )}
        {(notes || generating) && (
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes will appear here…"
            className="w-full h-full bg-transparent text-gray-200 text-sm leading-relaxed resize-none outline-none font-mono placeholder-gray-600"
          />
        )}
      </div>
    </div>
  )
}
