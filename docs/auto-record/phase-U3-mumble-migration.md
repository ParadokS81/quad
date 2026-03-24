# Phase U3: Mumble Auto-Record Migration

> **Model:** Sonnet, extended thinking
> **Project:** quad
> **Depends on:** U1 (Session Registry)
> **Parallel with:** U2 (Discord Auto-Record), U5 (MatchScheduler UI)
> **Contract:** `UNIFIED-AUTO-RECORD-CONTRACT.md` at workspace root

---

## Goal

Migrate Mumble auto-record to read settings from the unified `botRegistrations/{teamId}.autoRecord` instead of `mumbleConfig/{teamId}.autoRecord`. Add minPlayers threshold, change idle timeout from 30 minutes to 5 seconds, and integrate with the shared session registry.

---

## Task 1: Read Settings from botRegistrations

Currently `src/modules/mumble/auto-record.ts` watches `mumbleConfig` for active teams and reads `autoRecord` as a simple boolean from that collection.

### Changes needed:

1. **Add a second Firestore listener** on `botRegistrations` collection (where `status === 'active'`)
   - Cache `autoRecord` settings (enabled, minPlayers, platform, mode) per teamId
   - Also cache `knownPlayers` for the team (used for member counting if needed)

2. **Keep the existing `mumbleConfig` listener** for channel→team mapping
   - Still need `channelId`, `channelName`, `teamTag`, `teamId` from mumbleConfig
   - Remove reliance on `mumbleConfig.autoRecord` boolean

3. **Decision logic** — when checking if auto-record is enabled for a team:
   ```typescript
   const botReg = botRegistrationConfigs.get(config.teamId);
   const autoRecordEnabled = botReg?.autoRecord?.enabled ?? false;
   const platformOk = !botReg?.autoRecord?.platform || ['both', 'mumble'].includes(botReg.autoRecord.platform);

   if (!autoRecordEnabled || !platformOk) {
     // Skip auto-record for this team
     return;
   }
   ```

4. **Backward compatibility**: If `botRegistrations` has no `autoRecord` config for a team BUT `mumbleConfig.autoRecord` is true (not false), fall back to old behavior (treat as enabled with default settings). This handles the transition period.

---

## Task 2: Add minPlayers Threshold

Currently, recording starts when ANY user joins a team channel. Add threshold checking.

### Changes:

In `onUserCreate()` and `onUserUpdate()` (when user moves INTO a team channel):

1. Before calling `ensureRecording()`, count users in the channel:
   ```typescript
   const usersInChannel = getUsersInChannel(channelId);  // Existing helper
   const minPlayers = botReg?.autoRecord?.minPlayers ?? 3;

   if (usersInChannel < minPlayers) {
     // Not enough players yet — still add user to session if recording exists
     // but don't START a new recording
     return;
   }
   ```

2. If a recording already exists (someone started it manually or threshold was previously met), still add the new user to it regardless of threshold.

3. When a new user joins and pushes the count to >= minPlayers, start recording and add ALL users currently in the channel (not just the one who pushed it over).

---

## Task 3: Change Idle Timeout to 5-Second Grace Period

### Changes:

1. Change the constant:
   ```typescript
   // OLD: const IDLE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes
   const GRACE_PERIOD_MS = 5_000;  // 5 seconds
   ```

2. The timer starts when the LAST user leaves the channel (registered member count → 0), not when any user leaves.

3. If a user rejoins during grace → cancel timer (existing pattern, just shorter timeout).

4. When timer fires → stop recording → trigger pipeline callback.

---

## Task 4: Integrate with Session Registry

### Changes:

1. Import session registry singleton from `src/shared/session-registry.ts`

2. In `ensureRecording()` (when creating new session):
   ```typescript
   sessionRegistry.register(`mumble:${channelId}`, {
     platform: 'mumble',
     origin: 'auto',
     sessionId: session.sessionId,
     channelId: String(channelId),
     guildId: botReg?.guildId ?? '',  // Discord guild for cross-platform lookup
     teamId: config.teamId,
     startTime: new Date(),
   });
   ```

3. In `stopRecording()`:
   ```typescript
   sessionRegistry.unregister(`mumble:${channelId}`);
   sessionRegistry.clearSuppression(`mumble:${channelId}`);  // Channel empty = clear suppression
   ```

4. Before starting auto-record, check suppression:
   ```typescript
   if (sessionRegistry.isSuppressed(`mumble:${channelId}`)) {
     return;  // Manual stop suppressed auto-record
   }
   ```

---

## Task 5: Export Functions for Cross-Module Access

Update `src/modules/mumble/index.ts` to export functions that Phase U4 (unified /record command) will call:

```typescript
export function startMumbleRecording(teamId: string): Promise<MumbleRecordingSession | null>
export function stopMumbleRecording(teamId: string): Promise<void>
export function getMumbleChannelUsers(teamId: string): string[]  // Returns usernames in channel
```

These wrap the auto-record engine's internal methods:
- `startMumbleRecording`: Finds the team's channel config, creates a session, adds all current users
- `stopMumbleRecording`: Stops the session for the team's channel
- `getMumbleChannelUsers`: Returns list of usernames currently in the team's Mumble channel (for /record auto-detect)

---

## Files to modify
- `src/modules/mumble/auto-record.ts` (all tasks)
- `src/modules/mumble/index.ts` (Task 5: exports)

## Files NOT to modify
- `src/modules/recording/*` (that's U2)
- `src/shared/session-registry.ts` (created in U1, used read-only)
- `src/modules/mumble/mumble-session.ts` (recording session logic unchanged)
- `src/modules/mumble/voice-receiver.ts` (audio capture unchanged)

## Verification
- `npm run build` compiles without errors
- Set `botRegistrations/{teamId}.autoRecord: { enabled: true, minPlayers: 3, platform: 'both' }` in Firestore
- Mumble auto-record should:
  - NOT start when 1-2 users join (below threshold)
  - START when 3rd user joins
  - STOP 5 seconds after last user leaves (not 30 minutes)
  - RESPECT suppression flag in session registry
  - FALL BACK to mumbleConfig.autoRecord if botRegistrations has no config
