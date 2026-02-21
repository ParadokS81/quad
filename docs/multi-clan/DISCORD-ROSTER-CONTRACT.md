# Discord Roster Management — Cross-Project Contract

> Extends the Voice Replay Multi-Clan contract with Discord-driven roster management.
> Team leaders can add Discord server members as phantom roster entries, which auto-upgrade
> when the real person logs in via Discord OAuth.
> Reference copies should be placed in each project's `docs/multi-clan/` folder.

---

## Overview

Team leaders can onboard their entire roster through Discord, even before teammates sign up. The flow:

1. Bot is already connected to the clan's Discord server (via existing `/register` flow)
2. quad syncs the guild member list to Firestore and keeps it fresh via Discord events
3. Leader opens "Manage Players" in the team modal, sees Discord server members
4. Leader adds a member → assigns their QW nick → phantom user is created
5. Leader can set availability on behalf of phantoms (existing "on behalf of" flow)
6. When the real person logs in via Discord OAuth, they seamlessly claim the phantom account

**Key principles:**
- Discord UID is the stable identifier for matching phantoms to real logins
- Phantom users are full Firestore user docs with Firebase Auth accounts (no migration on claim)
- Only leaders can add phantom members. The conflict check prevents adding someone already on another team
- Removing a phantom (never logged in) deletes the user entirely. Kicking a real user removes team membership only
- Guild member cache in Firestore, updated by quad via discord.js events (no HTTP API needed)

---

## Schema Changes

### Extended: `/botRegistrations/{teamId}`

New field — cached guild member list:

```typescript
interface BotRegistrationDocument {
  // --- Existing fields (unchanged) ---
  teamId: string;
  teamTag: string;
  teamName: string;
  authorizedDiscordUserId: string;
  registeredBy: string;
  guildId: string | null;
  guildName: string | null;
  status: 'pending' | 'active';
  knownPlayers: { [discordUserId: string]: string };
  // ...timestamps, channels, notifications, etc.

  // --- NEW ---
  guildMembers: {
    [discordUserId: string]: {
      username: string;          // Discord username (unique handle, e.g. "paradoks")
      displayName: string;       // Server nick or global display name (e.g. "ParadokS")
      avatarUrl: string | null;  // Full Discord CDN URL (or null for default avatar)
      isBot: boolean;            // true for bot accounts — filtered from UI
    }
  };
}
```

**Updated by quad:**
- On `/register` completion — initial population
- On `guildMemberAdd` event — add new entry
- On `guildMemberRemove` event — remove entry
- On bot startup — refresh all active guilds

**Size:** ~20 members per clan server. Each entry ~200 bytes. Total ~4KB per team. Well within Firestore 1MB doc limit.

---

### Extended: `/teams/{teamId}` playerRoster entries

Two optional fields added to roster entries for phantom support:

```typescript
interface PlayerEntry {
  // --- Existing fields (unchanged) ---
  userId: string;              // Reference to /users/{userId}
  displayName: string;         // QW name (denormalized)
  initials: string;            // 1-3 uppercase chars (denormalized)
  photoURL: string | null;     // Avatar URL (denormalized)
  joinedAt: Date;
  role: 'leader' | 'member';

  // --- NEW (optional) ---
  isPhantom?: boolean;         // true for phantom members (leader-created, never logged in)
  discordUserId?: string;      // Discord UID — stored for cross-reference with guildMembers
}
```

**Why denormalize these?**
- `isPhantom` — UI needs this to show phantom badge, disable certain actions, determine delete-vs-kick behavior
- `discordUserId` — client needs this to cross-reference roster against guildMembers without loading N user docs

**Lifecycle:**
- Set to `true` / Discord UID when phantom is created
- `isPhantom` set to `false` (or removed) when real user claims the account
- `discordUserId` persists after claim (still useful for voice recording resolution)

---

### Extended: `/users/{userId}`

Phantom user documents use the same schema with one new field:

```typescript
interface UserDocument {
  // --- Existing fields ---
  displayName: string;           // QW name assigned by leader
  initials: string;              // Auto-generated from displayName
  email: string | null;          // null for phantoms
  photoURL: string | null;       // Discord avatar URL (from guild member cache)
  teams: { [teamId: string]: true };
  discordUserId: string | null;  // Set for phantoms and Discord-linked users
  discordUsername: string | null;
  discordAvatarHash: string | null;
  discordLinkedAt: Timestamp | null;
  createdAt: Timestamp;
  lastUpdatedAt: Timestamp;

  // --- NEW ---
  isPhantom?: boolean;           // true = created by team leader, never logged in
  phantomCreatedBy?: string;     // Firebase UID of the leader who created this phantom
}
```

**Phantom user doc characteristics:**
- Has a real Firebase Auth UID (created via Admin SDK)
- `email` is null
- `discordUserId` is set (the whole point)
- `isPhantom: true`
- `teams` map has exactly one entry (the team they were added to)
- `photoURL` populated from Discord avatar if available

---

## Flows

### Flow 1: Guild Member Sync (quad → Firestore)

```
DISCORD SERVER                         FIRESTORE
──────────────                         ─────────

Bot joins guild (on /register)
     │
     ▼
guild.members.fetch()
     │
     ▼
Build guildMembers map:
  filter out self (bot)
  for each member:
    discordUserId → { username, displayName, avatarUrl, isBot }
     │
     ▼
Write to botRegistrations/{teamId}.guildMembers ──→ UI can read immediately

─── ongoing events ───

guildMemberAdd fires ──→ Add entry to guildMembers map
guildMemberRemove fires ──→ Remove entry from guildMembers map

─── bot startup ───

For each active botRegistration:
  Re-fetch guild members ──→ Full refresh of guildMembers map
```

**Note:** `guildMemberAdd`/`guildMemberRemove` events require the `GuildMembers` intent, which quad already has enabled.

---

### Flow 2: Add Phantom Member (Leader → MatchScheduler → Firestore)

```
MATCHSCHEDULER (Manage Players modal)
──────────────────────────────────────

Leader clicks "Manage Players"
     │
     ▼
Read botRegistrations/{teamId}
  → get guildMembers map
     │
Read teams/{teamId}
  → get playerRoster (with discordUserId on entries)
     │
     ▼
Cross-reference:
  available = guildMembers WHERE
    discordUserId NOT IN roster[].discordUserId
    AND isBot == false
     │
     ▼
Show available Discord members
  with avatar + display name + "Add" button
     │
Leader clicks "Add" on a member
     │
     ▼
Prompt: "QW nick for [Discord name]?"
  → pre-filled with Discord display name
  → leader can change it
     │
     ▼
Call Cloud Function: addPhantomMember({
  teamId,
  discordUserId,
  displayName: "assigned QW nick"
})
     │
     ▼
Cloud Function:
  1. Verify caller is team leader
  2. Verify team is not at maxPlayers
  3. Conflict check: query users WHERE discordUserId == X AND teams != {}
     → If found: reject "Already on team [Y]. They must join themselves."
  4. Create Firebase Auth account (Admin SDK)
  5. Create user doc at users/{authUid}:
       isPhantom: true
       phantomCreatedBy: caller UID
       displayName: assigned QW nick
       discordUserId: from input
       discordUsername: from guildMembers cache
       photoURL: from guildMembers avatarUrl
       teams: { [teamId]: true }
       initials: auto-generated
  6. Add to team playerRoster[]:
       { userId: authUid, displayName, initials, photoURL,
         joinedAt: now, role: 'member',
         isPhantom: true, discordUserId }
  7. Update knownPlayers[discordUserId] = displayName
     │
     ▼
UI updates in real-time (Firestore listener on team doc)
  → new member appears in roster with phantom badge
```

---

### Flow 3: Phantom Claim (Real User Logs In)

```
DISCORD OAUTH LOGIN
───────────────────

User clicks "Sign in with Discord"
     │
     ▼
Cloud Function: discordOAuthExchange
     │
     ▼
Exchange code → get Discord profile
  → discordUserId, username, avatar, email
     │
     ▼
Existing check: query users WHERE discordUserId == X
     │
     ├─ Found user with isPhantom == true:
     │    │
     │    ▼
     │  CLAIM FLOW:
     │  1. Update Firebase Auth account:
     │       set email (if available)
     │       link Discord OAuth provider
     │  2. Update user doc:
     │       isPhantom: false (or delete field)
     │       remove phantomCreatedBy
     │       update discordUsername, discordAvatarHash, discordLinkedAt
     │       update email if available
     │  3. Update team roster entry:
     │       isPhantom: false (or delete field)
     │       update photoURL if changed
     │  4. Return custom token for existing Auth UID
     │       → User lands on MatchScheduler, team already set up
     │
     ├─ Found user with isPhantom == false:
     │    → Normal existing user login (unchanged)
     │
     └─ Not found:
          → Normal new user creation (unchanged)
```

**Key insight:** Because the phantom already has a Firebase Auth UID, the claimed user keeps the same UID forever. No migration of doc IDs, roster references, or availability data needed. Everything "just works."

---

### Flow 4: Remove Phantom vs Kick Real User

```
Leader clicks remove on a roster member
     │
     ├─ Member has isPhantom == true (never logged in):
     │    │
     │    ▼
     │  Cloud Function: removePhantomMember({ teamId, userId })
     │    1. Verify caller is team leader
     │    2. Verify target user isPhantom == true
     │    3. Remove from team playerRoster[]
     │    4. Remove from knownPlayers
     │    5. Delete user doc: users/{userId}
     │    6. Delete Firebase Auth account (Admin SDK)
     │    → Phantom is completely purged
     │
     └─ Member has isPhantom == false (real user):
          │
          ▼
        Existing kickPlayer flow (unchanged)
          → Remove from roster + user.teams
          → User account survives
```

---

## Cloud Functions

### New: `addPhantomMember`

```
Input:  { teamId: string, discordUserId: string, displayName: string }
Auth:   Must be authenticated, must be team leader of teamId
```

**Steps:**
1. Validate input (teamId, discordUserId format, displayName 2-30 chars)
2. Read team doc — verify caller is leader, check maxPlayers not exceeded
3. Read botRegistrations/{teamId} — verify status is 'active', verify discordUserId exists in guildMembers
4. Conflict check: query `users` where `discordUserId == input.discordUserId`
   - If found AND user has any team membership (`teams` map not empty) → reject with team name
   - If found AND phantom with empty teams (orphaned) → delete the orphan, continue
5. Create Firebase Auth user: `admin.auth().createUser({})` → get UID
6. Create user doc at `users/{uid}` with phantom fields
7. Add roster entry to team doc (atomic with `arrayUnion` or full roster rewrite)
8. Update `botRegistrations/{teamId}.knownPlayers[discordUserId]` = displayName
9. Return `{ success: true, userId: uid }`

**Error handling:**
- If step 5 succeeds but later steps fail → clean up Auth account
- If discordUserId is already in roster (race condition) → reject gracefully

---

### New: `removePhantomMember`

```
Input:  { teamId: string, userId: string }
Auth:   Must be authenticated, must be team leader of teamId
```

**Steps:**
1. Read user doc — verify `isPhantom == true`
2. Read team doc — verify caller is leader, verify userId is in roster
3. Remove from `teams/{teamId}.playerRoster[]`
4. Remove `discordUserId` from `botRegistrations/{teamId}.knownPlayers`
5. Delete user doc: `users/{userId}`
6. Delete Firebase Auth account: `admin.auth().deleteUser(userId)`
7. Return `{ success: true }`

**Note:** If the user has somehow claimed the account between the UI check and function execution (race condition), the function sees `isPhantom != true` and rejects — the leader should use the normal kick flow instead.

---

### Modified: `discordOAuthExchange`

Small addition to the existing Discord login flow:

```
After fetching Discord profile (discordUserId available):

// Existing check
const existingUser = await db.collection('users')
  .where('discordUserId', '==', discordUserId)
  .limit(1).get();

if (existingUser exists) {
  if (existingUser.isPhantom) {
    // NEW: Phantom claim flow
    await claimPhantomAccount(existingUser, discordProfile);
    return customToken for existingUser's Auth UID;
  }
  // Existing: return token for existing user (unchanged)
}
// Existing: create new user (unchanged)
```

The `claimPhantomAccount` helper:
1. Updates Auth account (email, display name)
2. Updates user doc: `isPhantom: false`, fresh Discord fields, remove `phantomCreatedBy`
3. Updates roster entry on all teams in `user.teams`: `isPhantom: false`

---

## UI: Manage Players Modal

### Location

Team Management Modal → new "Manage Players" button. Visible to team leader only.

**Placement options (in order of preference):**
1. Button in the header area of the team modal (next to team name/tag)
2. New section in Settings tab, under the Scheduler section
3. Dedicated "Players" tab (4th tab — might be overkill)

### Layout

```
┌──────────────────────────────────────────────────────┐
│  Manage Players                                   ✕  │
│                                                      │
│  ROSTER (4/8)                                        │
│  ┌────────────────────────────────────────────────┐  │
│  │ [avatar] ParadokS ★           Leader           │  │
│  │ [avatar] grisling             Member           │  │
│  │ [avatar] razor                Member           │  │
│  │ [avatar] zero                 Member           │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ADD FROM DISCORD                                    │
│  Members of "Slackers" not on roster:                │
│  ┌────────────────────────────────────────────────┐  │
│  │ [avatar] Bulansen                      + Add   │  │
│  │ [avatar] XantoM                        + Add   │  │
│  │ [avatar] Kansen                        + Add   │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  No more members to add.                             │
└──────────────────────────────────────────────────────┘
```

### Roster Section Details

| Element | Source | Notes |
|---------|--------|-------|
| Avatar | `playerRoster[].photoURL` | Fallback to initials circle |
| Name | `playerRoster[].displayName` | QW name |
| Role badge | `playerRoster[].role` | "Leader" or "Member" |
| Phantom badge | `playerRoster[].isPhantom` | Small indicator (e.g. ghost icon or "Pending" text) |
| Remove button | On phantom entries only | Calls `removePhantomMember` with confirmation |

**Phantom entries** show a visual distinction (muted style, "Pending" label, or ghost icon) to indicate they haven't logged in yet. Remove button only appears on phantoms in this modal — kicking real users uses the existing "Remove Player" flow.

### Add From Discord Section

| Element | Source | Notes |
|---------|--------|-------|
| Avatar | `guildMembers[].avatarUrl` | Discord CDN URL |
| Name | `guildMembers[].displayName` | Discord server nick or global name |
| Add button | Click handler | Opens nick assignment prompt |

**Filtering:**
- Hide bots (`isBot == true`)
- Hide members already on roster (cross-reference by `discordUserId`)
- Hide the bot itself (already excluded from guildMembers by quad)

**When leader clicks "+ Add":**
1. Small inline prompt or modal: "QW nick for [Discord name]?" with text input pre-filled with Discord display name
2. Leader confirms → calls `addPhantomMember` Cloud Function
3. On success: member moves from "Add from Discord" to "Roster" section with phantom badge
4. On conflict: toast error "Already on team [X]. They must join themselves."

### Empty States

- **Bot not connected:** "Connect the bot in the Discord tab to manage players from Discord."
- **All guild members on roster:** "All Discord server members are on the roster."
- **Guild member list empty:** "No members found in the Discord server." (shouldn't happen)

---

## Firestore Rules Changes

### botRegistrations — allow scheduler read

Current rule only allows leader read. Schedulers need read access for the Discord tab:

```
match /botRegistrations/{teamId} {
  allow read: if request.auth != null
    && (get(/databases/$(database)/documents/teams/$(teamId)).data.leaderId == request.auth.uid
        || request.auth.uid in get(/databases/$(database)/documents/teams/$(teamId)).data.schedulers);
  allow write: if false;
}
```

**Note:** Check if schedulers already have read access through a different mechanism. If so, this change may not be needed.

---

## quad Changes

### 1. Sync Guild Members on Registration

In `register.ts`, after building knownPlayers, also build guildMembers:

```typescript
// After existing buildKnownPlayers() call
const guildMembers = await buildGuildMembersCache(guild);

// Write both to botRegistrations
await registrationRef.update({
  // ...existing fields...
  guildMembers,
});
```

```typescript
async function buildGuildMembersCache(guild: Guild): Record<string, GuildMemberEntry> {
  const members = await guild.members.fetch();
  const cache: Record<string, GuildMemberEntry> = {};

  for (const [id, member] of members) {
    if (member.user.id === guild.client.user?.id) continue; // skip self
    cache[id] = {
      username: member.user.username,
      displayName: member.displayName,  // server nick or global name
      avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      isBot: member.user.bot,
    };
  }
  return cache;
}
```

### 2. Register Guild Member Events

In `bot.ts` or a new `guild-sync.ts` module:

```typescript
client.on('guildMemberAdd', async (member) => {
  if (member.user.bot && member.user.id === client.user?.id) return;

  // Find botRegistration for this guild
  const reg = await findRegistrationByGuildId(member.guild.id);
  if (!reg) return;

  // Add to guildMembers map
  await reg.ref.update({
    [`guildMembers.${member.user.id}`]: {
      username: member.user.username,
      displayName: member.displayName,
      avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      isBot: member.user.bot,
    }
  });
});

client.on('guildMemberRemove', async (member) => {
  const reg = await findRegistrationByGuildId(member.guild.id);
  if (!reg) return;

  await reg.ref.update({
    [`guildMembers.${member.user.id}`]: FieldValue.delete()
  });
});
```

### 3. Refresh on Startup

In `bot.ts` `ClientReady` handler, after existing guild cache:

```typescript
// Refresh guildMembers for all active registrations
for (const registration of activeRegistrations) {
  const guild = client.guilds.cache.get(registration.guildId);
  if (guild) {
    const guildMembers = await buildGuildMembersCache(guild);
    await registration.ref.update({ guildMembers });
  }
}
```

---

## Phase Plan

| Phase | Project | Scope | Depends on |
|-------|---------|-------|------------|
| **D1** | quad | Sync guildMembers to Firestore: on `/register`, on guildMemberAdd/Remove events, on startup | — |
| **D2** | MatchScheduler | `addPhantomMember` Cloud Function: creates Auth + user doc + roster entry | — |
| **D3** | MatchScheduler | `removePhantomMember` Cloud Function: purges phantom completely | — |
| **D4** | MatchScheduler | Modify `discordOAuthExchange` to handle phantom claim on login | — |
| **D5** | MatchScheduler | "Manage Players" modal UI: roster display + Discord member picker + add/remove | D1 + D2 + D3 |

**Parallelism:** D1 (quad) and D2+D3+D4 (MatchScheduler) can run fully in parallel. D5 depends on all others being complete for integration testing, but UI scaffolding can start with mock data.

---

## Resolved Decisions

1. **Guild member cache approach:** Firestore cache on botRegistrations doc (Option A — proactive sync). No HTTP API on quad. Cache refreshed via discord.js events + bot startup.

2. **Phantom user implementation:** Full Firebase Auth account + user doc. No migration needed on claim — the Auth UID assigned at phantom creation persists forever. Discord OAuth login finds the phantom by `discordUserId` query and claims it in place.

3. **Conflict check:** Leader cannot add a Discord member who already has a user doc with team membership (phantom or real). That person must join voluntarily. This prevents two leaders from claiming the same person.

4. **Phantom removal:** Deletes everything — user doc, Auth account, roster entry, knownPlayers entry. Real user kick uses existing flow (removes from team only, account survives).

5. **UI location:** "Manage Players" accessible from team modal, leader only. Shows current roster + available Discord members in a single view.

6. **Welcome modal on claim:** Optional/deferred. When a phantom claims their account, they could see "Your team leader set you up as [nick] on [team]. You can change your name in Edit Profile." Low priority — the experience works fine without it.

7. **Multi-team phantoms:** A phantom can only be on one team. If two leaders try to add the same Discord user, second one gets blocked. The real person can join additional teams themselves after claiming.

8. **Roster schema change:** `isPhantom` and `discordUserId` added as optional fields on playerRoster entries. Denormalized for UI efficiency. Existing entries without these fields are implicitly real (non-phantom) members.

9. **Scheduler read access to botRegistrations:** Rules should allow schedulers to read (for Discord tab). Check if this is already the case before changing rules.
