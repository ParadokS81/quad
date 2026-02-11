# Quad — Implementation Plan

> Read CLAUDE.md first for full context, architecture decisions, and non-negotiable rules.
> This plan is ordered — each phase builds on the previous one.

---

## Phase 1: Project Scaffold + Module System + Bot Connects to Discord ✓

**Status**: COMPLETE — Tested 2026-02-09

**Goal**: Bot starts, logs in, loads modules, responds to a slash command. No audio yet.

### Implementation Notes
- `BotModule` interface extended with `handleCommand()` method for clean command routing from `bot.ts`
- discord.js deprecated `ephemeral: true` — use `flags: MessageFlags.Ephemeral` instead
- `@snazzah/davey` is NOT bundled — must be installed explicitly: `npm install @snazzah/davey`
- ESM + ts-node requires `--loader ts-node/esm` flag
- `.env` loaded via Node's `--env-file=.env` flag (not dotenv)

### Files created
```
package.json, tsconfig.json, .env.example, .gitignore
src/index.ts
src/core/bot.ts
src/core/config.ts
src/core/logger.ts
src/core/module.ts
src/modules/recording/index.ts
src/modules/recording/commands/record.ts
```

---

## Phase 2: Join Voice Channel + Receive Audio Streams ✓

**Status**: COMPLETE — Tested 2026-02-09

**Goal**: Bot joins a voice channel and subscribes to per-user Opus streams. Audio logged to console but not yet written to disk.

### Implementation Notes
- DAVE protocol is now mandatory — `@snazzah/davey` must be installed or voice connection crashes
- Opus stream emits `error` events during DAVE handshake (early packets before E2E negotiation) — must handle with `opusStream.on('error', ...)` or process crashes
- `receiver.speaking.on('start')` fires when a user starts talking — we subscribe at that point
- `voiceStateUpdate` in module `registerEvents` handles mid-session joins/leaves
- Guards: double-start prevented, stop-when-not-recording handled
- `entersState(connection, VoiceConnectionStatus.Ready, 10_000)` with 10s timeout for join

### Files modified
```
src/modules/recording/commands/record.ts (major update — voice join, subscribe, stop)
src/modules/recording/index.ts (voiceStateUpdate events, onShutdown cleanup)
```

---

## Phase 3: Write OGG/Opus to Disk ✓

**Status**: COMPLETE — Tested 2026-02-09

**Goal**: Per-user audio streams written as OGG/Opus files. This is the core recording functionality.

### Implementation Notes
- prism-media v1.3.5 only has OGG *demuxers* — switched to v2.0.0-alpha.0 which has `OggLogicalBitstream` + `OpusHead` (the actual muxer)
- `crc: true` is required — `crc: false` produces files ffprobe/ffmpeg reject. Requires `node-crc@^1.3.2` (CJS; v3+ is ESM-only and breaks)
- `RecordingSession` class owns the voice connection, speaking events, and all tracks
- `UserTrack` class handles the `opusStream → OggLogicalBitstream → file` pipeline per user
- Uses `randomUUID()` for session IDs (ULID deferred to Phase 5 with metadata)
- `pipeline()` from `node:stream/promises` for backpressure-safe piping
- `ERR_STREAM_PREMATURE_CLOSE` is expected on stop (opus stream destroyed) — handled gracefully
- Verified: ffprobe reads clean `Audio: opus, 48000 Hz, stereo, fltp`, ~60KB for 23s recording

### Steps

1. **Create `src/modules/recording/track.ts` — `UserTrack` class**
   - Properties: `trackNumber`, `userId`, `username`, `displayName`, `joinedAt`, `oggStream`, `fileStream`, `filePath`
   - Constructor: creates output directory, opens `fs.createWriteStream()`, creates `prism.opus.OggLogicalBitstream` (48kHz, stereo)
   - Method: `start(opusStream)` — pipe: `opusStream → oggStream → fileStream`
   - Method: `stop()` — end the pipeline gracefully, close file stream
   - Method: `getMetadata()` — return track info for `session_metadata.json`

2. **Create `src/modules/recording/session.ts` — `RecordingSession` class**
   - Properties: `sessionId` (ULID), `startTime`, `endTime`, `outputDir`, `tracks` Map<userId, UserTrack>
   - Method: `start(connection)` — set up receiver, subscribe to speaking events
   - Method: `addUser(userId, username, displayName)` — create new `UserTrack`, subscribe to their opus stream
   - Method: `removeUser(userId)` — mark track `left_at`, but keep stream open (pad silence until session ends)
   - Method: `stop()` — end all tracks, write `session_metadata.json`, return session summary
   - Track numbering: auto-increment as users are added (1-based, matching filename)

3. **Create output directory structure**
   - On session start: `mkdir -p {RECORDING_DIR}/{sessionId}/`
   - Filename convention: `{trackNumber}-{username}.ogg`

4. **Wire up commands**
   - `/record start` → create `RecordingSession`, call `session.start(connection)`
   - `/record stop` → call `session.stop()`, disconnect, reply with summary

5. **Test**: Record a real voice session. Verify:
   - One `.ogg` file per speaker in `recordings/{sessionId}/`
   - Files playable in VLC/ffplay
   - Audio is clear Opus (not transcoded)
   - `ffprobe` shows: OGG container, Opus codec, 48kHz, stereo

### Files created
```
src/modules/recording/track.ts
src/modules/recording/session.ts
```

### Files modified
```
src/modules/recording/commands/record.ts (wire up session)
```

---

## Phase 4: Silence Handling + Track Sync ✓

**Status**: COMPLETE — 2026-02-10

**Goal**: All tracks are time-aligned to recording start. Silence gaps are handled.

### Implementation Notes
- Used the standard 3-byte silent Opus frame (`0xF8, 0xFF, 0xFE`) — universal constant across discord.js, discord.py, and all major Discord libraries. No encoder needed.
- Replaced `pipeline(opusStream, oggStream, fileStream)` with manual `oggStream.pipe(fileStream)` + `opusStream.on('data')` — allows mixing real packets and silence frames via direct `oggStream.write()` calls
- Option A (real-time 20ms `setInterval` timer) implemented — produces continuous OGG files with no gaps, matches Craig's behavior
- Late-join silence prepend: calculates gap from recording start to user join, writes N silent frames upfront
- Rejoin handling: `reattach()` method swaps the opus stream on an existing track; silence timer was running the whole time so the file stays continuous
- `voiceStateUpdate` detects rejoins and calls `session.reattachUser()`

### Files created
```
src/modules/recording/silence.ts
```

### Files modified
```
src/modules/recording/track.ts (silence timer, late-join prepend, manual piping, reattach)
src/modules/recording/session.ts (pass startTime, reattachUser)
src/modules/recording/commands/record.ts (getActiveSession export)
src/modules/recording/index.ts (rejoin detection in voiceStateUpdate)
```

---

## Phase 5: Metadata + Pipeline Compatibility ✓

**Status**: COMPLETE — 2026-02-10

**Goal**: Bot writes `session_metadata.json` that the voice-analysis pipeline can consume.

### Implementation Notes
- `writeSessionMetadata()` writes all fields from the schema: `schema_version`, `recording_start_time`, `recording_end_time`, `recording_id`, `source` ("quad"), `source_version`, `guild`, `channel`, `tracks`
- `team` field included only when `TEAM_TAG` env var is set (optional per schema)
- Used existing UUID `sessionId` as `recording_id` — ULID deferred (no extra dependency needed, UUID works fine)
- `source_version` hardcoded as `"1.0.0"` — matches `package.json`
- Called from `session.stop()` after all tracks are flushed
- Schema matches `docs/session_metadata_schema.json` exactly
- Pipeline compatibility: `craig_parser.py` in voice-analysis needs a small update to detect `source: "quad"` and read this JSON instead of `raw.dat`

### Files created
```
src/modules/recording/metadata.ts
```

### Files modified
```
src/modules/recording/session.ts (import + call writeSessionMetadata)
```

### Cross-project change needed (voice-analysis)
```
src/processing/craig_parser.py — detect source: "quad", glob *.ogg, read session_metadata.json
```

---

## Phase 6: Error Handling + Robustness ✓

**Status**: COMPLETE — 2026-02-10

**Goal**: Bot handles edge cases gracefully and doesn't crash on unexpected events.

### Implementation Notes
- Per-track error isolation: `failed` flag + `closeOnError()` method. If one track's OGG or file stream errors, that track is closed cleanly while all others keep recording. All write paths (data handler, silence timer, reattach) guard on `failed`.
- Voice connection resilience: `Disconnected` → attempt reconnect (30s timeout via `Promise.race` on Signalling/Connecting states). `Destroyed` → null out connection so `stop()` doesn't double-destroy. Both fire `onConnectionLost` callback → auto-stop recording.
- `connection.destroy()` wrapped in try/catch — can throw if connection is already in a bad state after disconnect timeout.
- `stopRecording()` clears `activeSession` immediately before awaiting `session.stop()` — prevents double-stop from concurrent `/record stop` + `onConnectionLost` race.
- `reattach()` uses `removeAllListeners()` (not just `removeAllListeners('data')`) to clean up stale error handlers on old opus stream.
- `unhandledRejection` logs but doesn't crash (keeps bot running). `uncaughtException` flushes recordings then exits.
- Double SIGTERM/SIGINT guarded by `shuttingDown` flag.
- Disk space check via `statfs()` on session init — warns if < 1 GB free, never fails the session.
- Double-start/stop guards were already in place from Phase 2.
- SIGTERM/SIGINT + module `onShutdown` were already in place from Phase 1.

### Files modified
```
src/modules/recording/track.ts (failed flag, closeOnError, write guards, reattach cleanup)
src/modules/recording/session.ts (connection state handlers, onConnectionLost, stopping flag, destroy try/catch, disk space check)
src/modules/recording/commands/record.ts (stopRecording error wrap, onConnectionLost wiring)
src/index.ts (unhandledRejection, uncaughtException, shuttingDown guard)
```

---

## Phase 7: Docker + Distribution

**Goal**: Bot runs in a Docker container. Anyone can self-host with minimal setup.

### Steps

1. **Create `Dockerfile`**
   - Multi-stage: build TypeScript → run compiled JS
   - Base: `node:22-slim` (need native addons for opus, Node >= 22.12.0 required)
   - Install system deps: `python3`, `make`, `g++` (for node-gyp / @discordjs/opus native build)
   - Copy package.json → npm ci → copy src → tsc → prune dev deps
   - CMD: `node dist/index.js`

2. **Create `docker-compose.yml`**
   - Service: `quad`
   - Volume: `./recordings:/app/recordings`
   - env_file: `.env`
   - restart: `unless-stopped`
   - healthcheck: (add HTTP health endpoint if time, or just process check)

3. **Create `.dockerignore`**
   - node_modules, dist, recordings, .env, .git

4. **Create `.gitignore`**
   - node_modules/, dist/, recordings/, .env

5. **Test**: `docker compose up -d`, verify bot comes online, record a session, verify files appear in mounted volume.

### Files created
```
Dockerfile
docker-compose.yml
.dockerignore
.gitignore
```

---

## Phase 8: Polish

**Goal**: Ready for first real use with the team.

### Steps

1. **Health check endpoint in `core/bot.ts`**
   - Simple HTTP server on configurable port (default 3000)
   - `GET /health` → 200 OK with `{ status: "ok", modules: ["recording"], uptime: N }`
   - Used by Docker health checks and monitoring
   - Reports loaded modules and their status

2. **Reply messages**
   - `/record start` → ephemeral reply: "Recording started in #{channel}. {N} users detected."
   - `/record stop` → reply: "Recording saved. {N} tracks, {duration}. Session: {sessionId}"
   - Include track list in stop message

3. **Logging polish**
   - Log session start/stop with session ID
   - Log user join/leave with track number
   - Log file sizes on session end
   - Log errors with stack traces

4. **Initialize git repo, first commit**

### Files modified
```
src/core/bot.ts (health endpoint)
src/modules/recording/commands/record.ts (reply messages)
src/core/logger.ts (polish)
```

---

## Dependency Summary

### Runtime
| Package | Version | Purpose |
|---------|---------|---------|
| `discord.js` | ^14.25.1 | Discord bot framework |
| `@discordjs/voice` | ^0.19.0 | Voice connection + audio receive + DAVE |
| `@discordjs/opus` | latest | Native Opus codec (required for voice) |
| `prism-media` | 2.0.0-alpha.0 | OGG/Opus muxer (`OggLogicalBitstream`). Use with `crc: false`. |
| `@snazzah/davey` | ^0.1.6 | DAVE protocol — must be installed explicitly (peer dep of @discordjs/voice) |
| `ulid` | latest | Time-sortable unique IDs for sessions |

### Dev
| Package | Purpose |
|---------|---------|
| `typescript` ^5 | TypeScript compiler |
| `@types/node` | Node.js type definitions |
| `ts-node` | Run TS directly during dev |

### System
| Dependency | Purpose |
|------------|---------|
| Node.js >= 22.12.0 | Runtime (required by @discordjs/voice 0.19.0) |
| Python 3 + make + g++ | Build native addons (@discordjs/opus) |

---

## Testing Checklist

After each phase, verify:

- [x] Bot comes online, modules loaded (Phase 1)
- [x] Bot joins voice channel on `/record start` (Phase 2)
- [x] OGG files appear in output directory (Phase 3)
- [x] All OGG files have same duration (Phase 4) — tested single user, silence padding works
- [x] `session_metadata.json` is valid and complete (Phase 5) — verified 2026-02-10
- [x] Bot survives disconnects and force-kills (Phase 6) — code reviewed, not live-tested
- [ ] `docker compose up` works end-to-end (Phase 7)
- [ ] voice-analysis pipeline reads Quad output correctly (Phase 5, cross-project)

## Open Questions (Decide During Implementation)

1. ~~**Silence padding strategy**~~: Decided: Option A (real-time 20ms timer). Works well with `OggLogicalBitstream.write()`.

2. **Auto-start/auto-stop**: Should v1 support auto-start when users join a configured channel? Or keep it manual-only via `/record start`? Leaning manual-only for v1.

3. ~~**ULID vs UUID**~~: Decided: UUID for now. No extra dependency, works fine as `recording_id`. Can switch to ULID later if time-sortability matters.

4. ~~**Session ID format**~~: UUID for both `recording_id` and directory name. Simple and consistent.

---
---

# Processing Module — Integration Plan

> Port the voice-analysis Python pipeline into Quad as a TypeScript module.
> Source project: `/home/paradoks/projects/quake/voice-analysis/`

## Context

Recording bot is complete. The `voice-analysis` Python project has a proven pipeline: parse recordings → query QW Hub → pair matches → split audio → transcribe → analyze. The goal is to bundle this into Quad so any QW clan gets the full capability from `docker-compose up`.

**Approach:** Port to TypeScript. One exception: transcription calls a thin Python wrapper around `faster-whisper` (~50 lines) because Node.js whisper bindings lack VAD filtering and word-level timestamps. Docker bundles Python + faster-whisper for this one step.

---

## What Gets Ported

### Port to TypeScript (~1100 lines)
| Python file | TS file | Lines | Notes |
|---|---|---|---|
| `pipeline.py` (modern path only) | `pipeline.ts` | ~150 | Drop legacy tone-detection mode |
| `qwhub_client.py` | `hub-client.ts` | ~100 | `fetch()` replaces `httpx` |
| `match_pairer.py` | `match-pairer.ts` | ~150 | Pure math, direct port |
| `timestamp_splitter.py` | `audio-splitter.ts` | ~200 | `child_process.execFile('ffmpeg')` |
| `transcriber.py` re-segmentation | `transcriber.ts` | ~120 | Spawns Python, then re-segments in TS |
| `timeline_merger.py` | `timeline-merger.ts` | ~130 | Pure data manipulation |
| `analyzer.py` | `analyzer.ts` | ~250 | `@anthropic-ai/sdk`, same prompts |
| `audio_utils.py` | `utils.ts` | ~80 | YAML loading, player name resolution |

### Keep as Python (~50 lines)
| File | Purpose |
|---|---|
| `scripts/transcribe.py` | Thin wrapper: load faster-whisper, transcribe all tracks in a directory, output raw segments + word timestamps as JSON. TS does re-segmentation. |

### Copy as-is (YAML knowledge bases)
- `knowledge/terminology/qw_glossary.yaml` → `src/modules/processing/knowledge/terminology/qw-glossary.yaml`
- `knowledge/maps/map_strategies.yaml` → `src/modules/processing/knowledge/maps/map-strategies.yaml`
- `knowledge/templates/map_report.yaml` → `src/modules/processing/knowledge/templates/map-report.yaml`

### Don't port
- `tone_detector.py`, `audio_splitter.py` — legacy
- `craig_parser.py` — we read our own `session_metadata.json`
- `generate_tones.py` — legacy capture helper

---

## Architecture

```
src/modules/processing/
├── index.ts                     # BotModule: /process command, auto-trigger hook
├── commands/
│   └── process.ts               # /process status|transcribe|analyze|rerun
├── pipeline.ts                  # Orchestrator — two-stage (fast + slow)
├── stages/
│   ├── hub-client.ts            # QW Hub Supabase API + ktxstats fetcher
│   ├── match-pairer.ts          # Confidence scoring, offset calc, overlap trim
│   ├── audio-splitter.ts        # ffmpeg stream-copy splitting + ffprobe
│   ├── transcriber.ts           # Spawn Python wrapper, re-segment by silence gaps
│   ├── timeline-merger.ts       # Merge transcripts, overlaps, stats
│   └── analyzer.ts              # Claude API analysis with ktxstats + map knowledge
├── knowledge/                   # YAML files from voice-analysis
│   ├── terminology/qw-glossary.yaml
│   ├── maps/map-strategies.yaml
│   └── templates/map-report.yaml
├── types.ts                     # MatchPairing, SessionData, TranscriptSegment, etc.
└── utils.ts                     # YAML loader, player name resolution, prompt builder

scripts/
└── transcribe.py                # Thin faster-whisper wrapper (~50 lines)
```

### New dependencies
- `js-yaml` + `@types/js-yaml` — parse YAML knowledge files
- `@anthropic-ai/sdk` — Claude analysis

### Config additions (.env)
```
ANTHROPIC_API_KEY=             # For Claude analysis (optional)
WHISPER_MODEL=small            # tiny/base/small/medium/turbo
PLAYER_QUERY=paradoks          # QW Hub player search term
PLAYER_NAME_MAP=paradoks:ParadokS,zerohero5954:zero,fs_razor:Razor,grisling2947:grisling
PROCESSING_AUTO=true           # Auto-run fast pipeline after recording
PROCESSING_TRANSCRIBE=false    # Auto-run transcription (slow)
PROCESSING_INTERMISSIONS=true  # Extract between-map discussion
```

---

## Two-Stage Pipeline Design

### Fast Pipeline (seconds, auto after recording)
1. Parse session metadata
2. Query QW Hub API for matches
3. Pair matches + fetch ktxstats
4. Split audio by match timestamps

**Result:** Organized per-match audio directories with metadata. Usable immediately.

### Slow Pipeline (hours on CPU, opt-in)
5. Transcribe per-player segments
6. Merge timelines + compute stats
7. Claude analysis (optional, needs API key)

**Triggers:**
- `PROCESSING_TRANSCRIBE=true` → auto-runs slow pipeline after fast
- `/process transcribe {session_id}` → manual trigger
- `/process analyze {session_id}` → analysis only (needs transcripts first)
- Default: fast auto, slow manual

---

## Transcription Strategy

**Problem:** `faster-whisper` is Python-only. Node.js whisper bindings lack VAD + word timestamps.

**Solution:**
1. **Python script** (`scripts/transcribe.py`, ~50 lines): loads faster-whisper, transcribes directory, outputs raw JSON with word arrays. Same params: `vad_filter=True`, `min_silence_duration_ms=300`, `word_timestamps=True`, `beam_size=5`
2. **TypeScript** (`transcriber.ts`): builds QW glossary prompt from YAML, spawns Python, reads JSON, applies re-segmentation (split on word gaps >= 800ms)

---

## Pitfalls

| Stage | Risk | Mitigation |
|---|---|---|
| QW Hub API | API down | Graceful fallback to "process as single segment" |
| Audio Splitting | OGG seeking | `-avoid_negative_ts make_zero` flag (proven) |
| Transcription | Processing time (2-3hrs on CPU) | Must run async, don't block bot |
| Transcription | Model download (~500MB) | Pre-download in Docker build |
| Claude Analysis | API key required | Make optional — pipeline works without it |
| Claude Analysis | Token cost (~$0.10/map) | Document cost, make opt-in |

---

## Output Structure

```
recordings/{session_id}/
├── session_metadata.json          # From recording (exists)
├── 1-paradoks.ogg                 # Raw recordings (exist)
└── processed/                     # NEW
    ├── pipeline_status.json
    ├── 01_dm3_sr_vs_red/
    │   ├── metadata.json
    │   ├── audio/  (split per-player segments)
    │   ├── transcripts/  (per-player + merged + stats)
    │   └── analysis/  (report.md + meta.json)
    └── 02_dm2_sr_vs_red/
```

---

## Implementation Phases

### Phase P1: Scaffold + Types + Config + Knowledge ⬜
- Create `src/modules/processing/` directory structure
- Define TypeScript interfaces in `types.ts`
- Extend `config.ts` with new env vars
- Copy YAML knowledge files from voice-analysis
- Add `js-yaml` and `@anthropic-ai/sdk` to package.json
- Create `utils.ts` (YAML loader, player name resolution, whisper prompt builder)
- Create module skeleton in `index.ts`
- **Verify:** `npx tsc --noEmit` passes

### Phase P2: Hub Client + Match Pairer ⬜
- Port `qwhub_client.py` → `stages/hub-client.ts`
- Port `match_pairer.py` → `stages/match-pairer.ts`
- **Verify:** Test against live QW Hub API with test session timestamps

### Phase P3: Audio Splitter ⬜
- Port `timestamp_splitter.py` → `stages/audio-splitter.ts` (incl. intermission extraction)
- **Verify:** Split test recording, compare durations with Python output

### Phase P4: Transcriber ⬜
- Write `scripts/transcribe.py` (thin Python wrapper)
- Port re-segmentation + prompt builder → `stages/transcriber.ts`
- **Verify:** Transcribe one split segment, compare with Python output

### Phase P5: Timeline Merger ⬜
- Port `timeline_merger.py` → `stages/timeline-merger.ts`
- **Verify:** Compare merged timeline, overlaps, stats

### Phase P6: Claude Analyzer ⬜
- Port `analyzer.py` → `stages/analyzer.ts`
- Port all prompt construction (map context, ktxstats, report template)
- **Verify:** Run analysis on one segment

### Phase P7: Pipeline Orchestrator + Commands ⬜
- Build `pipeline.ts` — two-stage (fast auto + slow opt-in), status tracking
- Build `/process` command (status, transcribe, analyze, rerun)
- Wire auto-trigger from recording module
- Background execution
- **Verify:** End-to-end test on test recording

### Phase P8: Docker ⬜
- Update Dockerfile: add Python, faster-whisper, ffmpeg, pre-download model
- **Verify:** `docker build` + `docker run` → record + process works

### Parallelization Note
- Phase P1 is foundational — must complete first
- Phases P2-P6 are independent — can run in parallel (agent teams or Task subagents)
- Phase P7 wires everything together — needs P2-P6 complete
- Phase P8 is final integration

---

## Key Files to Modify

| File | Change |
|---|---|
| `src/core/config.ts` | Add processing env vars |
| `src/index.ts` | Register `processingModule` |
| `src/modules/recording/commands/record.ts` | Trigger processing after stop |
| `package.json` | Add `js-yaml`, `@anthropic-ai/sdk` |
| `Dockerfile` | Add Python + faster-whisper + ffmpeg |
| `.env.example` | Add processing config vars |

---

## Verification

**Test session:** `recordings/2e823379-d61a-4283-ac8a-908f4faf5121/` (1.5hr, 4 players, 54MB)

Compare TypeScript pipeline output with Python pipeline output on the same session:
1. Match pairing results (same matches, same confidence)
2. Split audio durations (within 1s)
3. Transcript quality (similar segments, same vocabulary)
4. Analysis report structure
