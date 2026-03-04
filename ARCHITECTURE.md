# TeamsAI — Architecture & Function Reference

## Overview

TeamsAI is a local, privacy-first macOS desktop app that captures Microsoft Teams meeting audio, transcribes it in real time using Whisper, and uses a local Ollama LLM to generate meeting notes and draft replies. All AI processing happens on-device; no audio or text leaves the machine.

---

## Process Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                                │
│                                                                  │
│  main.js ──────────────────────────────────────────────────────│
│    • App lifecycle, window management                           │
│    • IPC handlers (50+ channels)                                │
│    • Ollama server management                                   │
│    • Audio setup via Swift binary                               │
│    • Whisper thread lifecycle + auto-restart                    │
│    • File downloads (model files, BlackHole pkg)                │
│                                                                  │
│  whisper-thread.js (worker_threads) ───────────────────────────│
│    • Loads @xenova/transformers pipeline (whisper-small.en)     │
│    • Processes transcription requests serially (no concurrency) │
│    • Communicates with main.js via postMessage                  │
│                                                                  │
│  db.js ─────────────────────────────────────────────────────── │
│    • better-sqlite3 (synchronous, main-thread SQLite)           │
│    • 5 tables: setup, meetings, transcripts, notes, drafts      │
│                                                                  │
│  preload.js ────────────────────────────────────────────────── │
│    • Exposes window.electronAPI via contextBridge               │
│    • All renderer ↔ main IPC goes through here                  │
└─────────────────────────────────────────────────────────────────┘
         ↕ IPC (contextBridge / ipcRenderer.invoke)
┌─────────────────────────────────────────────────────────────────┐
│  Electron Renderer Process (Chromium + React 18)                │
│                                                                  │
│  App.jsx                                                        │
│    MeetingPanel.jsx + useAudioCapture.js  ← active recording   │
│    NotesPanel.jsx                         ← AI summarization    │
│    DraftPanel.jsx                         ← AI reply drafts     │
│    HistoryPanel.jsx                       ← past meetings       │
│    SetupWizard.jsx                        ← one-time setup      │
└─────────────────────────────────────────────────────────────────┘
         ↕ spawnSync
┌─────────────────────────────────────────────────────────────────┐
│  resources/bin/setup-audio  (Swift binary)                      │
│    • CoreAudio: create/destroy Multi-Output Device              │
│    • Sets system default output device                          │
└─────────────────────────────────────────────────────────────────┘
         ↕ HTTP :11434
┌─────────────────────────────────────────────────────────────────┐
│  Ollama (local server, llama3.2:3b)                             │
│    • /api/generate — streaming text generation                  │
│    • /api/tags     — model list / health check                  │
│    • /api/pull     — model download                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Audio Capture Pipeline

```
macOS System Audio
       │
       ▼ (Teams Speaker = "Teams AI Output")
┌──────────────────────────────────┐
│  CoreAudio Multi-Output Device   │  ← "Teams AI Output"
│  ┌──────────────────────────┐    │
│  │ Real speakers / AirPods  │────┼─→ User hears the call
│  └──────────────────────────┘    │
│  ┌──────────────────────────┐    │
│  │ BlackHole 2ch            │────┼─→ Virtual loopback (captured as input)
│  └──────────────────────────┘    │
└──────────────────────────────────┘
             │
             ▼ getUserMedia({deviceId: blackhole})
      ┌──────────────────┐
      │  BlackHole Stream │ (other participants)
      └──────────────────┘
             │
             ▼                  ┌──────────────────┐
      AudioContext              │  Mic Stream       │ (user's own voice)
             │                  │ getUserMedia(mic) │
             │◄─────────────────└──────────────────┘
             │
             ▼
    AudioWorkletNode (PCMProcessor)
      • Accumulates Float32 samples in _buf[]
      • Fires postMessage every 4096 samples
             │
             ▼ bufferRef.current.push(chunk)
      setInterval(flushBuffer, 5000ms)
             │
             ▼
      flushBuffer()
        1. Merge all buffered chunks
        2. RMS silence check (< 0.0001 → skip)
        3. resampleTo16k() — linear interpolation from native rate → 16 kHz
        4. electronAPI.transcribe(buffer) → IPC to main process
             │
             ▼ worker_threads postMessage
      whisper-thread.js serial queue
        • pipeline('automatic-speech-recognition', 'Xenova/whisper-small.en')
        • quantized: false (FP32 — avoids ARM64 NEON INT8 SIGTRAP)
        • Returns { text: string }
             │
             ▼ IPC result back to renderer
      onChunk(text)
        • Appends to transcript state
        • Saves to SQLite (transcripts table)
```

---

## File Reference

### `electron/main.js`

**Startup sequence**
| Step | Action |
|------|--------|
| 1 | Register `model://` custom protocol for local ONNX file serving |
| 2 | Start Ollama server (or detect existing instance on :11434) |
| 3 | Check if FP32 ONNX model files exist; if not, create window first then auto-download |
| 4 | Start Whisper worker thread |
| 5 | Create BrowserWindow |

**Key functions**

| Function | Description |
|----------|-------------|
| `startWhisperThread()` | Spawns `whisper-thread.js` as a `worker_threads` Worker; wires `message`/`error`/`exit` handlers; posts `{ type: 'init', whisperCacheDir }` |
| `ensureNonQuantizedWhisper()` | Checks for `onnx/encoder_model.onnx` and `onnx/decoder_model_merged.onnx`; downloads any missing files from HuggingFace using `net.fetch` |
| `downloadFile(url, dest, onProgress)` | Streams a file from a URL to disk via `net.fetch`; writes to `.tmp` then atomically renames; sends progress callbacks |
| `runSetupAudio(args, sleepFirst)` | Copies `setup-audio` binary to `/tmp`, runs it with `spawnSync`, returns `{ success, output/error }` |
| `startOllama()` | Detects running Ollama or spawns it; sets `OLLAMA_MODELS`, `OLLAMA_HOST` |
| `waitForOllama(maxWaitMs)` | Polls `GET /api/tags` every 600 ms until Ollama responds or timeout |
| `ollamaBin()` | Finds Ollama binary: bundled path → Homebrew paths → `which ollama` |

**IPC handlers (ipcMain.handle)**

| Channel | Handler | Description |
|---------|---------|-------------|
| `whisper:transcribe` | main.js | Enqueues audio buffer to whisper thread; returns Promise resolved by callback map |
| `whisper:status` | main.js | Returns `{ ready: boolean }` |
| `setup:ensure-audio` | `runSetupAudio('setup')` | Rebuilds Multi-Output with current system default + BlackHole |
| `setup:ensure-audio-with` | `runSetupAudio(['setup-with', name])` | Rebuilds Multi-Output with named device + BlackHole |
| `setup:list-outputs` | `runSetupAudio('list-outputs')` | Returns array of non-BlackHole output device names |
| `setup:configure-audio` | `runSetupAudio('setup', true)` | Same as ensure-audio but waits 3 s (used right after BlackHole install) |
| `setup:teardown-audio` | `runSetupAudio('teardown')` | Destroys Multi-Output Device, restores original default |
| `setup:check-blackhole` | `runSetupAudio('status')` | Returns `{ found: boolean }` |
| `setup:install-blackhole` | main.js | Copies `.pkg` to `/tmp`, runs `installer` via osascript with admin privileges |
| `setup:pull-model` | main.js | Streams Ollama `/api/pull`; sends `setup:pull-progress` events to renderer |
| `setup:download-whisper` | main.js | Downloads all `WHISPER_FILES` from HuggingFace; sends `setup:whisper-progress` events |
| `db:*` | db.js | All SQLite CRUD operations (see db.js section) |
| `export:save-markdown` | main.js | Opens save dialog, writes `.md` file |
| `app:get-user-data` | main.js | Returns Electron userData path |
| `shell:open-external` | main.js | Opens local file:// URLs only |

---

### `electron/whisper-thread.js`

Runs as a `worker_threads` Worker in the main Node.js process. Never directly accessible from the renderer.

**State**
- `asr` — the `@xenova/transformers` pipeline instance (loaded once on `init`)
- `queue[]` — pending transcription messages
- `processing` — boolean guard preventing concurrent inference

**Message protocol**
```
Main → Worker:
  { type: 'init', whisperCacheDir: string }
  { type: 'transcribe', audio: ArrayBuffer, id: number }

Worker → Main:
  { type: 'ready' }
  { type: 'result', text: string, id: number }
  { type: 'error', error: string, id?: number }
```

**Key design decisions**
- `quantized: false` — uses FP32 ONNX model to avoid ARM64 NEON INT8 assertion failure (`SIGTRAP`) in onnxruntime-node 1.14.0
- Serial queue (`processQueue`) — onnxruntime is not safe for concurrent inference on the same pipeline; the queue ensures only one `asr()` call runs at a time
- `env.allowRemoteModels = false` — models must be pre-downloaded; no network access during inference

---

### `electron/db.js`

SQLite database via `better-sqlite3`. All statements are prepared at module load.

**Schema**

| Table | Columns | Purpose |
|-------|---------|---------|
| `setup` | `key, value` | Key-value store for app configuration flags (e.g. `setup_complete`) |
| `meetings` | `id, title, started_at, ended_at, duration_s` | One row per recorded meeting |
| `transcripts` | `id, meeting_id, seq, text, ts` | Ordered transcript segments for a meeting |
| `notes` | `id, meeting_id, content, created_at` | AI-generated or manually edited notes (one per meeting) |
| `drafts` | `id, meeting_id, context, content, created_at` | Saved AI reply drafts with the source context |

**Exported prepared statements**
`getSetup`, `setSetup`, `insertMeeting`, `endMeeting`, `getMeeting`, `listMeetings`, `renameMeeting`, `deleteMeeting`, `insertTranscript`, `getTranscripts`, `upsertNotes`, `updateNotes`, `getNotes`, `insertDraft`, `getDrafts`

---

### `electron/preload.js`

Exposes `window.electronAPI` to the renderer via `contextBridge`. All renderer → main communication goes through this bridge. Direct Node.js access is disabled in the renderer (`nodeIntegration: false`, `contextIsolation: true`).

**Exposed API groups**
- **Setup**: `installBlackHole`, `checkBlackHole`, `openPrivacySettings`, `configureAudio`, `ensureAudio`, `ensureAudioWith`, `listAudioOutputs`, `teardownAudio`, `pullModel`, `downloadWhisper`, `getWhisperCacheDir`, `getModelsDir`
- **Events**: `onPullProgress`, `onWhisperProgress`, `onWhisperStatus`
- **Transcription**: `transcribe`, `getWhisperStatus`
- **Shell/paths**: `openExternal`, `getUserData`, `saveMarkdown`
- **Database**: `db.getSetup`, `db.setSetup`, `db.insertMeeting`, `db.endMeeting`, `db.getMeeting`, `db.listMeetings`, `db.renameMeeting`, `db.deleteMeeting`, `db.insertTranscript`, `db.getTranscripts`, `db.upsertNotes`, `db.getNotes`, `db.insertDraft`, `db.getDrafts`

---

### `src/hooks/useAudioCapture.js`

React hook that manages the dual-capture audio graph and Whisper IPC.

**Props**
- `onChunk(text)` — called with each transcribed text segment
- `micDeviceId` — deviceId for the user's microphone (non-BlackHole input)

**Returned API**
`{ start, stop, pause, resume, audioDevices, selectedDevice, setSelectedDevice, workerStatus, workerError }`

**Internal refs** (persist across renders without causing re-renders)
| Ref | Type | Purpose |
|-----|------|---------|
| `contextRef` | AudioContext | Web Audio context |
| `streamRef` | MediaStream | BlackHole loopback stream |
| `micStreamRef` | MediaStream | User microphone stream |
| `processorRef` | AudioWorkletNode | PCM accumulator node |
| `bufferRef` | Float32Array[] | Accumulated audio chunks |
| `chunkTimerRef` | interval | Fires `flushBuffer` every 5 s |
| `isPausedRef` | boolean | True when paused; worklet messages ignored |
| `isFlushingRef` | boolean | True while an IPC transcribe call is in flight; prevents concurrent Whisper calls |
| `nativeSampleRateRef` | number | AudioContext sample rate (typically 44100 or 48000) |

**Key functions**

`start()` — Full audio graph setup sequence:
1. Open BlackHole stream via `getUserMedia` (echo/noise/AGC disabled)
2. Create `AudioContext`, set sink to `{ type: 'none' }` to suppress output
3. Load PCM worklet via blob URL (avoids CSP issues with inline scripts)
4. Create `AudioWorkletNode('pcm-processor')` — receives 4096-sample batches
5. Connect BlackHole source → workletNode
6. Open mic stream via `getUserMedia` (echo/noise/AGC enabled), connect to same workletNode (Web Audio sums inputs automatically)
7. Connect workletNode → `createMediaStreamDestination()` (keeps graph active)
8. Start 5-second chunk timer

`flushBuffer()` — Drain and transcribe:
1. Merge all accumulated Float32 chunks
2. Compute RMS; skip if < 0.0001 (silence)
3. Resample to 16 kHz via `resampleTo16k()` (pure-JS linear interpolation)
4. Call `electronAPI.transcribe(buffer)` — zero-copy ArrayBuffer transfer
5. On result, call `onChunk(text)`

`stop()` — Tears down everything: clears timer, calls `flushBuffer()` for final chunk, disconnects worklet, stops both media streams, closes AudioContext.

`resampleTo16k(buffer, fromRate)` — Pure-JS linear-interpolation resampler. Avoids `OfflineAudioContext` (which requires output device access and caused crashes in early versions).

---

### `src/components/MeetingPanel.jsx`

Main recording UI. Owns the meeting lifecycle.

**State**
| State | Purpose |
|-------|---------|
| `status` | `'idle' \| 'recording' \| 'paused'` |
| `startError` | Error shown if Start fails |
| `audioWarning` | Yellow banner shown during recording if preferred output device was unavailable |
| `meetingTitle` | Editable inline title |
| `editingTitle` | Whether title input is active |
| `startTime` | `Date.now()` when recording began (for elapsed timer) |
| `elapsed` | Seconds elapsed, updated by 1-second interval |
| `outputDevices` | String[] — names from `listAudioOutputs()` |
| `preferredOutput` | Selected "Listen through" device name |
| `micDevice` | Selected "Your mic" deviceId |

**Key functions**

`handleStart()`:
1. Calls `ensureAudioWith(preferredOutput)` — rebuilds Multi-Output Device with preferred device + BlackHole
2. If that fails (e.g. AirPods in HFP call mode), falls back to `ensureAudio()` and sets `audioWarning`
3. Creates meeting row in SQLite
4. Calls `start()` from `useAudioCapture`

`handleStop()`: Calls `stop()`, updates meeting row with `ended_at` and `duration_s`

`handlePause()` / `handleResume()`: Toggle `isPausedRef` in the audio hook; resume restarts the chunk timer

`onChunk(text)`: Appends text to transcript state + inserts into `transcripts` SQLite table with monotonic sequence number

**Device selectors** (visible when `status === 'idle'`):
- **Listen through**: `outputDevices[]` → sets `preferredOutput` (used by `ensureAudioWith` on Start)
- **Capture from**: `audioDevices[]` → sets `selectedDevice` in `useAudioCapture` (should be BlackHole 2ch)
- **Your mic**: non-BlackHole `audioDevices[]` → sets `micDeviceId` in `useAudioCapture`

---

### `src/components/NotesPanel.jsx`

AI meeting summarization panel.

`handleSummarize()`: Streams `streamGenerate()` with a prompt that asks the model for a 3-5 sentence summary, action items (`[ ] owner: task`), and key decisions (`→`). Saves result to `notes` table.

`handleExport()`: Opens system save dialog, writes markdown file.

**Prompt template**: Summary + action items (`[ ]`) + decisions (`→`), max 1024 tokens, temperature 0.7.

---

### `src/components/DraftPanel.jsx`

AI reply drafting panel.

`handleDraft()`: Takes user-pasted message context + up to 1000 chars of transcript as context. Streams `streamGenerate()` asking for exactly 3 numbered reply options (1-3 sentences each). Saves to `drafts` table.

`parseDrafts(raw)`: Parses numbered list (`1. ...`, `2. ...`, `3. ...`) from model output into individual strings for per-option copy buttons.

---

### `src/components/HistoryPanel.jsx`

Past meetings browser. Two-column layout: meeting list (left) + detail view (right).

`handleSelect(meeting)`: Loads transcripts, notes, and drafts for the selected meeting in parallel via `Promise.all`.

`handleExport(data)`: Generates markdown with title, date, duration, full transcript, and notes; opens save dialog.

---

### `src/lib/ollama.js`

Thin HTTP client for the local Ollama API (`http://127.0.0.1:11434`).

| Function | Description |
|----------|-------------|
| `healthCheck()` | GET /api/tags with 3 s timeout; returns boolean |
| `listModels()` | GET /api/tags; returns string[] of model names |
| `streamGenerate({ prompt, model, signal })` | POST /api/generate with `stream: true`; async generator yielding one token string per iteration |
| `generate({ prompt, model })` | POST /api/generate with `stream: false`; returns complete response string |

---

### `swift/setup-audio/main.swift`

Native CoreAudio binary compiled with `swiftc`. Copied to `/tmp` before each invocation (works around macOS sandbox restrictions on CloudStorage paths).

**CLI commands**

| Command | Function | Description |
|---------|----------|-------------|
| `setup` | `cmdSetup()` | Gets current system default output; creates Multi-Output Device (default + BlackHole); sets it as system default; saves state |
| `setup-with <name>` | `cmdSetupWith(nameFragment:)` | Finds output device by name substring; calls `buildAndActivate`; falls back to `cmdSetup()` if not found |
| `list-outputs` | `cmdListOutputs()` | Prints all output device names (one per line), excluding BlackHole and "Teams AI" devices |
| `teardown` | `cmdTeardown()` | Restores original output device from saved state; destroys aggregate device |
| `status` | `cmdStatus()` | Prints current default output device and BlackHole presence |

**Key internal functions**

| Function | Description |
|----------|-------------|
| `buildAndActivate(mainDeviceID:blackholeID:)` | Tears down any existing aggregate, creates new Multi-Output Device, sets as system default, saves state to `~/Library/Application Support/TeamsAI/audio-state.json` |
| `createMultiOutputDevice(mainDeviceID:blackholeID:)` | Calls `AudioHardwareCreateAggregateDevice` with `kAudioAggregateDeviceIsStackedKey: 1` (Multi-Output mode); returns new device ID |
| `getAllOutputDevices()` | Enumerates all CoreAudio devices with output streams |
| `findBlackHoleDevice()` | Returns deviceID of first device whose name contains "blackhole" |
| `getDeviceUID / getDeviceName` | CoreAudio property accessors |
| `saveState / loadState` | JSON file at `~/Library/Application Support/TeamsAI/audio-state.json` storing original and aggregate device IDs |

**AirPods limitation**: When AirPods are in HFP (Handsfree Profile) mode during a call, they run at 16 kHz. BlackHole runs at 48 kHz. CoreAudio cannot combine devices of different sample rates in a Multi-Output Device, so `AudioHardwareCreateAggregateDevice` fails. **Workaround**: Set Teams Microphone to MacBook Pro Microphone (not AirPods). This keeps AirPods in A2DP (48 kHz) mode, which CAN be combined with BlackHole.

---

## SQLite Database Schema

Located at `~/Library/Application Support/teams-ai/meetings.db`

```sql
setup        (key TEXT PK, value TEXT)
meetings     (id AUTOINCREMENT, title, started_at, ended_at, duration_s)
transcripts  (id AUTOINCREMENT, meeting_id FK→meetings, seq, text, ts)
notes        (id AUTOINCREMENT, meeting_id FK→meetings, content, created_at)
drafts       (id AUTOINCREMENT, meeting_id FK→meetings, context, content, created_at)
```

---

## Model Files

Located at `~/Library/Application Support/teams-ai/models/whisper/Xenova/whisper-small.en/`

```
config.json
generation_config.json
preprocessor_config.json
tokenizer.json
tokenizer_config.json
special_tokens_map.json
onnx/
  encoder_model.onnx           ← FP32, ~145 MB
  decoder_model_merged.onnx    ← FP32, ~174 MB
```

The `_quantized.onnx` variants (INT8) are NOT used because onnxruntime-node 1.14.0 has an ARM64 NEON assertion failure when running INT8 operations on Apple Silicon.

---

## Key Dependency Versions

| Package | Version | Notes |
|---------|---------|-------|
| Electron | 28 | Chromium 120 |
| React | 18 | Renderer UI |
| `@xenova/transformers` | 2.17.2 | Whisper pipeline |
| `onnxruntime-node` | 1.14.0 | Must match @xenova peer dep; overridden in package.json |
| `onnxruntime-common` | 1.14.0 | Must match onnxruntime-node version |
| `better-sqlite3` | latest | Rebuilt for Electron via electron-rebuild |
| Ollama model | llama3.2:3b | Summarization + drafts |
| Whisper model | whisper-small.en | ~320 MB FP32 ONNX |

---

## Setup Wizard Flow

1. **BlackHole** — installs `BlackHole2ch-*.pkg` via `installer` with admin privileges; verifies with `setup-audio status`
2. **Microphone permission** — triggers `getUserMedia` to prompt macOS privacy dialog; opens System Settings if denied
3. **Audio routing** — runs `setup-audio setup` to create Multi-Output Device
4. **Ollama** — checks if running; pulls `llama3.2:3b` via HTTP streaming API
5. **Whisper** — downloads 8 model files from HuggingFace; writes `setup_complete = 'true'` to SQLite on success
