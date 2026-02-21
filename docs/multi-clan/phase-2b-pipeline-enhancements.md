# Phase 2b: Pipeline Enhancements — Name Resolution + Silent Track Filtering

## Context

Phase 2 refactored the upload pipeline for multi-clan support. These two independent enhancements improve the quality of uploaded recordings:

1. **Global user lookup** — Resolve player names for standins/guests who have MatchScheduler accounts but aren't on the recording team's roster
2. **Silent track filtering** — Skip uploading tracks from muted spectators who sat in the voice channel but never spoke

Both changes are in the quad processing pipeline. No MatchScheduler changes needed.

Read `docs/multi-clan/CONTRACT.md` for the schema reference.

---

## Enhancement 1: Global User Lookup in Name Resolution

### Current Resolution Chain (voice-uploader.ts)

```
1. Team roster lookup → user docs → match discordUserId → use displayName (resolved: true)
2. knownPlayers map → botRegistration.knownPlayers[discordUserId] (resolved: true)
3. Fallback → use Discord display name (resolved: false)
```

### New Step: Insert Between 2 and 3

```
1. Team roster lookup (unchanged)
2. knownPlayers map (unchanged)
3. NEW → Global user lookup: query users collection by discordUserId
   → If found: use user.displayName as QW name (resolved: true)
4. Fallback → Discord display name (resolved: false)
```

### Implementation

In `resolvePlayerNames()` in `voice-uploader.ts`, after the knownPlayers check and before the fallback, add:

```typescript
// Step 3: Global user lookup — catches standins from other teams
// who have MatchScheduler accounts with discordUserId linked
if (!resolved.has(discordId)) {
  const userSnap = await db.collection('users')
    .where('discordUserId', '==', discordId)
    .limit(1)
    .get();

  if (!userSnap.empty) {
    const userData = userSnap.docs[0].data();
    if (userData.displayName) {
      resolved.set(discordId, {
        playerName: userData.displayName,
        resolved: true,
      });
    }
  }
}
```

### Performance Note

- This runs only for players NOT already resolved by roster or knownPlayers (typically 0-2 standins per recording)
- Single Firestore query per unresolved player — negligible cost
- The `users` collection has ~300 docs — the query is fast
- Consider adding a composite index on `discordUserId` if it doesn't exist (check Firestore console)

### What This Catches

- Standins from other teams who joined the voice channel (e.g., a player from team X standing in for team Y — if they have a MatchScheduler account, we know their QW name)
- Players who linked their Discord account on MatchScheduler but aren't on any team roster
- ~80%+ of the QW community has MatchScheduler accounts, so this dramatically reduces `resolved: false` fallbacks

---

## Enhancement 2: Silent Track Filtering

### Problem

Players who sit in a Discord voice channel but are muted (spectators, AFK, joined late and forgot to leave) produce audio tracks that are effectively silence. These get uploaded and clutter the voice replay with useless tracks. The replay player already has bot-filtering patterns, but silent human tracks still show up.

### Approach: Analyze Full Track Before Splitting

The audio splitter currently runs `ffprobeDuration()` on each track before splitting. Add a **volume analysis** step at the same point — before any map-based splitting. If a track is silent, skip all splits for that player.

This is better than per-map analysis because:
- One FFmpeg pass per player per session (not per map × per player)
- Silent players get skipped entirely — saves split time too
- The full track is already available at this point

### Implementation

**New utility function** (in `audio-splitter.ts` or a shared utils file):

```typescript
interface VolumeStats {
  meanVolume: number;   // dB (e.g., -91.0 for silence, -25.0 for normal speech)
  maxVolume: number;    // dB (e.g., -91.0 for silence, -5.0 for normal speech)
}

async function ffmpegVolumeDetect(audioPath: string): Promise<VolumeStats> {
  // ffmpeg -i input.ogg -af volumedetect -f null -
  // Parses stderr for: mean_volume: -XX.X dB, max_volume: -XX.X dB
  const { stderr } = await execAsync(
    `ffmpeg -i "${audioPath}" -af volumedetect -f null -`
  );

  const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);

  return {
    meanVolume: meanMatch ? parseFloat(meanMatch[1]) : -Infinity,
    maxVolume: maxMatch ? parseFloat(maxMatch[1]) : -Infinity,
  };
}
```

**Silence threshold:**

```typescript
const SILENCE_MAX_VOLUME_DB = -50; // dB — tracks where the loudest moment is below this are considered silent
```

A threshold of -50dB is conservative. Normal speech peaks at -5 to -20dB. Background noise/mic hiss sits around -40 to -60dB. A fully muted track is -91dB or `-inf`. Tune based on real recordings if needed.

**Integration point** — in `splitByTimestamps()`, right after the existing duration probe loop (around line 158):

```typescript
// Existing: probe durations
for (const track of tracks) {
  const dur = await ffprobeDuration(track.audio_file);
  trackDurations.set(track.track_number, dur);
}

// NEW: probe volume levels, mark silent tracks
const silentTracks = new Set<number>();
for (const track of tracks) {
  const stats = await ffmpegVolumeDetect(track.audio_file);
  if (stats.maxVolume < SILENCE_MAX_VOLUME_DB) {
    silentTracks.add(track.track_number);
    logger.info(`Track ${track.discord_username} is silent (max: ${stats.maxVolume}dB), skipping`);
  }
}

// Then in the per-pairing loop, skip silent tracks:
for (const track of sessionTracks) {
  if (silentTracks.has(track.track_number)) continue;
  // ... existing split logic
}
```

### What Happens to Silent Tracks

- **Not split** — no per-map audio files created
- **Not uploaded** — no Storage files, no Firestore track entries
- **Source files kept** — the original full session recording stays on disk untouched
- **Logged** — a log line notes which players were detected as silent
- **Metadata note** — optionally add a `skippedTracks` field to the segment metadata for debugging:
  ```typescript
  skippedTracks: [{ discordUserId, discordUsername, reason: 'silent', maxVolumeDb }]
  ```

### Edge Cases

- **Player who spoke briefly then muted for 95% of the match**: Their `maxVolume` will be above -50dB because of those brief moments. They'll be included. This is correct — they did speak.
- **Player with very quiet mic**: Might be borderline. The -50dB threshold should be safe (quiet mic is still -30 to -40dB typically). If it becomes an issue, lower the threshold.
- **All players silent** (e.g., empty voice channel recorded): All tracks skipped, no recording uploaded. The upload step naturally handles empty segments (no tracks = no Firestore doc).

### Performance

- `ffmpeg -af volumedetect` on a full session track (e.g., 30 minutes of OGG/Opus): ~2-3 seconds per track
- For 8 players: ~16-24 seconds total added to pipeline
- This runs in the pre-split phase (parallel to duration probes if desired)
- Savings: skipping a silent player saves 1 FFmpeg slice + 1 Storage upload per map (typically 3-5 maps per session)

---

## Files to Modify

| File | Change |
|------|--------|
| `src/modules/processing/stages/voice-uploader.ts` | Add global user lookup step in `resolvePlayerNames()` |
| `src/modules/processing/stages/audio-splitter.ts` | Add `ffmpegVolumeDetect()`, silence detection before split loop |
| `src/modules/processing/types.ts` | Optionally add `VolumeStats` type, `skippedTracks` to metadata |

## What NOT to Change

- **Recording module** — Don't modify how audio is captured
- **Pipeline orchestration** (pipeline.ts) — No changes needed, the splitter and uploader handle this internally
- **Upload schema** — The Firestore `voiceRecordings` document doesn't change. Silent tracks simply don't appear in the `tracks[]` array.
- **Existing split logic** — Only adding a pre-filter, not changing how splits work

## Testing

1. **Volume detection**: Run on known recordings. Check that active speakers have maxVolume > -50dB and known silent/muted players have maxVolume < -50dB.
2. **Global user lookup**: Create a test voiceRecording with a standin from another team who has a MatchScheduler account. Verify their QW name is resolved instead of Discord fallback.
3. **Edge case**: Ensure the pipeline doesn't break when all tracks are silent (empty recording).
4. **Compile check**: `npx tsc` passes clean.
