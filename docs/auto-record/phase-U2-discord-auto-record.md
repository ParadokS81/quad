# Phase U2: Discord Auto-Record Engine

> **Model:** Opus
> **Project:** quad
> **Depends on:** U1 (Session Registry)
> **Parallel with:** U3 (Mumble Migration), U5 (MatchScheduler UI)
> **Contract:** `UNIFIED-AUTO-RECORD-CONTRACT.md` at workspace root

---

## Goal

Add auto-record for Discord voice channels. When enough registered team members join a voice channel, the bot automatically joins and starts recording. When they all leave, it stops after a 5-second grace period.

This is the biggest piece of the feature — Discord currently has NO auto-record capability.

---

## Task 1: Extract Reusable Session Start Logic

The current `handleStart()` in `src/modules/recording/commands/record.ts` is tightly coupled to `ChatInputCommandInteraction`. Extract the core recording-start logic into a reusable function that auto-record can call without an interaction object.

### Create exported function:

```typescript
export async function startRecordingSession(opts: {
  voiceChannel: VoiceBasedChannel;
  guild: Guild;
  sourceTextChannelId?: string;
  origin: 'manual' | 'auto';
}): Promise<{ session: RecordingSession; summary: string } | null>
```

This function should:
1. Check if already recording in this guild (`activeSessions`) → return null
2. Check if already joining (`joiningGuilds`) → return null
3. Create RecordingSession
4. Call `session.init()`
5. Call `joinWithRetry()`
6. Register in `activeSessions` and session registry
7. Call `session.start(connection, guild)`
8. Fire start callbacks
9. Return session + summary string, or null on failure

### Refactor `handleStart()`:
Make it a thin wrapper:
1. Validate interaction (user in voice, permissions)
2. Defer reply
3. Call `startRecordingSession({ voiceChannel, guild, sourceTextChannelId, origin: 'manual' })`
4. Reply with result

### Important:
- Keep `joinWithRetry` internal (don't export it — startRecordingSession is the public API)
- The `joiningGuilds` guard and DAVE handshake handling stay exactly as-is
- `session.onConnectionLost` callback should be set by the caller or as part of `startRecordingSession`

---

## Task 2: Discord Auto-Record Engine

Create `src/modules/recording/auto-record.ts` — the Discord auto-record engine.

### Class: DiscordAutoRecord

```typescript
class DiscordAutoRecord {
  // Cached auto-record configs from Firestore (botRegistrations)
  private teamConfigs: Map<string, { teamId: string; knownPlayers: Record<string, string>; autoRecord: AutoRecordSettings }>;

  // Grace timers per guild
  private graceTimers: Map<string, ReturnType<typeof setTimeout>>;

  // Firestore unsubscribe
  private unsubscribe: (() => void) | null;
}
```

### Initialization (`start(client: Client)`)
1. Set up Firestore listener on `botRegistrations` collection where `status === 'active'`
2. Cache each registration's `autoRecord` settings, `knownPlayers`, and `guildId`
3. On snapshot change: update cache (settings may change at any time from MatchScheduler)

### Voice state handler (`onVoiceStateUpdate(oldState, newState)`)

Called from `recording/index.ts` for every voice state change.

**Logic:**
1. Get guildId from the voice state
2. Look up teamConfig for this guild — skip if not found
3. Skip if `autoRecord.enabled === false`
4. Skip if `autoRecord.platform === 'mumble'` (discord not included)
5. Skip if multi-team guild (check: more than one registration for this guildId)
6. Check session registry: if already recording in this guild → handle member tracking only (see step 8)
7. Count registered members in voice channels:
   - Iterate all voice channels in the guild
   - For each non-bot member, check if their user ID is a key in `knownPlayers`
   - Find the channel with the most registered members
8. **If no active recording:**
   - If count >= `minPlayers` AND not suppressed → call `startRecordingSession()` for that channel
   - Register in session registry with `origin: 'auto'`
9. **If active auto-record session:**
   - Count registered members still in the recording channel specifically
   - If count drops to 0 → start 5-second grace timer
   - If count > 0 and grace timer running → cancel it
10. **Grace timer expires:**
    - Call `performStop(guildId, 'auto-record: channel empty')`
    - Clear suppression for this guild in session registry (channel is empty)

### Suppression check
Before starting auto-record, check `sessionRegistry.isSuppressed('discord:' + guildId)`. If suppressed, don't start. Suppression is set by `/record stop` (Phase U4) and cleared when channel empties.

### Edge cases
- **User moves between channels**: Old channel may go empty (grace timer), new channel may meet threshold (start recording there)
- **Bot kicked from voice**: `session.onConnectionLost` already handles this — fires stop callbacks. Auto-record should detect this and not immediately retry (maybe a short cooldown).
- **Settings change mid-recording**: If auto-record is disabled while recording, DON'T stop the current session — let it finish naturally. Only prevent new auto-starts.
- **Manual recording active**: If someone ran `/record start` manually, auto-record should not interfere. The session registry check (step 6) handles this.

### Constants
```typescript
const GRACE_PERIOD_MS = 5_000;  // 5 seconds after last registered member leaves
```

---

## Task 3: Wire Auto-Record into Recording Module

Update `src/modules/recording/index.ts`:

1. Import `DiscordAutoRecord`
2. In `onReady(client)`: instantiate and start the auto-record engine
3. In the `voiceStateUpdate` handler: call `discordAutoRecord.onVoiceStateUpdate(oldState, newState)` AFTER the existing idle timer logic
4. In `onShutdown()`: call `discordAutoRecord.stop()` to clean up Firestore listener and grace timers

### Interaction with existing idle timer
The existing idle timer (30 min) is for manually-started recordings. For auto-record sessions, the 5-second grace period replaces it. The auto-record engine manages its own timers.

To distinguish: check `sessionRegistry.get('discord:' + guildId)?.origin`. If `'auto'`, the auto-record engine handles the lifecycle. If `'manual'`, the existing idle timer handles it.

---

## Files to create
- `src/modules/recording/auto-record.ts`

## Files to modify
- `src/modules/recording/commands/record.ts` (extract `startRecordingSession`)
- `src/modules/recording/index.ts` (wire auto-record engine)

## Files NOT to modify
- `src/modules/mumble/*` (that's U3)
- `src/shared/session-registry.ts` (created in U1, read-only here)

## Verification
- `npm run build` compiles without errors
- Set `autoRecord: { enabled: true, minPlayers: 3, platform: 'both' }` manually on a botRegistration doc in Firestore
- Have 3 team members (in knownPlayers) join a Discord voice channel → bot should auto-join and record
- Have all leave → recording should stop after 5 seconds
- Have someone `/record stop` during auto-record → suppression should prevent restart when they rejoin
- Have channel fully empty → suppression clears → members rejoin → auto-record starts again
