const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Setup
  installBlackHole: () => ipcRenderer.invoke('setup:install-blackhole'),
  checkBlackHole: () => ipcRenderer.invoke('setup:check-blackhole'),
  openPrivacySettings: () => ipcRenderer.invoke('setup:open-privacy-settings'),
  configureAudio: () => ipcRenderer.invoke('setup:configure-audio'),
  ensureAudio: () => ipcRenderer.invoke('setup:ensure-audio'),
  ensureAudioWith: (deviceName) => ipcRenderer.invoke('setup:ensure-audio-with', deviceName),
  listAudioOutputs: () => ipcRenderer.invoke('setup:list-outputs'),
  teardownAudio: () => ipcRenderer.invoke('setup:teardown-audio'),
  pullModel: (model) => ipcRenderer.invoke('setup:pull-model', model),
  getWhisperCacheDir: () => ipcRenderer.invoke('setup:get-whisper-cache-dir'),
  getModelsDir: () => ipcRenderer.invoke('setup:get-models-dir'),
  downloadWhisper: () => ipcRenderer.invoke('setup:download-whisper'),
  onPullProgress: (cb) => {
    ipcRenderer.on('setup:pull-progress', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('setup:pull-progress')
  },
  onWhisperProgress: (cb) => {
    ipcRenderer.on('setup:whisper-progress', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('setup:whisper-progress')
  },
  transcribe: (audioBuffer) => ipcRenderer.invoke('whisper:transcribe', audioBuffer),
  getWhisperStatus: () => ipcRenderer.invoke('whisper:status'),
  onWhisperStatus: (cb) => {
    ipcRenderer.on('whisper:status', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('whisper:status')
  },

  // App paths
  getUserData: () => ipcRenderer.invoke('app:get-user-data'),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Export
  saveMarkdown: (opts) => ipcRenderer.invoke('export:save-markdown', opts),

  // Database
  db: {
    getSetup: (key) => ipcRenderer.invoke('db:get-setup', key),
    setSetup: (key, value) => ipcRenderer.invoke('db:set-setup', key, value),

    insertMeeting: (title, startedAt) => ipcRenderer.invoke('db:insert-meeting', title, startedAt),
    endMeeting: (id, endedAt, durationS) => ipcRenderer.invoke('db:end-meeting', id, endedAt, durationS),
    getMeeting: (id) => ipcRenderer.invoke('db:get-meeting', id),
    listMeetings: () => ipcRenderer.invoke('db:list-meetings'),
    renameMeeting: (id, title) => ipcRenderer.invoke('db:rename-meeting', id, title),
    deleteMeeting: (id) => ipcRenderer.invoke('db:delete-meeting', id),

    insertTranscript: (meetingId, seq, text, ts) =>
      ipcRenderer.invoke('db:insert-transcript', meetingId, seq, text, ts),
    getTranscripts: (meetingId) => ipcRenderer.invoke('db:get-transcripts', meetingId),

    upsertNotes: (meetingId, content) => ipcRenderer.invoke('db:upsert-notes', meetingId, content),
    getNotes: (meetingId) => ipcRenderer.invoke('db:get-notes', meetingId),

    insertDraft: (meetingId, context, content) =>
      ipcRenderer.invoke('db:insert-draft', meetingId, context, content),
    getDrafts: (meetingId) => ipcRenderer.invoke('db:get-drafts', meetingId),
  },
})
