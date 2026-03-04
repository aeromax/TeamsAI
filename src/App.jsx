import { useState, useEffect } from 'react'
import SetupWizard from './components/SetupWizard'
import MeetingPanel from './components/MeetingPanel'
import NotesPanel from './components/NotesPanel'
import DraftPanel from './components/DraftPanel'
import HistoryPanel from './components/HistoryPanel'

const NAV = [
  { id: 'meeting', label: 'Meeting', icon: '🎙️' },
  { id: 'notes', label: 'Notes', icon: '📝' },
  { id: 'draft', label: 'Draft', icon: '✉️' },
  { id: 'history', label: 'History', icon: '📂' },
]

export default function App() {
  const [setupDone, setSetupDone] = useState(null) // null = loading
  const [activePanel, setActivePanel] = useState('meeting')
  const [activeMeetingId, setActiveMeetingId] = useState(null)
  const [transcript, setTranscript] = useState('')

  useEffect(() => {
    window.electronAPI.db.getSetup('setup_complete').then((val) => {
      setSetupDone(val === 'true')
    })
  }, [])

  if (setupDone === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="text-gray-500 text-sm animate-pulse">Loading…</div>
      </div>
    )
  }

  if (!setupDone) {
    return (
      <SetupWizard
        onComplete={() => {
          window.electronAPI.db.setSetup('setup_complete', 'true')
          setSetupDone(true)
        }}
      />
    )
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 overflow-hidden">
      {/* Titlebar */}
      <div className="titlebar flex items-center h-10 px-4 bg-gray-900 border-b border-gray-800 select-none">
        <div className="flex-1" />
        <span className="text-sm font-semibold text-teams-purple tracking-wide">Teams AI</span>
        <div className="flex-1" />
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className="w-16 flex flex-col items-center py-4 gap-1 bg-gray-900 border-r border-gray-800">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setActivePanel(item.id)}
              title={item.label}
              className={`no-drag w-10 h-10 flex items-center justify-center rounded-lg text-xl transition-colors ${
                activePanel === item.id
                  ? 'bg-teams-purple text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              <span>{item.icon}</span>
            </button>
          ))}
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-hidden">
          {activePanel === 'meeting' && (
            <MeetingPanel
              activeMeetingId={activeMeetingId}
              setActiveMeetingId={setActiveMeetingId}
              transcript={transcript}
              setTranscript={setTranscript}
              onGoToNotes={() => setActivePanel('notes')}
            />
          )}
          {activePanel === 'notes' && (
            <NotesPanel
              meetingId={activeMeetingId}
              transcript={transcript}
            />
          )}
          {activePanel === 'draft' && (
            <DraftPanel meetingId={activeMeetingId} transcript={transcript} />
          )}
          {activePanel === 'history' && (
            <HistoryPanel
              onOpenMeeting={(id) => {
                setActiveMeetingId(id)
                setActivePanel('meeting')
              }}
            />
          )}
        </main>
      </div>
    </div>
  )
}
