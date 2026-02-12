# Quad — Discord Bot for QuakeWorld

## What This Is

A self-hosted Discord bot for the QuakeWorld 4on4 community. Named after Quad Damage, QuakeWorld's signature powerup.

The first module is **voice recording** — per-speaker audio capture that replaces Craig bot. Future modules will add match scheduler integration, community feeds, and other features. To users it feels like one cohesive bot; internally each feature is an independent module.

## Purpose

A single community bot that QW teams self-host via Docker:
- **Recording**: Per-speaker OGG/Opus voice capture → local filesystem
- **Processing**: Auto-pipeline after recording — match detection via QW Hub, per-map audio splitting, optional transcription
- **Standin**: Firestore-based DM feedback loop for MatchScheduler's "Find standin" feature (skips if Firebase not configured)
- **Feeds** (future): Community announcements, match results, Hub integration

### Recording Module — Specific Goals
Replace Craig bot ($5/month, Google Drive export, no control) with:
- Per-speaker OGG/Opus files written directly to the local filesystem
- `session_metadata.json` with standardized timing and track info
- Direct feed into the [voice-analysis](../voice-analysis/) pipeline (or any consumer)

The recording module is **record-only**. No transcription, no analysis, no API queries, no match pairing. It writes files. The downstream pipeline reads them.

## Tech Stack

- **Node.js 22.12.0+** — Required by @discordjs/voice 0.19.0
- **TypeScript 5+**
- **discord.js v14** (14.25.1) — Discord bot framework
- **@discordjs/voice 0.19.0** — Voice connection, audio receive, DAVE protocol support
- **@snazzah/davey** — Peer dependency of @discordjs/voice, must be installed explicitly (`npm install @snazzah/davey`). Rust-based DAVE implementation.
- **@discordjs/opus** — Native Opus codec bindings
- **prism-media 2.0.0-alpha.0** — OGG/Opus muxer (`OggLogicalBitstream`). Requires `node-crc@^1.3.2` for CRC checksums.
- **Docker** — Primary distribution method

## Architecture

### Module System

Quad uses a lightweight module pattern. Each feature is a self-contained module under `src/modules/`. The core bot infrastructure loads modules, collects their commands, and routes events — but modules don't know about each other.

```typescript
// Every module exports this interface
interface BotModule {
  name: string;
  commands: SlashCommandBuilder[];          // Slash commands this module provides
  registerEvents(client: Client): void;     // Discord event listeners
  onReady?(client: Client): Promise<void>;  // Called when bot is online
  onShutdown?(): Promise<void>;             // Called on graceful shutdown (SIGTERM)
}
```

The module loader in `core/bot.ts`:
1. Imports each module from `src/modules/*/index.ts`
2. Collects all commands → registers with Discord in one batch
3. Routes `interactionCreate` to the right module based on command name
4. Calls lifecycle hooks (`onReady`, `onShutdown`) for all modules

This keeps things simple — no plugin framework, no dynamic loading, no dependency injection. Just directories, an interface, and a loop.

### Recording Flow

```
Discord voice channel (per-user Opus streams over UDP)
    │
    ▼
@discordjs/voice decrypts + demuxes (per-user SSRC)
    │
    ▼
receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } })
    │
    ▼
Per-user Opus stream (stays open for entire session)
    │
    ├── Opus packet → prism-media OggLogicalBitstream → fs.createWriteStream()
    │                  (no transcoding — Opus passthrough into OGG container)
    │
    └── Silence gap → insert silent Opus frames (or track timestamps for post-processing)
    │
    ▼
On stop: close all streams, finalize OGG files, write session_metadata.json
```

### Key Design Decisions (Non-Negotiable)

1. **OGG/Opus, NOT FLAC** — Discord sends lossy Opus (~96kbps). Storing as FLAC decodes and re-encodes, bloating files 15-20x for zero quality gain. OGG/Opus wraps the original Opus frames without transcoding. ~5-8 MB/hour/speaker vs ~100-150 MB/hour/speaker.

2. **Stream to disk, NOT buffer in memory** — Sessions can be 3+ hours with 5 speakers. Streaming means near-zero memory, crash recovery (partial files are valid OGG), and no data loss from process restarts.

3. **EndBehaviorType.Manual, NOT AfterSilence** — Keep the per-user audio stream open for the entire recording session. Do NOT create a new file every time a user pauses. One continuous OGG file per speaker, silence-padded.

4. **selfDeaf: false, selfMute: true** — The bot must hear (receive audio) but should not transmit.

5. **Modular architecture** — Each feature is a self-contained module. Modules share the Discord client and core utilities but are otherwise independent. New features never require modifying existing modules.

### Silence Handling

When a user is not speaking, Discord sends no packets (VAD/silence suppression). The bot must handle this:

**Option A (preferred): Insert silent Opus frames in real-time**
- Generate pre-computed silent Opus frames (Opus can encode silence efficiently)
- On a timer (e.g., every 20ms matching Opus frame duration), if no packet received from a user, write a silent frame to their OGG stream
- Result: continuous OGG files with natural silence, perfectly synchronized

**Option B (simpler, may be sufficient): Timestamp-based post-processing**
- Record first-packet and last-packet timestamps per user
- Write `joined_at` and `left_at` to metadata
- Let the downstream pipeline (or ffmpeg) pad silence based on timing
- Simpler bot code, but consumers must handle alignment

**Reference implementation**: Kirdock's `replay-readable.utils.ts` has clean silence gap detection (`addSilentTime()`, `syncStream()`). Study this for the algorithm, but our implementation streams to disk instead of buffering.

### Track Synchronization

All tracks aligned to a common recording start time:
- `recording_start_time`: ISO 8601 UTC with millisecond precision
- Each user's OGG file starts at recording start (silence-padded if they joined late)
- Each user's OGG file ends at recording stop

This matches Craig's behavior and what the voice-analysis pipeline expects.

## Output Format

### Directory structure
```
recordings/{session_id}/
├── session_metadata.json
├── 1-{username}.ogg
├── 2-{username}.ogg
├── 3-{username}.ogg
└── ...
```

### session_metadata.json — Public Contract

This schema is a **public contract** designed for interoperability across teams and future QW Hub integration. See `docs/session_metadata_schema.json` for the full spec.

```json
{
  "schema_version": 1,
  "recording_start_time": "2026-02-01T21:08:18.330000+00:00",
  "recording_end_time": "2026-02-01T23:24:52.117000+00:00",
  "recording_id": "01JKXYZ...",
  "source": "quad",
  "source_version": "1.0.0",
  "guild": { "id": "1234567890", "name": "Slackers" },
  "channel": { "id": "9876543210", "name": "1" },
  "team": { "tag": "]sr[", "name": "Slackers" },
  "tracks": [
    {
      "track_number": 1,
      "discord_user_id": "123456789",
      "discord_username": "paradoks",
      "discord_display_name": "ParadokS",
      "joined_at": "2026-02-01T21:08:18.330000+00:00",
      "left_at": "2026-02-01T23:24:52.117000+00:00",
      "audio_file": "1-paradoks.ogg"
    }
  ]
}
```

Key fields:
- `schema_version` — for forward compatibility as the format evolves
- `recording_start_time` / `recording_end_time` — UTC, ms precision. Needed for Hub match pairing.
- `recording_id` — ULID preferred (time-sortable)
- `source` — identifies this as Quad output (vs `"craig"` for Craig exports)
- `team.tag` — QW team tag, configured per bot instance. Essential for match pairing.
- `tracks[].joined_at/left_at` — when users were actually present in the channel
- `tracks[].audio_file` — explicit filename reference, no guessing

### Audio file properties

| Property | Value |
|----------|-------|
| Container | OGG |
| Codec | Opus (passthrough from Discord) |
| Sample rate | 48000 Hz |
| Channels | 2 (stereo) |
| Bitrate | ~96 kbps (Discord default) |
| Size | ~5-8 MB per hour per speaker |
| Duration | Full recording (silence-padded) |

## Bot Commands

### Recording Module
- `/record start` — joins the invoker's voice channel, starts recording
- `/record stop` — stops recording, saves files, leaves channel
- `/record status` — (future) shows recording duration, users, file sizes

### Scheduler Module (future)
- `/match next` — show upcoming scheduled matches
- `/match remind` — set reminders for a match
- Auto-record: bot joins voice channel when a scheduled match starts

### Feeds Module (future)
- `/feed subscribe` — subscribe a text channel to a feed (match results, news, etc.)
- Hub integration: post match results, link to demos

## Configuration

Environment variables (Docker-friendly):
- `DISCORD_TOKEN` — bot token (required)
- `RECORDING_DIR` — output directory (default: `./recordings`)
- `TEAM_TAG` — QW team tag for metadata (default: none)
- `TEAM_NAME` — team display name (default: guild name)
- `LOG_LEVEL` — debug/info/warn/error (default: `info`)
- `HEALTH_PORT` — health endpoint port (default: `3000`)
- `ANTHROPIC_API_KEY` — for Claude analysis (optional)
- `WHISPER_MODEL` — tiny/base/small/medium/turbo (default: `small`)
- `PLAYER_QUERY` — QW Hub player search term
- `PLAYER_NAME_MAP` — comma-separated `discord:QWName` pairs
- `PROCESSING_AUTO` — auto-run fast pipeline after recording (default: `true`)
- `PROCESSING_TRANSCRIBE` — auto-run transcription (default: `false`)
- `PROCESSING_INTERMISSIONS` — extract between-map discussion (default: `true`)

## Project Structure

```
quad/
├── CLAUDE.md              # This file — codebase instructions
├── DEPLOYMENT.md          # Server access, deploy workflow, troubleshooting
├── PLAN.md                # Implementation plan
├── package.json
├── tsconfig.json
├── Dockerfile             # Multi-stage: build (tsc) + runtime (node + ffmpeg + whisper)
├── docker-compose.yml     # Production config with GPU reservation
├── .env.example
├── docs/
│   ├── session_metadata_schema.json
│   └── standin-flow/
│       └── design.md      # Standin feature design (shared contract with MatchScheduler)
├── scripts/
│   └── transcribe.py      # Whisper transcription script (called by processing module)
├── src/
│   ├── index.ts           # Entry point — bootstrap and start
│   ├── core/
│   │   ├── bot.ts         # Discord client setup, module loader, command router
│   │   ├── config.ts      # Environment variable parsing
│   │   ├── health.ts      # HTTP health endpoint
│   │   ├── logger.ts      # Structured logging
│   │   └── module.ts      # BotModule interface definition
│   ├── modules/
│   │   ├── recording/     # Voice recording module
│   │   │   ├── index.ts   # Module entry — exports commands, events, lifecycle
│   │   │   ├── commands/
│   │   │   │   └── record.ts  # /record start|stop handler
│   │   │   ├── session.ts     # RecordingSession class — manages one recording
│   │   │   ├── track.ts       # UserTrack class — per-user OGG stream
│   │   │   ├── silence.ts     # Silent Opus frame generation
│   │   │   └── metadata.ts    # session_metadata.json writer
│   │   ├── processing/    # Auto-processing pipeline (match detection, audio splitting)
│   │   │   ├── index.ts
│   │   │   ├── pipeline.ts    # Pipeline orchestrator (fast + full modes)
│   │   │   ├── commands/
│   │   │   │   └── process.ts # /process command
│   │   │   ├── stages/        # Pipeline stages (hub-query, match-pairer, audio-splitter, etc.)
│   │   │   └── knowledge/     # QW map/team knowledge YAMLs (runtime, not compiled)
│   │   └── standin/       # Find standin DM feedback loop (Firestore-based)
│   │       ├── index.ts   # Module entry — event-driven, no slash commands
│   │       ├── types.ts   # Firestore schema types
│   │       ├── firestore.ts   # Firebase Admin SDK init
│   │       ├── listener.ts    # onSnapshot listener for standin requests
│   │       ├── dm.ts          # Discord embed + button builders
│   │       └── interactions.ts # Button click handlers
│   └── shared/            # Utilities used across multiple modules
└── recordings/            # Default output dir (gitignored, volume-mounted in Docker)
```

## Downstream Consumer: voice-analysis Pipeline

The [voice-analysis](../voice-analysis/) pipeline reads our output. Key compatibility:
- `craig_parser.py` needs a small update: read `recording_start_time` (alias to internal `start_time`), glob `*.ogg` alongside `*.flac`
- `timestamp_splitter.py`, `transcriber.py`, `analyzer.py` — unchanged. They work on audio files + timing, format-agnostic.
- `session_metadata.json` is the bridge: same concept as Craig's `info.txt` + `raw.dat`, but cleaner schema.

## DAVE Protocol

Discord Audio & Video End-to-End Encryption. **Mandatory by March 1, 2026.**
- `@snazzah/davey` is bundled with `@discordjs/voice` 0.19.0 — handles DAVE transparently
- Uses MLS (Messaging Layer Security) for group key exchange, AES128-GCM for frame encryption
- The bot developer does not interact with DAVE APIs directly — it's handled at the voice connection layer
- Exception: Discord Stage channels use transport encryption only (not E2EE)
- **Caveat**: Discord does not officially support bots receiving audio. The discord.js team supports it "reasonably" but warns of potential breakages. This has been the case for years and recording bots continue to work.

## Reference Code

When implementing, reference these existing projects for patterns (do NOT use them as dependencies):

### Tier 1 — Direct references
- **discord.js official voice recorder example**: https://github.com/discordjs/voice-examples — canonical pattern for `receiver.subscribe()` → OGG → file. Uses `AfterSilence` (we change to `Manual`).
- **Kirdock/discordjs-voice-recorder**: https://github.com/Kirdock/discordjs-voice-recorder — best reference for silence handling. Key files: `src/replay-readable.ts`, utility functions `addSilentTime()`, `syncStream()`, `getMinStartTime()`. Outputs MP3 (we adapt for OGG/Opus passthrough).

### Tier 2 — Architectural reference
- **CraigChat/craig**: https://github.com/CraigChat/craig — the gold standard for multi-track Discord recording output. Uses Eris (not discord.js), no DAVE support. Complex architecture (PostgreSQL, Redis, web dashboard). Reference for output format, not code.
- **SoTrxII/Pandora**: https://github.com/SoTrxII/Pandora — good separation of recording vs processing. Uses Eris, no DAVE. Actively maintained (v3.0.1, Jan 2026).

### Core recording pattern
```typescript
// The core pattern — subscribe → OGG mux → file
const opusStream = receiver.subscribe(userId, {
  end: { behavior: EndBehaviorType.Manual },
});
const oggStream = new prism.opus.OggLogicalBitstream({
  opusHead: new prism.opus.OpusHead({
    channelCount: 2,
    sampleRate: 48000,
  }),
  pageSizeControl: { maxPackets: 10 },
  crc: true,
});
pipeline(opusStream, oggStream, fs.createWriteStream(filename));
```

### OGG Muxing — Why prism-media v2 Alpha + Fallback Options

We use `prism-media@2.0.0-alpha.0` for OGG/Opus muxing. It's been "alpha" since ~2021 but is the de facto standard across the discord.js ecosystem — the discord.js team uses it in their own recorder example. v1.3.5 only has OGG *demuxers* (readers); the *muxer* (`OggLogicalBitstream`, `OpusHead`) is v2 only.

CRC checksums require `node-crc@^1.3.2` (must be v1, CJS — v3+ is ESM-only and breaks). Pass `crc: true` to `OggLogicalBitstream`. Without valid CRC, ffprobe/ffmpeg reject the files.

**If prism-media v2 ever breaks, these are the fallback options:**
1. **Custom OGG muxer** (~100-150 lines) — OGG page format is simple and well-documented. The prism-media author wrote a guide: https://gist.github.com/amishshah/68548e803c3208566e36e55fe1618e1c
2. **ffmpeg pipe** — `spawn('ffmpeg', ['-f', 'opus', '-i', 'pipe:0', '-c', 'copy', 'output.ogg'])`. Rock-solid but adds a process per speaker and a system dependency.
3. **Raw capture + post-process** — What Craig and Pandora do. Dump raw Opus packets with timestamps, mux into OGG later. More complex, only worth it if we need two-phase processing.

## Deployment — Xerial's Server

Full reference: see `DEPLOYMENT.md` in repo root.

### Server Details
- **Host**: `83.172.66.214`, port `5555`
- **User**: `qwvoice`
- **SSH key**: `~/.ssh/qwvoice_key`
- **GPU**: NVIDIA RTX 4090 (24GB VRAM) — GPU-accelerated whisper with `device="auto"`
- **Quad repo**: `/srv/qwvoice/quad/` (owned by `qwvoice`)
- **Recordings**: `/srv/qwvoice/quad/recordings/` (volume-mounted, survives rebuilds)
- **Other services**: `qwvoice-whisper` + `ollama` at `/srv/qwvoice/docker/` (independent)

### SSH Access (full bash shell)
```bash
ssh -i ~/.ssh/qwvoice_key -p 5555 qwvoice@83.172.66.214
```

**Important**: Use `wsl bash -c` (NOT `-ic`) for SSH commands from the Windows/WSL environment:
```bash
wsl bash -c "ssh -i ~/.ssh/qwvoice_key -p 5555 qwvoice@83.172.66.214 'command here'"
```

### Sudo Permissions (NOPASSWD)
```bash
sudo docker compose *              # Full compose control (up, down, logs, ps, exec, build)
sudo docker images                 # List images
sudo docker image prune -f         # Clean up dangling images
```

The `qwvoice` user is NOT in the `docker` group — all docker commands require `sudo`.

### Deploy Workflow (self-service, no Xerial needed)

```bash
# 1. Develop locally
/build                    # Compile TypeScript
/dev                      # Test with real Discord connection

# 2. Commit and push
git add ... && git commit && git push

# 3. Deploy (one command)
wsl bash -c "ssh -i ~/.ssh/qwvoice_key -p 5555 qwvoice@83.172.66.214 \
  'cd /srv/qwvoice/quad && git pull && sudo docker compose up -d --build'"
```

Docker layer caching makes rebuilds fast (~15-30s) when only source code changed.

### Common Server Operations
```bash
# View logs (live)
ssh ... 'sudo docker compose -f /srv/qwvoice/quad/docker-compose.yml logs -f quad'

# View recent logs
ssh ... 'sudo docker compose -f /srv/qwvoice/quad/docker-compose.yml logs --tail=50 quad'

# Check status
ssh ... 'sudo docker compose -f /srv/qwvoice/quad/docker-compose.yml ps'

# Restart (no rebuild — only picks up .env changes)
ssh ... 'sudo docker compose -f /srv/qwvoice/quad/docker-compose.yml restart quad'

# Edit .env on server
ssh ... 'nano /srv/qwvoice/quad/.env'

# Download recordings
scp -i ~/.ssh/qwvoice_key -P 5555 -r 'qwvoice@83.172.66.214:/srv/qwvoice/quad/recordings/SESSION_ID/processed/*' /tmp/
```

### Notes
- Xerial manages OS-level config (sudoers, firewall, NVIDIA drivers). Routine deploys are self-service.
- The bot is `Quake.World#7716` on Discord
- Recordings are volume-mounted — they persist across container rebuilds
- The `docker-compose.yml` includes GPU reservation — container won't start without NVIDIA GPU
- For local dev without GPU, create `docker-compose.override.yml` (gitignored)

## Development Workflow

### WSL Development Environment

**Setup:** Windows VSCode + Claude Code extension, with WSL Ubuntu project folder.

#### Command Execution Rules
Use `wsl bash -ic` (interactive) for npm/node commands so nvm loads properly:

**Simple commands work directly:**
```bash
git status              # Works
bash scripts/foo.sh     # Works
cat / ls / grep         # Works
```

**For npm/node commands, use interactive bash (`-ic` flag is critical):**
```bash
wsl bash -ic "cd /home/paradoks/projects/quake/quad && npm run build"
wsl bash -ic "cd /home/paradoks/projects/quake/quad && npm start"
wsl bash -ic "cd /home/paradoks/projects/quake/quad && npx tsc --noEmit"
```

The `-ic` flag runs bash in interactive mode, which loads `.bashrc` and nvm. Without it, `node`/`npm`/`npx` won't be found.

#### Slash Command Skills
Use these instead of running commands manually:
- **`/build`** — Compile TypeScript (`npx tsc --noEmit`). Use after writing or editing any `.ts` file.
- **`/dev`** — Start the bot locally for testing. Loads `.env` and runs with ts-node ESM loader.

### Rules for Claude
- Always compile (`npx tsc --noEmit`) after writing or editing TypeScript files
- Follow the `BotModule` interface exactly — don't extend it without updating `core/module.ts`
- Recording module code stays in `src/modules/recording/` — never leak into `core/`
- Don't create stub modules for future features (scheduler, feeds) — only build what's needed now
- When adding a new file, check CLAUDE.md Project Structure to see where it belongs
- When modifying the `BotModule` interface, update all existing modules

### Package version constraints
- `prism-media` must be 2.0.0-alpha.0 — v1.3.5 only has demuxers, the OGG *muxer* (`OggLogicalBitstream`) is v2 only. Requires `node-crc@^1.3.2` (CJS version — v3+ is ESM-only and breaks).
- `@discordjs/voice` must be >= 0.19.0 (DAVE protocol support)
- `@snazzah/davey` is bundled — never install it separately
- Node.js must be >= 22.12.0 (required by @discordjs/voice 0.19.0)

### Permissions
- Only users currently in the voice channel can `/record start`
- Any user in the channel can `/record stop` (don't gate on who started it)

## Non-Negotiable Rules

1. OGG/Opus passthrough — never transcode Discord audio to FLAC/WAV/MP3
2. Stream to disk — never buffer entire sessions in memory
3. One continuous file per speaker per session — never fragment into per-utterance files
4. `session_metadata.json` is the public contract — schema changes require version bump
5. All timestamps UTC with millisecond precision
6. Track numbering matches filename: track 1 = `1-{username}.ogg`
7. Recording must be idempotent — re-joining same session appends, doesn't overwrite
8. Raw recordings are gitignored — never commit audio files

## QuakeWorld Context

This bot is built for the QW 4on4 community:
- 4 players per team, 20-minute maps, typically 3-5 maps per session (1-2 hours)
- Team: **]sr[** (Slackers) — ParadokS, Razor, zero, grisling + standins
- Sessions happen on Discord voice channels during practice/matches
- Recordings feed into AI analysis of team communication patterns
- Long-term vision: multiple QW teams use this, recordings paired to Hub matches, voice comms embedded on match pages at hub.quakeworld.nu

---

## Bug Triage Protocol

**When hitting a bug or unexpected behavior, follow this sequence strictly. Do NOT skip to "fix".**

1. **Reproduce** - Confirm the exact steps that trigger it. If you can't reproduce it, you don't understand it yet.
2. **Localize** - Narrow down WHERE. Which file, function, stream, or data flow? Use console logs, check Discord events, read the relevant code.
3. **Reduce** - Strip it to the smallest case. Is it a data issue? A timing issue? A race condition? A wrong parameter?
4. **Fix** - Apply the smallest change that resolves the root cause. Not a workaround, not a band-aid.
5. **Guard** - Ask: can this class of bug happen elsewhere? Check similar patterns in the codebase.
6. **Verify** - Confirm the fix works AND didn't break the surrounding flow.

**Common traps:**
- Jumping to step 4 without localizing (most frequent AI mistake)
- Fixing symptoms instead of root cause (e.g., adding a null check instead of asking why it's null)
- Over-fixing by refactoring surrounding code that wasn't broken

## Testing Philosophy

**After implementing a feature:**
1. Compile first (`npx tsc --noEmit`)
2. Manual test with a real Discord bot connection
3. Fix issues through iteration (1-2 rounds is normal)
4. Only write automated tests if specifically requested

Do NOT write automated tests immediately after implementing. Get the feature working first.

## Common AI Mistakes to Avoid

1. **Over-engineering** - This is a community bot, not enterprise software. Keep it simple.
2. **Jumping to fix without understanding** - Follow the Bug Triage Protocol above
3. **Creating unnecessary abstractions** - Three similar lines > a premature abstraction
4. **Building for hypothetical futures** - Don't stub out scheduler/feeds modules until they're needed
5. **Fixing symptoms** - Adding null checks instead of understanding why something is null
6. **Over-fixing** - Refactoring code around the bug that wasn't broken
7. **Forgetting WSL `-ic` flag** - npm/node commands will silently fail without it
