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

## Phase 4: Silence Handling + Track Sync

**Goal**: All tracks are time-aligned to recording start. Silence gaps are handled.

### Steps

1. **Create `src/modules/recording/silence.ts`**
   - Generate a pre-computed silent Opus frame (Opus can encode silence as a very small frame)
   - Use `@discordjs/opus` `OpusEncoder` to encode a buffer of zeros → single silent Opus frame
   - Cache this frame — reuse for all silence insertion

2. **Implement silence padding in `UserTrack`**
   - Option A (real-time): Run a 20ms interval timer per track. If no Opus packet received in the last 20ms, write a silent Opus frame to the OGG stream.
   - Option B (simpler): Don't pad in real-time. Instead, after recording stops, use ffmpeg to pad each track to the full session duration based on timestamps. The OGG file will have gaps but the metadata has timing info.
   - **Try Option A first** — it produces better output (continuous files with no gaps) and matches Craig's behavior.

3. **Implement late-join silence prepend**
   - If a user joins after recording has started: calculate the gap between recording start and their join time
   - Write that many silent Opus frames to their OGG stream before piping real audio
   - This ensures all tracks start at the same time

4. **Implement rejoin handling**
   - If a user leaves and rejoins: reuse their existing `UserTrack`
   - Pause timer was inserting silence while they were gone — they seamlessly resume
   - Update `left_at` → `null` in track metadata, add a `rejoined_at` event (or just keep inserting silence)

5. **Test**:
   - Record with users joining at different times
   - Verify all `.ogg` files have the same duration (within a frame or two)
   - Verify silence where expected (no audio artifacts, no clicks)
   - Verify `ffprobe` duration matches for all tracks

### Files created
```
src/modules/recording/silence.ts
```

### Files modified
```
src/modules/recording/track.ts (silence padding)
src/modules/recording/session.ts (late-join handling)
```

---

## Phase 5: Metadata + Pipeline Compatibility

**Goal**: Bot writes `session_metadata.json` that the voice-analysis pipeline can consume.

### Steps

1. **Create `src/modules/recording/metadata.ts`**
   - Function: `writeSessionMetadata(session: RecordingSession)` → writes JSON to `{outputDir}/session_metadata.json`
   - Include all fields from the schema in CLAUDE.md
   - `recording_id`: generate ULID (install `ulid` package)
   - `source`: `"quad"`
   - `source_version`: read from `package.json`
   - Timestamps: ISO 8601 with millisecond precision, UTC

2. **`docs/session_metadata_schema.json`** — already exists
   - Verify it matches the actual output

3. **Call metadata writer from session stop**
   - `session.stop()` → `writeSessionMetadata(session)` → log summary

4. **Test pipeline compatibility**
   - Copy a Quad recording to `voice-analysis/recordings/raw/`
   - Run `python src/processing/craig_parser.py` on it
   - Verify it parses correctly (after the small update to support `recording_start_time` and `*.ogg`)

### Files created
```
src/modules/recording/metadata.ts
```

### Files modified
```
src/modules/recording/session.ts (call metadata writer)
package.json (add ulid dependency)
```

### Cross-project change (voice-analysis)
```
src/processing/craig_parser.py — glob *.ogg alongside *.flac, alias recording_start_time
```

---

## Phase 6: Error Handling + Robustness

**Goal**: Bot handles edge cases gracefully and doesn't crash on unexpected events.

### Steps

1. **Stream error handling**
   - Handle `ERR_STREAM_PUSH_AFTER_EOF` on Opus streams (known discord.js issue)
   - Handle `error` events on file write streams
   - If a user's stream errors: log warning, close their track cleanly, continue recording others

2. **Voice connection resilience**
   - Handle `VoiceConnectionStatus.Disconnected`: attempt reconnect
   - Handle `VoiceConnectionStatus.Destroyed`: clean up session
   - Set reasonable timeout for reconnection attempts (30 seconds)

3. **Graceful shutdown**
   - Handle `SIGTERM` and `SIGINT` in `core/bot.ts`
   - Call `onShutdown()` on every loaded module → each module cleans up its own state
   - Recording module's `onShutdown`: stop active session → write metadata → close files
   - This is critical for Docker (sends SIGTERM on `docker stop`)

4. **Guard against double-start**
   - If `/record start` is called while already recording: reply with error, don't create second session
   - If `/record stop` is called while not recording: reply with error

5. **Disk space check**
   - On session start: warn if disk has less than 1 GB free
   - Don't hard-fail — just log a warning

6. **Test**: Force-kill bot during recording, verify partial OGG files are valid. Disconnect network briefly, verify reconnection.

### Files modified
```
src/modules/recording/session.ts (error handling, reconnection)
src/modules/recording/track.ts (stream error handling)
src/modules/recording/commands/record.ts (guards)
src/core/bot.ts (SIGTERM → module onShutdown loop)
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
- [ ] All OGG files have same duration (Phase 4)
- [ ] `session_metadata.json` is valid and complete (Phase 5)
- [ ] Bot survives disconnects and force-kills (Phase 6)
- [ ] `docker compose up` works end-to-end (Phase 7)
- [ ] voice-analysis pipeline reads Quad output correctly (Phase 5, cross-project)

## Open Questions (Decide During Implementation)

1. **Silence padding strategy**: Real-time silent frame insertion (Option A) vs post-processing (Option B)? Try A first, fall back to B if it causes issues with OGG stream integrity.

2. **Auto-start/auto-stop**: Should v1 support auto-start when users join a configured channel? Or keep it manual-only via `/record start`? Leaning manual-only for v1.

3. **ULID vs UUID**: ULID is preferred for `recording_id` (time-sortable), but UUID is more standard. ULID is a small dependency. Go with ULID unless there's a reason not to.

4. **Session ID format**: Use the ULID as both `recording_id` and directory name? Or use a human-readable format like `2026-02-03_2108`? ULID for the ID, but directory name could be either.
