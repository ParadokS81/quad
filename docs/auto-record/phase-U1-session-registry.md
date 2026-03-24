# Phase U1: Session Registry + Pipeline Bug Fix

> **Model:** Sonnet, extended thinking
> **Project:** quad
> **Depends on:** Nothing (prerequisite for all other phases)
> **Contract:** `UNIFIED-AUTO-RECORD-CONTRACT.md` at workspace root

---

## Goal

Create a shared session registry for tracking active recording sessions across Discord and Mumble, and fix the remaining pipeline bug where Mumble recordings crash on null guild access.

---

## Task 1: Session Registry

Create `src/shared/session-registry.ts` — a lightweight in-memory registry that tracks all active recording sessions across both platforms.

### Interface

```typescript
type Platform = 'discord' | 'mumble';
type SessionOrigin = 'manual' | 'auto';

interface RegisteredSession {
  platform: Platform;
  origin: SessionOrigin;
  sessionId: string;
  channelId: string;          // Discord channel ID or Mumble channel ID (as string)
  guildId: string;            // Discord guild ID (for cross-platform lookup by team)
  teamId?: string;            // From botRegistration
  startTime: Date;
  suppressed?: boolean;       // Set when manual stop on auto-started session
}
```

### API

```typescript
// Register/unregister sessions
register(key: string, meta: RegisteredSession): void
unregister(key: string): void

// Query
get(key: string): RegisteredSession | undefined
getByGuildId(guildId: string): RegisteredSession[]    // All sessions for a guild (both platforms)
getByPlatform(platform: Platform): RegisteredSession[]
getAllSessions(): RegisteredSession[]

// Suppression (manual stop of auto-record → suppress until channel empties)
suppress(key: string): void
isSuppressed(key: string): boolean
clearSuppression(key: string): void
```

### Key naming convention
- Discord sessions: `discord:${guildId}` (one recording per guild)
- Mumble sessions: `mumble:${channelId}` (one recording per team channel)

### Notes
- This is a simple `Map<string, RegisteredSession>` with helper methods
- No Firestore persistence needed — in-memory only, rebuilds on restart
- Export a singleton instance
- Keep it minimal — no over-engineering

---

## Task 2: Pipeline Bug Fix

**Bug:** `src/modules/processing/pipeline.ts` lines 206 and 224 use `session.guild!.id` with non-null assertions. Mumble recordings have `guild: null`, so this crashes.

### Fix
- Line 206: `const registrations = await getRegistrationsForGuild(session.guild!.id);`
  - For Mumble recordings, `session.team.teamId` is available directly in session_metadata.json
  - Guard: if `session.guild` is null, skip the guild-based registration lookup and use `session.team.teamId` directly to find the botRegistration

- Line 224: `guildId: session.guild!.id` in a warning log
  - Use `session.guild?.id ?? 'mumble'` or similar safe access

- The pipeline already branches on `session.source === 'mumble'` at line ~181. Extend that branching to skip guild-dependent code.

### Verify
The two other bugs from `docs/mumble/fix-post-review.md` are already fixed:
- `recordingSource` field: already set at voice-uploader.ts line 340
- Auto-record Firestore toggle: already checked at auto-record.ts lines 147-150

Confirm these are fixed and note it in the PR.

---

## Task 3: Wire Registry to Existing Recording

Update `src/modules/recording/commands/record.ts`:
- Import the session registry singleton
- In `handleStart()` (after session is registered in `activeSessions` map ~line 468): also register in session registry with key `discord:${guildId}`, origin `'manual'`
- In `stopRecording()` / `performStop()`: also unregister from session registry
- The existing `activeSessions` map stays as-is — registry is an additional metadata layer

### Do NOT change:
- The `activeSessions` Map (it holds the actual RecordingSession objects)
- The `joinWithRetry` function
- The idle timeout mechanism
- Any of the exported callback APIs

---

## Files to create
- `src/shared/session-registry.ts`

## Files to modify
- `src/modules/processing/pipeline.ts` (bug fix)
- `src/modules/recording/commands/record.ts` (registry integration)

## Verification
- `npm run build` compiles without errors
- Review pipeline.ts to confirm no more non-null assertions on `session.guild`
- Review session-registry.ts for correctness
- Confirm the 2 already-fixed bugs (recordingSource, Firestore toggle) are indeed applied
