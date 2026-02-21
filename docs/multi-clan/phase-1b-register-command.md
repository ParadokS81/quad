# Phase 1b: /register Command — Complete Pending Bot Registration

## Context

We're building multi-clan voice replay. The registration flow is initiated from MatchScheduler (Phase 1a) where a team leader creates a pending `botRegistrations/{teamId}` document. This phase implements the `/register` command in quad that completes that pending registration by linking the Discord server.

The leader has already:
1. Clicked "Connect Voice Bot" in their MatchScheduler team settings
2. A `botRegistrations/{teamId}` doc exists with `status: 'pending'` and their `authorizedDiscordUserId`
3. Invited the bot to their Discord server via the invite link
4. Now they run `/register` to complete the loop

## What to Build

### 1. New Slash Command: `/register`

Add a `/register` command to the bot. This can be either:
- A new lightweight `registration` module following the existing BotModule pattern, OR
- Added to the `standin` module since it already has Firebase/Firestore access

The command takes no arguments.

### 2. Registration Flow

When a user runs `/register`:

1. **Get Discord user ID** from `interaction.user.id` (string, numeric Discord ID)

2. **Find their pending registration** — Query Firestore:
   ```typescript
   db.collection('botRegistrations')
     .where('authorizedDiscordUserId', '==', interaction.user.id)
     .where('status', '==', 'pending')
     .limit(1)
     .get()
   ```

3. **Handle results:**

   **No pending registration found:**
   Reply ephemerally: "No pending registration found. Start the setup from your team settings on MatchScheduler: {SCHEDULER_URL}"

   **Pending registration found:**
   - Check if this guild already has an active registration (query where `guildId == interaction.guildId` and `status == 'active'`). If yes, warn: "This server is already linked to **{otherTeamName}**. Disconnect that team first."
   - Update the document:
     ```typescript
     await registrationRef.update({
       guildId: interaction.guildId,
       guildName: interaction.guild?.name || 'Unknown',
       status: 'active',
       activatedAt: new Date(),
       updatedAt: new Date(),
     });
     ```
   - Reply ephemerally: "This server is now linked to **{teamName}** ({teamTag}). Voice recordings from this server will be associated with your team."

### 3. Re-running /register on Active Guild

If `/register` is run in a guild that already has an active registration:
- Show current status: "This server is linked to **{teamName}** ({teamTag}). To change, disconnect from team settings on MatchScheduler first."

### 4. Firestore Access

The bot already initializes Firebase Admin SDK in `src/modules/standin/firestore.ts` with a singleton pattern. Reuse `getDb()` from there. No new Firebase initialization needed.

The `botRegistrations` collection is in the same Firestore database (`matchscheduler-dev`) that the standin module already accesses.

### 5. Helper: Get Registration for Current Guild

Add an exported utility function that other modules can use (Phase 2 will need this for the upload pipeline):

```typescript
export interface BotRegistration {
  teamId: string;
  teamTag: string;
  teamName: string;
  guildId: string;
  guildName: string;
  knownPlayers: Record<string, string>;  // discordUserId → QW name
}

// Get the active bot registration for a guild, or null if not registered
export async function getRegistrationForGuild(guildId: string): Promise<BotRegistration | null> {
  const db = getDb();
  const snap = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();
  return {
    teamId: data.teamId,
    teamTag: data.teamTag,
    teamName: data.teamName,
    guildId: data.guildId,
    guildName: data.guildName,
    knownPlayers: data.knownPlayers || {},
  };
}
```

This should be exported from wherever the registration logic lives (module or shared utility), since the processing pipeline will need it in Phase 2.

## Firestore Schema for Reference

### `/botRegistrations/{teamId}` (created by MatchScheduler, completed by this command)

**Before /register (created by MatchScheduler):**
```typescript
{
  teamId: "team-sr-001",              // = document ID
  teamTag: "]sr[",
  teamName: "Slackers",
  authorizedDiscordUserId: "224649203983450122",  // ← we match on this
  registeredBy: "firebase-uid-of-leader",
  guildId: null,                      // ← not yet linked
  guildName: null,
  status: 'pending',                  // ← we look for this
  knownPlayers: {},
  createdAt: Timestamp,
  activatedAt: null,
  updatedAt: Timestamp,
}
```

**After /register (updated by this command):**
```typescript
{
  // ... all above fields unchanged, plus:
  guildId: "918587029678338090",       // ← populated
  guildName: "Slackers",              // ← populated
  status: 'active',                   // ← changed
  activatedAt: Timestamp,             // ← set
  updatedAt: Timestamp,               // ← updated
}
```

## What NOT to Touch

- Do NOT modify the recording module or processing pipeline (that's Phase 2)
- Do NOT modify voice-uploader.ts (that's Phase 2)
- Do NOT add any MatchScheduler-side changes (that's Phase 1a and beyond)
- Do NOT change the existing standin module behavior

## Testing

1. **Manually create** a pending registration in Firestore to test without needing Phase 1a deployed:
   ```javascript
   // In Firebase console or via a test script:
   db.collection('botRegistrations').doc('test-team-001').set({
     teamId: 'test-team-001',
     teamTag: ']sr[',
     teamName: 'Slackers',
     authorizedDiscordUserId: '224649203983450122',  // Your Discord ID
     registeredBy: 'dev-user-001',
     guildId: null,
     guildName: null,
     status: 'pending',
     knownPlayers: {},
     createdAt: new Date(),
     activatedAt: null,
     updatedAt: new Date(),
   });
   ```

2. Run `/register` in Discord → should find the pending registration and complete it
3. Check Firestore → document should now have guildId, guildName, status: 'active'
4. Run `/register` again → should show "already linked" message
5. Delete the test document and run `/register` → should show "no pending registration" message
6. Test with a different Discord user → should not find the pending registration (wrong authorizedDiscordUserId)
