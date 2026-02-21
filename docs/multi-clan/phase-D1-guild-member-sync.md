# Phase D1: Guild Member Sync — quad Side

## Context

MatchScheduler needs access to the Discord server member list so team leaders can add Discord members to their roster as phantom players. quad already connects to Discord guilds via the registration flow and has the `GuildMembers` intent enabled. This phase adds a guild member cache to Firestore that quad keeps fresh.

Read `docs/multi-clan/CONTRACT.md` for the full Discord Roster Management contract. The canonical version is at the orchestrator level in `DISCORD-ROSTER-CONTRACT.md`.

---

## What Changes

1. **On `/register` completion** — write `guildMembers` map to `botRegistrations/{teamId}` alongside existing `knownPlayers`
2. **On `guildMemberAdd` event** — add new member to the cache
3. **On `guildMemberRemove` event** — remove member from the cache
4. **On bot startup** — refresh the cache for all active registrations

---

## New Field on `botRegistrations/{teamId}`

```typescript
interface GuildMemberEntry {
  username: string;          // Discord username (unique handle, e.g. "paradoks")
  displayName: string;       // Server nick or global display name (e.g. "ParadokS")
  avatarUrl: string | null;  // Full Discord CDN URL (128px) or null for default avatar
  isBot: boolean;            // true for bot accounts — MatchScheduler filters these from UI
}

// Added to existing BotRegistrationDocument:
guildMembers: {
  [discordUserId: string]: GuildMemberEntry;
}
```

**Size:** ~20 members per clan server, ~200 bytes each = ~4KB per team. Well within Firestore's 1MB doc limit.

---

## Files to Modify

### 1. `src/modules/registration/register.ts`

#### New helper: `buildGuildMembersCache()`

Add alongside the existing `buildKnownPlayers()` function:

```typescript
interface GuildMemberEntry {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isBot: boolean;
}

async function buildGuildMembersCache(guild: Guild): Promise<Record<string, GuildMemberEntry>> {
  const members = await guild.members.fetch();
  const cache: Record<string, GuildMemberEntry> = {};

  for (const [id, member] of members) {
    // Skip self (the bot)
    if (member.user.id === guild.client.user?.id) continue;

    cache[id] = {
      username: member.user.username,
      displayName: member.displayName,  // server nick falls back to global display name
      avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      isBot: member.user.bot,
    };
  }

  return cache;
}
```

#### Update registration completion

In the `/register` command handler, where the bot updates the registration doc to `status: 'active'`, add `guildMembers` to the write. Find the section that currently writes:

```typescript
await registrationRef.update({
  guildId: interaction.guildId,
  guildName: interaction.guild.name,
  status: 'active',
  knownPlayers,
  // ...other fields
});
```

Add the guild members cache:

```typescript
const guildMembers = await buildGuildMembersCache(interaction.guild);

await registrationRef.update({
  guildId: interaction.guildId,
  guildName: interaction.guild.name,
  status: 'active',
  knownPlayers,
  guildMembers,  // NEW
  // ...other fields
});
```

---

### 2. New file: `src/modules/registration/guild-sync.ts`

Handles real-time guild member events and startup refresh.

```typescript
import { Client, Events, GuildMember, PartialGuildMember } from 'discord.js';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';

const db = getFirestore();

/**
 * Find the botRegistration doc for a given Discord guild.
 * Returns null if no active registration exists.
 */
async function findRegistrationByGuildId(guildId: string) {
  const snap = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snap.empty) return null;
  return snap.docs[0];
}

/**
 * Build a GuildMemberEntry from a discord.js GuildMember.
 */
function memberToEntry(member: GuildMember) {
  return {
    username: member.user.username,
    displayName: member.displayName,
    avatarUrl: member.user.displayAvatarURL({ size: 128 }),
    isBot: member.user.bot,
  };
}

/**
 * Register event handlers for guild member join/leave.
 * Call this once after the Discord client is ready.
 */
export function registerGuildSyncEvents(client: Client): void {
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    // Skip self
    if (member.user.id === client.user?.id) return;

    try {
      const reg = await findRegistrationByGuildId(member.guild.id);
      if (!reg) return;

      await reg.ref.update({
        [`guildMembers.${member.user.id}`]: memberToEntry(member),
      });

      logger.info('Guild member added to cache', {
        guildId: member.guild.id,
        userId: member.user.id,
        username: member.user.username,
      });
    } catch (err) {
      logger.error('Failed to sync guild member add', {
        guildId: member.guild.id,
        userId: member.user.id,
        error: String(err),
      });
    }
  });

  client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
    try {
      const reg = await findRegistrationByGuildId(member.guild.id);
      if (!reg) return;

      await reg.ref.update({
        [`guildMembers.${member.user.id}`]: FieldValue.delete(),
      });

      logger.info('Guild member removed from cache', {
        guildId: member.guild.id,
        userId: member.user.id,
      });
    } catch (err) {
      logger.error('Failed to sync guild member remove', {
        guildId: member.guild.id,
        userId: member.user.id,
        error: String(err),
      });
    }
  });

  logger.info('Guild member sync events registered');
}

/**
 * Refresh the guildMembers cache for all active registrations.
 * Call this on bot startup.
 */
export async function refreshAllGuildMembers(client: Client): Promise<void> {
  const regs = await db.collection('botRegistrations')
    .where('status', '==', 'active')
    .get();

  let refreshed = 0;

  for (const reg of regs.docs) {
    const guildId = reg.data().guildId;
    if (!guildId) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logger.warn('Guild not in cache, skipping refresh', { guildId, teamId: reg.id });
      continue;
    }

    try {
      const members = await guild.members.fetch();
      const cache: Record<string, ReturnType<typeof memberToEntry>> = {};

      for (const [id, member] of members) {
        if (member.user.id === client.user?.id) continue;
        cache[id] = memberToEntry(member);
      }

      await reg.ref.update({ guildMembers: cache });
      refreshed++;

      logger.info('Refreshed guild members cache', {
        guildId,
        teamId: reg.id,
        memberCount: Object.keys(cache).length,
      });
    } catch (err) {
      logger.error('Failed to refresh guild members', {
        guildId,
        teamId: reg.id,
        error: String(err),
      });
    }
  }

  logger.info(`Guild member refresh complete: ${refreshed} guilds updated`);
}
```

---

### 3. `src/core/bot.ts`

Import and initialize the guild sync module. In the `ClientReady` handler:

```typescript
import { registerGuildSyncEvents, refreshAllGuildMembers } from '../modules/registration/guild-sync.js';

// In the ClientReady handler, after existing guild cache logging:
client.once(Events.ClientReady, async () => {
  // ...existing startup code...

  // NEW: Register guild member sync events
  registerGuildSyncEvents(client);

  // NEW: Refresh guild member caches for all active registrations
  await refreshAllGuildMembers(client);
});
```

---

## What NOT to Touch

- **`knownPlayers`** — this is a separate concern (QW name mapping for voice recording resolution). Don't merge it with `guildMembers`. They serve different purposes and are updated at different times.
- **Recording/processing modules** — no changes needed. They continue using `knownPlayers` for match pairing.
- **Availability module** — no changes needed. It reads roster data from Firestore, not from guild members.
- **`/register` slash command** — only add the `guildMembers` write to the existing update call. Don't change the command structure or user-facing messages.

---

## Edge Cases

- **Bot not in guild anymore:** `client.guilds.cache.get(guildId)` returns undefined. Log a warning, skip refresh. The stale cache is acceptable — MatchScheduler will show the last known list.
- **Large servers:** QW clan servers are 4-20 members. If a team somehow registers from a 1000+ member server, `guild.members.fetch()` works but the Firestore doc gets large. Not a real concern for our use case. If needed in the future, limit to members with specific roles.
- **Rate limiting:** `guild.members.fetch()` is a single Discord API call per guild. On startup with 30 teams, that's 30 calls — well within rate limits (especially spread over sequential iteration).
- **`guildMemberAdd` for bots:** When another bot joins the server, it fires `guildMemberAdd`. We still add it to the cache with `isBot: true`. MatchScheduler filters these from the UI. This is intentional — simpler than filtering at the source.

---

## Verification

### Test: Registration populates guildMembers
1. With an existing registered team, disconnect and re-register (or register a new team)
2. After `/register` completes, check `botRegistrations/{teamId}` in Firebase console
3. Verify: `guildMembers` field exists with entries for each server member
4. Verify: each entry has `username`, `displayName`, `avatarUrl`, `isBot`
5. Verify: the bot itself is NOT in the list

### Test: Member join event syncs
1. Have someone join the Discord server (or use a test alt account)
2. Check `botRegistrations/{teamId}.guildMembers` in Firebase console
3. Verify: new member appears within a few seconds

### Test: Member leave event syncs
1. Have someone leave the Discord server
2. Check `botRegistrations/{teamId}.guildMembers` in Firebase console
3. Verify: member is removed within a few seconds

### Test: Startup refresh
1. Restart the bot (`docker compose restart`)
2. Check logs for "Guild member refresh complete: N guilds updated"
3. Verify: `guildMembers` data is fresh in Firestore

---

## Build & Test

```bash
npm run build          # TypeScript compilation
npm run lint           # ESLint check
# Manual verification with a test Discord server
# Monitor logs: docker compose logs -f quad
```
