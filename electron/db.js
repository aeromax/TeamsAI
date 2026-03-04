const Database = require('better-sqlite3')
const path = require('path')
const { app } = require('electron')
const fs = require('fs')

const userDataDir = app.getPath('userData')
fs.mkdirSync(userDataDir, { recursive: true })

const db = new Database(path.join(userDataDir, 'meetings.db'))

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS setup (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT 'Untitled Meeting',
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    duration_s INTEGER
  );

  CREATE TABLE IF NOT EXISTS transcripts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    text       TEXT NOT NULL,
    ts         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
    context    TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// ── Setup helpers ─────────────────────────────────────────────────────────────

const setupGet = db.prepare('SELECT value FROM setup WHERE key = ?')
const setupSet = db.prepare('INSERT OR REPLACE INTO setup (key, value) VALUES (?, ?)')

function getSetup(key) {
  const row = setupGet.get(key)
  return row ? row.value : null
}

function setSetup(key, value) {
  setupSet.run(key, String(value))
}

// ── Meetings ─────────────────────────────────────────────────────────────────

const insertMeeting = db.prepare(`
  INSERT INTO meetings (title, started_at) VALUES (?, ?)
`)
const endMeeting = db.prepare(`
  UPDATE meetings SET ended_at = ?, duration_s = ? WHERE id = ?
`)
const getMeeting = db.prepare('SELECT * FROM meetings WHERE id = ?')
const listMeetings = db.prepare('SELECT * FROM meetings ORDER BY started_at DESC LIMIT 100')
const renameMeeting = db.prepare('UPDATE meetings SET title = ? WHERE id = ?')
const deleteMeeting = db.prepare('DELETE FROM meetings WHERE id = ?')

// ── Transcripts ───────────────────────────────────────────────────────────────

const insertTranscript = db.prepare(`
  INSERT INTO transcripts (meeting_id, seq, text, ts) VALUES (?, ?, ?, ?)
`)
const getTranscripts = db.prepare(
  'SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY seq ASC'
)

// ── Notes ─────────────────────────────────────────────────────────────────────

const upsertNotes = db.prepare(`
  INSERT INTO notes (meeting_id, content, created_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT DO NOTHING
`)
const updateNotes = db.prepare('UPDATE notes SET content = ? WHERE meeting_id = ?')
const getNotes = db.prepare('SELECT * FROM notes WHERE meeting_id = ?')

// ── Drafts ───────────────────────────────────────────────────────────────────

const insertDraft = db.prepare(`
  INSERT INTO drafts (meeting_id, context, content) VALUES (?, ?, ?)
`)
const getDrafts = db.prepare(
  'SELECT * FROM drafts WHERE meeting_id = ? ORDER BY created_at DESC'
)

module.exports = {
  db,
  getSetup,
  setSetup,
  insertMeeting,
  endMeeting,
  getMeeting,
  listMeetings,
  renameMeeting,
  deleteMeeting,
  insertTranscript,
  getTranscripts,
  upsertNotes,
  updateNotes,
  getNotes,
  insertDraft,
  getDrafts,
}
