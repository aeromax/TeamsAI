import { useState, useEffect } from 'react'

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(secs) {
  if (!secs) return ''
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}m ${s}s`
}

export default function HistoryPanel({ onOpenMeeting }) {
  const [meetings, setMeetings] = useState([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [meetingData, setMeetingData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(null)

  async function loadMeetings() {
    const list = await window.electronAPI.db.listMeetings()
    setMeetings(list)
  }

  useEffect(() => {
    loadMeetings()
  }, [])

  async function handleSelect(meeting) {
    setSelected(meeting.id)
    setLoading(true)
    const [transcripts, notes, drafts] = await Promise.all([
      window.electronAPI.db.getTranscripts(meeting.id),
      window.electronAPI.db.getNotes(meeting.id),
      window.electronAPI.db.getDrafts(meeting.id),
    ])
    setMeetingData({ meeting, transcripts, notes, drafts })
    setLoading(false)
  }

  async function handleDelete(id) {
    setDeleting(id)
    await window.electronAPI.db.deleteMeeting(id)
    setMeetings((prev) => prev.filter((m) => m.id !== id))
    if (selected === id) {
      setSelected(null)
      setMeetingData(null)
    }
    setDeleting(null)
  }

  async function handleExport(data) {
    const { meeting, transcripts, notes } = data
    const date = (meeting.started_at || '').split('T')[0]
    const transcriptText = transcripts.map((t) => t.text).join(' ')
    const notesText = notes ? notes.content : '_No notes generated._'

    const markdown = `# ${meeting.title}
**Date:** ${formatDate(meeting.started_at)}
**Duration:** ${formatDuration(meeting.duration_s)}

## Transcript
${transcriptText || '_No transcript available._'}

## Notes
${notesText}
`
    await window.electronAPI.saveMarkdown({
      defaultName: `meeting-${date}.md`,
      content: markdown,
    })
  }

  const filtered = meetings.filter((m) =>
    m.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="w-64 flex-shrink-0 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-800">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search meetings…"
            className="w-full bg-gray-800 text-sm text-gray-200 rounded-lg px-3 py-1.5 outline-none placeholder-gray-600 border border-gray-700 focus:border-teams-purple transition-colors"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-600">
              {meetings.length === 0 ? 'No meetings yet.' : 'No results.'}
            </div>
          )}
          {filtered.map((m) => (
            <div
              key={m.id}
              onClick={() => handleSelect(m)}
              className={`flex flex-col px-4 py-3 cursor-pointer border-b border-gray-800/50 transition-colors group ${
                selected === m.id ? 'bg-teams-purple/20' : 'hover:bg-gray-800/50'
              }`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="text-sm text-gray-200 font-medium truncate flex-1">{m.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(m.id)
                  }}
                  disabled={deleting === m.id}
                  className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-300 flex-shrink-0 transition-opacity"
                >
                  {deleting === m.id ? '…' : '✕'}
                </button>
              </div>
              <span className="text-xs text-gray-500">{formatDate(m.started_at)}</span>
              {m.duration_s && (
                <span className="text-xs text-gray-600">{formatDuration(m.duration_s)}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Select a meeting to view details.
          </div>
        )}
        {loading && (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm animate-pulse">
            Loading…
          </div>
        )}
        {meetingData && !loading && (
          <>
            <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800">
              <div className="flex-1">
                <h2 className="text-sm font-semibold text-white">{meetingData.meeting.title}</h2>
                <span className="text-xs text-gray-500">
                  {formatDate(meetingData.meeting.started_at)}
                  {meetingData.meeting.duration_s && ` · ${formatDuration(meetingData.meeting.duration_s)}`}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onOpenMeeting(meetingData.meeting.id)}
                  className="px-3 py-1.5 text-sm bg-teams-purple hover:bg-teams-purple-dark text-white rounded-lg transition-colors"
                >
                  Open
                </button>
                <button
                  onClick={() => handleExport(meetingData)}
                  className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                >
                  Export .md
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-6">
              {meetingData.notes && (
                <section>
                  <h3 className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">Notes</h3>
                  <pre className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed font-mono">
                    {meetingData.notes.content}
                  </pre>
                </section>
              )}
              {meetingData.transcripts.length > 0 && (
                <section>
                  <h3 className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">
                    Transcript ({meetingData.transcripts.length} segments)
                  </h3>
                  <p className="text-sm text-gray-300 leading-relaxed">
                    {meetingData.transcripts.map((t) => t.text).join(' ')}
                  </p>
                </section>
              )}
              {meetingData.drafts.length > 0 && (
                <section>
                  <h3 className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">
                    Saved Drafts
                  </h3>
                  {meetingData.drafts.map((d) => (
                    <div
                      key={d.id}
                      className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-2 text-sm text-gray-200"
                    >
                      <p className="text-xs text-gray-600 mb-1">{formatDate(d.created_at)}</p>
                      <p>{d.content}</p>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
