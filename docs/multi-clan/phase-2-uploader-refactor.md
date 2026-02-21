# Phase 2: Refactor Voice Uploader — Multi-Clan Support

## Context

Phase 1b added the `/register` command and `getRegistrationForGuild()` helper. Now we refactor the upload pipeline to use the bot registration for team identity, stable file naming, and player name resolution.

Read `docs/multi-clan/CONTRACT.md` for the full schema reference.

## What Changes

### Current (PoC)
- Storage path: `voice-recordings/{demoSha256}/{playerName}.ogg`
- Firestore doc: `teamId: ''` (empty), tracks use `playerName` as both filename and display name
- Team identity: hardcoded from `TEAM_TAG` env var
- Player names: hardcoded from `PLAYER_NAME_MAP` env var

### After (Multi-Clan)
- Storage path: `voice-recordings/{teamId}/{demoSha256}/{discordUserId}.ogg`
- Firestore doc: `teamId` populated, `visibility` field, tracks carry `discordUserId` + `resolved` flag
- Team identity: from `getRegistrationForGuild(guildId)` (falls back to env config for unregistered guilds)
- Player names: resolved from team roster → knownPlayers → Discord display name fallback

## Files to Modify

### 1. `src/modules/processing/stages/voice-uploader.ts` — Main Changes

**Update `uploadVoiceRecordings` signature and logic:**

The function currently takes `(segments, teamTag)`. It needs the guild ID to look up the registration. The recording session metadata already includes `guild.id`. Pass it through from the pipeline.

**New flow inside the function:**
```
1. Look up registration: getRegistrationForGuild(guildId)
   - If found: use registration.teamId, registration.teamTag, registration.teamName
   - If not found: fall back to env-based teamTag (backward compat for unregistered guilds)

2. Resolve player names (new — see name resolution section below)

3. For each segment, for each player:
   - Storage path: voice-recordings/{teamId}/{demoSha256}/{discordUserId}.ogg
     (use discordUserId from the track metadata, NOT playerName)
   - Fall back to sanitized Discord username if discordUserId not available

4. Write Firestore manifest with new schema:
   {
     demoSha256,
     teamId: registration.teamId || '',
     teamTag: registration.teamTag || teamTag,
     visibility: <resolved from team settings — see below>,
     source: 'firebase_storage',
     tracks: [{
       discordUserId: player.discordUserId,
       discordUsername: player.discordUsername,
       playerName: resolvedName,        // from name resolution
       resolved: wasResolved,            // true/false
       storagePath: the new path,
       fileName: `${discordUserId}.ogg`,
       size,
       duration,
     }],
     mapName, recordedAt, uploadedAt, uploadedBy, trackCount
   }
```

### 2. `src/modules/processing/types.ts` — Update Player Type

The `SegmentPlayer` type (or equivalent) needs to carry Discord identity info. Check what the audio-splitter stage currently puts on each player object. It likely has `name` and `audioFile`. We need to ensure `discordUserId` and `discordUsername` flow through from the recording session metadata.

If the session metadata (`session_metadata.json`) has `tracks[].discord_user_id` and `tracks[].discord_username`, these should flow through the pipeline to the upload stage.

### 3. `src/modules/processing/pipeline.ts` — Pass Guild ID

The pipeline orchestrator needs to pass the guild ID from the session to the upload stage. Check how session metadata flows through the pipeline and ensure `guildId` reaches `uploadVoiceRecordings`.

### 4. Name Resolution (new logic, can be a helper function)

```typescript
async function resolvePlayerNames(
  registration: BotRegistration | null,
  players: Array<{ discordUserId: string; discordUsername: string }>
): Promise<Map<string, { playerName: string; resolved: boolean }>>
```

**Resolution order:**
1. **Team roster lookup** (if registration exists):
   - Read team doc: `teams/{registration.teamId}`
   - Get `playerRoster[]` → each entry has `userId` (Firebase UID)
   - For each roster member, read user doc: `users/{userId}`
   - Check if `user.discordUserId` matches any recording track
   - If match: use `user.displayName` as the QW name → `resolved: true`

2. **Known players lookup** (if registration exists):
   - Check `registration.knownPlayers[discordUserId]`
   - If found: use stored name → `resolved: true`

3. **Fallback**:
   - Use `discordUsername` from recording → `resolved: false`

**Performance note:** The roster + user doc reads happen once per upload (not per track). Cache the roster lookup for the session. There will be 4-8 players max.

### 5. Visibility Resolution

When uploading, resolve the `visibility` field:

```typescript
// Read team doc to check voiceSettings
const teamDoc = await db.collection('teams').doc(registration.teamId).get();
const voiceSettings = teamDoc.data()?.voiceSettings;
const visibility = voiceSettings?.defaultVisibility || 'private';
```

If no registration exists (unregistered guild fallback), default to `'public'` (backward compat with PoC behavior).

## What NOT to Build Yet

- **Unknown player DM prompt** — Don't implement the backfill DM flow in this phase. Just mark unresolved tracks with `resolved: false`. The DM flow is a follow-up enhancement that can be added later without changing the schema.
- **Anything on MatchScheduler** — Phases 3-5
- **Changes to recording module** — The recording module already captures Discord user IDs in session metadata. Don't modify it.

## Backward Compatibility

- **Unregistered guilds**: If `getRegistrationForGuild()` returns null, fall back to current behavior (use `TEAM_TAG` and `PLAYER_NAME_MAP` from env). This keeps the bot working for ]sr[ during the transition even if they haven't `/register`ed yet.
- **Existing recordings**: Old recordings in Firebase are untouched. The PoC replay page still works with the old path format.

## Data Flow Through Pipeline

Trace how Discord user identity flows from recording to upload:

```
RecordingSession
  tracks[]: { discordUserId, discordUsername, audioFile }
       │
       ▼
session_metadata.json
  tracks[]: { discord_user_id, discord_username, audio_file }
       │
       ▼
Processing pipeline reads session_metadata
       │
       ▼
AudioSplitter outputs per-map segments
  segment.players[]: { name, audioFile, discordUserId?, discordUsername? }
       │
       ▼  ← THIS IS WHERE YOU MAY NEED TO ADD discordUserId/discordUsername
       │     if the splitter doesn't already carry them through
       │
       ▼
VoiceUploader
  - Resolves names via roster/knownPlayers
  - Uploads with discordUserId-based paths
  - Writes Firestore manifest with full track metadata
```

Check each stage to verify the Discord identity fields flow through. The recording module already captures them in `session_metadata.json`. The gap is likely in the audio-splitter or pipeline types that may only pass `name` and `audioFile` without the Discord identity.

## Testing

1. **With registration**: Create a test `botRegistrations/{teamId}` doc in Firestore, run a recording, verify:
   - Storage path uses `voice-recordings/{teamId}/{sha256}/{discordUserId}.ogg`
   - Firestore manifest has `teamId` populated, tracks have `discordUserId` + `resolved`
   - Roster members show resolved QW names

2. **Without registration**: Remove the test doc, verify fallback:
   - Storage path uses `voice-recordings/{sha256}/{playerName}.ogg` (old format)
   - Firestore manifest has `teamId: ''`, tracks use env-based names

3. **Mixed resolution**: Have some players in roster, some not:
   - Roster members: `resolved: true`, correct QW name
   - Unknown players: `resolved: false`, Discord display name used

4. **Compile check**: `npx tsc` passes clean
