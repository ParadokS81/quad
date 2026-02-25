# Incident: Corrupt Opus Packets in Harvarligan Guild Recordings

**Date**: 2026-02-25
**Status**: Open — DAVE passthrough bug identified as likely root cause, mitigation deployed
**Impact**: Audio files from Suddendeath (-s-) recordings are partially corrupt, affecting voice replay playback
**Affected sessions**: Feb 23 (`7344dc4a`) and Feb 24 (`b268cdcb`, `7a8a7647`) — all Harvarligan guild
**Not affected**: Slackers guild recordings from the same evening (session `6ecd5397`) — 100% clean

## Symptoms

Andeh (Suddendeath player) reported:
- Voice replay player only plays carapace's audio after ~30 seconds on phantombase
- e1m2 recording "lagged out about a minute in" and went out of sync
- Fast-forwarding made it worse — eventually only bps's voice audible
- Downloading individual .ogg files: some sound decent, some "corrupt, stopped mid-file"

## Investigation Findings

### 1. ffprobe says files are fine — but they're NOT

All split OGG files pass `ffprobe -show_entries format=duration` with consistent 1210s durations. This is misleading — ffprobe reads OGG container metadata (granule positions), not actual audio content.

### 2. Whisper transcription reveals truncation

Running faster-whisper on the split files shows actual decodable audio is far shorter than container duration:

**Feb 24 — phantombase (HX vs SD, session `7a8a7647`):**

| Track | ffprobe | Whisper duration | Segments |
|-------|---------|-----------------|----------|
| carapace | 1210s | 777s | 50+ |
| Andeh | 1210s | **22s** | 1 |
| goblin tralmaks | 1210s | **48s** | 6 |
| reppie | 1210s | **22s** | 2 |

**Feb 24 — e1m2 (SR vs SD, session `b268cdcb`):**

| Track | ffprobe | Whisper duration | Segments |
|-------|---------|-----------------|----------|
| Andeh | 1210s | **44s** | 2 |
| bps | 1210s | **47s** | 1 |
| carapace | 1210s | **44s** | 2 |
| goblin tralmaks | 1210s | **1210s** | 0 (silent) |
| reppie | 1210s | **48s** | 1 |

**Feb 23 — also corrupted (session `7344dc4a`):**
- dm2: 4/5 tracks truncated (56-174s)
- dm3: 3/5 tracks truncated (441-658s)
- e1m2: 2/5 tracks truncated (18-42s)
- schloss (last map): ALL CLEAN — all 1210s

**Feb 24 — SR session `6ecd5397` — 100% clean:**
All 24 files (4 tracks x 6 maps) show correct 1210s. Zero corruption.

### 3. Full decode reveals corrupt Opus packets

Running `ffmpeg -v error -i file.ogg -f null -` on Andeh's e1m2 file shows:

```
[null] Application provided invalid, non monotonically increasing dts to muxer: 2104320 >= 2103360
[opus] Error parsing the packet header.
[aist#0:0/opus] Error submitting packet to decoder: Invalid data found when processing input
```

These errors appear at DTS ~2104320 samples = **~43.8 seconds** (exactly where whisper stops).
Errors then repeat throughout the entire file — hundreds of corrupt packets.

ffmpeg reaches `time=00:20:18.65` (full file) because it's lenient and skips bad packets.
Stricter decoders (whisper/CTranslate2, browser Web Audio API) stop at first error.

### 4. The splitter is NOT the cause

The audio-splitter uses `ffmpeg -ss X -to Y -i input.ogg -c copy output.ogg`. Since SR files processed with the exact same code are 100% clean, the splitter preserves what's in the source — it doesn't create corruption.

## Key Observations

1. **Guild-specific**: Only Harvarligan guild is affected. Slackers guild (same bot, same code, same server, same evening) is clean.
2. **Recurring**: Both Feb 23 and Feb 24 SD sessions are corrupted.
3. **Not uniform**: Corruption varies by track and map. Later maps tend to be cleaner (schloss on Feb 23 was perfect).
4. **DTS ordering issues**: "non monotonically increasing dts" suggests timestamp/granule position problems in the OGG stream.
5. **Packet header errors**: "Error parsing the packet header" means the Opus frame data itself is garbage — not just timing issues.

## Hypothesis: DAVE Protocol Corruption

Discord's DAVE (Discord Audio & Video E2E Encryption) uses MLS for group key exchange and AES128-GCM for frame encryption. When DAVE does a key rotation or MLS group state change:
- Packets encrypted with the old key get decrypted with the new key (or vice versa)
- Result: garbage data that passes through as "Opus packets" but fails parsing
- @discordjs/voice handles DAVE transparently — our code never sees the encryption layer

Supporting evidence:
- Different guilds = different DAVE groups = different key exchange behavior
- Corruption varies per track (each user has their own DAVE state)
- Later maps being cleaner suggests DAVE stabilizes over time
- SR guild works perfectly = different DAVE group, no issues

## Root Cause Analysis (2026-02-25)

### The DAVE Passthrough Bug

Deep analysis of `@discordjs/voice` 0.19.0 source code (`node_modules/@discordjs/voice/dist/index.js`) revealed a passthrough path in `DAVESession.decrypt()` (line 969):

```javascript
decrypt(packet, userId) {
    const canDecrypt = this.session?.ready && (...);
    if (packet.equals(SILENCE_FRAME) || !canDecrypt || !this.session)
        return packet;  // ← returns ENCRYPTED ciphertext as "Opus"
    // ...
}
```

When `canDecrypt` is false (because `session.ready` is false after an MLS reinit), **the DAVE-encrypted ciphertext is returned unchanged** instead of being dropped. The calling code in `VoiceReceiver.onUdpMessage()` has a null check (`if (packet) stream.push(packet)`) that drops null returns — but the passthrough returns the *actual encrypted bytes*, not null. These ciphertext bytes flow through as "Opus" audio.

#### The sequence during a recording:

1. DAVE key rotation / MLS epoch transition begins
2. Decryption starts failing → `consecutiveFailures` counts up
3. After **36 failures** (default `decryptionFailureTolerance`) → `recoverFromInvalidTransition()` → `reinit()`
4. `session.reinit()` resets the MLS state → `session.ready = false`
5. **Passthrough window opens**: all packets pass through as AES-128-GCM ciphertext → garbage written to OGG
6. New MLS handshake completes → `session.ready = true` → good audio resumes

DAVE-encrypted frames include a `0xFAFA` magic marker at the end (per daveprotocol.com). This is how the packet validator detects passthrough.

#### Why this explains every observation:

| Observation | Explanation |
|---|---|
| Guild-specific | Different DAVE groups = different MLS states/transitions |
| Varies per track | Each user has their own DAVE sender key ratchet |
| Later maps cleaner | DAVE stabilizes; epoch 1 forces unconditional reinit (line 864) |
| "Error parsing packet header" | Ciphertext bytes = random data, not valid Opus TOC |
| "non monotonically increasing dts" | Garbage granule position math from random bytes |
| Slackers guild clean | Different DAVE group, no transitions during those sessions |

### Supporting Evidence from External Research

**discordjs/discord.js Issue #11419**: Open issue confirming voice receiving with DAVE is broken in 0.19.0. Symptoms include reconnect loops, zero audio, and `DecryptionFailed(UnencryptedWhenPassthroughDisabled)` errors. Maintainer vladfrangu: *"Voice receiving has always been on a 'it may work' basis."*

**discordjs/discord.js Issue #11387**: Closed (not planned). `DecryptionFailed(UnencryptedWhenPassthroughDisabled)` errors in DAVE layer. CPU load from child_process spawning exacerbated the issue.

**Pycord Issue #2921 / PR #2925**: Discord adds 8 extra bytes to the beginning of Opus packets after transport decryption. Pycord fixed this; discord.js handles it via RTP header extension stripping (different mechanism, appears to work).

**PR #11100** (merged Dec 2025): Fixed a bug where only one DAVE transition could be tracked at a time. Multiple simultaneous transitions caused state corruption. This fix is in 0.19.0.

**@snazzah/davey**: Zero issues filed. Current version 0.1.9. No known bugs.

### What We Still Don't Have

- **Confirmed correlation**: We need DAVE transition logs alongside corruption timestamps from a live session
- **Upstream fix**: No new `@discordjs/voice` release since 0.19.0. Issue #11419 is still open.
- **Raw source OGG files**: Deleted from affected sessions (now retained post-commit `51a7671`)

## Mitigations Applied

### 1. Opus Packet Validation (track.ts)

Every packet is validated before writing to OGG. Invalid packets are replaced with `SILENT_OPUS_FRAME`:
- Empty packets or packets > 1275 bytes (RFC 6716 max)
- Packets ending with `0xFAFA` (DAVE protocol magic marker = undecrypted ciphertext)
- Invalid TOC byte code=3 (VBR) packets with insufficient header bytes

Corruption stats are logged per track: first occurrence with hex dump, then 30s summaries. Final counts logged on track stop.

**Result**: Users hear brief silence gaps instead of corrupt audio. Files are always valid OGG/Opus.

### 2. DAVE Event Logging During Recording (session.ts)

The voice connection `debug` listener was previously removed after connection reached Ready state (record.ts:255-256), making us blind to mid-recording DAVE transitions. Now a persistent listener in `session.start()` logs all `[DAVE]` events throughout the recording.

### 3. Source File Retention (pipeline.ts)

Raw session OGG files are retained after processing (commit `51a7671`). This allows post-hoc analysis of corruption in the unsplit source files.

## Next Steps

### Immediate: Deploy and Monitor
Deploy the mitigations. Next Harvarligan recording will produce:
- Packet validation stats (corrupt count per track)
- DAVE event logs (transitions, epochs, decryption failures)
- Retained raw OGG files for analysis

### If Corruption Confirmed as DAVE Passthrough
1. **Report upstream**: The passthrough on line 969 should return `null` for `protocolVersion > 0` when `canDecrypt` is false. Passthrough only makes sense for v0 (no E2EE).
2. **Consider patching locally**: `patch-package` to fix the passthrough in `node_modules/@discordjs/voice`.
3. **Tune `decryptionFailureTolerance`**: Lower value = faster reinit = shorter corruption window. But too low could cause unnecessary reinits during normal packet loss.

### Alternative Hypothesis: Concurrent Recording Race
Both guilds record simultaneously. While sessions use separate `Map` entries, there could be shared state in `@discordjs/voice` internals. To test: record in Harvarligan with no concurrent SR recording.

## Files Changed

- `Dockerfile`: Added `nvidia-cublas-cu12`/`nvidia-cudnn-cu12` + `LD_LIBRARY_PATH` for GPU whisper (commit `51a7671`)
- `src/modules/processing/pipeline.ts`: Disabled source file deletion (commit `51a7671`)
- `src/modules/recording/track.ts`: Added Opus packet validation with DAVE passthrough detection
- `src/modules/recording/session.ts`: Added persistent DAVE event logging during recording

## Key File Locations for Investigation

- **OGG muxer**: `src/modules/recording/track.ts` — where Opus packets are written to OGG via prism-media
- **Silence handler**: `src/modules/recording/silence.ts` — generates and inserts silent Opus frames
- **Audio splitter**: `src/modules/processing/stages/audio-splitter.ts` — ffmpeg slice command
- **Voice connection**: `src/modules/recording/session.ts` — DAVE/voice connection setup
- **prism-media**: `node_modules/prism-media/src/opus/OggLogicalBitstream.js` — OGG page structure

## Quick Validation Commands

```bash
# Check a specific track for Opus errors (run on server, inside container or with ffmpeg)
ffmpeg -v error -i recordings/SESSION_ID/TRACK.ogg -f null - 2>&1 | head -20

# Whisper duration check (inside container with LD_LIBRARY_PATH set)
python3 -c "
from faster_whisper import WhisperModel
model = WhisperModel('small', device='auto', compute_type='default')
segs, info = model.transcribe('PATH_TO_FILE.ogg', language='en', vad_filter=True)
count = sum(1 for _ in segs)
print(f'duration={info.duration:.1f}s segments={count}')
"

# Compare all tracks in a processed map
for f in recordings/SESSION/processed/MAP/audio/*.ogg; do
  echo "$(basename $f):"
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"
  ffmpeg -v error -i "$f" -f null - 2>&1 | grep -c "Error parsing"
done
```
