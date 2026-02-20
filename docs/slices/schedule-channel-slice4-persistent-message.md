# Slice 4: Persistent Message + Firestore Listener (Quad)

> **Project**: Quad (`/home/paradoks/projects/quake/quad/`)
> **Effort**: Medium (~1 hour)
> **Dependencies**: Slices 1, 2, 3
> **PRD**: `/home/paradoks/projects/quake/SCHEDULE-CHANNEL-PRD.md`

## Goal

Bot posts a canvas-rendered availability grid in the configured schedule channel and auto-updates it when availability changes. **Read-only** — no interactions yet (slice 5 adds those).

---

## New Files

### 1. `src/modules/availability/listener.ts` — Firestore listeners

**Startup flow:**

```
onReady(client)
  → query botRegistrations where status == 'active'
  → for each reg with scheduleChannel.channelId:
      → startTeamListener(teamId, channelId, client)
```

**Per-team listener:**

```typescript
interface TeamState {
    teamId: string;
    channelId: string;
    messageId: string | null;
    weekId: string;
    availabilityUnsub: () => void;
    registrationUnsub: () => void;
    debounceTimer: NodeJS.Timeout | null;
    lastAvailability: AvailabilityData | null;
    teamInfo: TeamInfo | null;
    scheduledMatches: Array<{ slotId: string; opponentTag: string }>;
}

const activeTeams = new Map<string, TeamState>();
```

**Availability listener** (per team):
- `onSnapshot` on `availability/{teamId}_{weekId}`
- On change → debounce 3 seconds → call `renderAndUpdateMessage(teamId)`
- If document doesn't exist yet (new week) → render empty grid

**Registration listener** (per team):
- `onSnapshot` on `botRegistrations/{teamId}`
- Detects: `scheduleChannel.channelId` changed → teardown old, start new
- Detects: `scheduleChannel.channelId` set to null → teardown
- Detects: status changed to 'disconnecting' → teardown

**Weekly rollover check:**
- On each render, compare `getCurrentWeekId()` with `state.weekId`
- If different → unsubscribe old availability listener, subscribe to new week's doc, update `state.weekId`

**Scheduled matches** (polled, not real-time):
- On startup + every 5 minutes: query `scheduledMatches` where `blockedTeams array-contains teamId` and `status == 'upcoming'`
- Store in `state.scheduledMatches` for renderer input
- Also query `matchProposals` where `proposerTeamId == teamId` or `opponentTeamId == teamId` and `status == 'active'` — for embed text

**Team info** (cached):
- On startup: read `teams/{teamId}` for roster, initials, team tag
- Cache in `state.teamInfo`
- Refresh on each render (simple — team data changes rarely)

**Debouncing:**
```typescript
function scheduleRender(teamId: string) {
    const state = activeTeams.get(teamId);
    if (!state) return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => renderAndUpdateMessage(teamId), 3000);
}
```

**Cleanup:**
```typescript
export function stopAllListeners() {
    for (const [teamId, state] of activeTeams) {
        state.availabilityUnsub();
        state.registrationUnsub();
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
    }
    activeTeams.clear();
}
```

### 2. `src/modules/availability/message.ts` — Message management

**Post or recover:**
```typescript
export async function postOrRecoverMessage(
    client: Client,
    channelId: string,
    teamId: string,
    imageBuffer: Buffer,
    embed: EmbedBuilder,
): Promise<string>  // returns messageId
```

Flow:
1. Read `scheduleMessageId` from botRegistrations
2. Try to fetch the channel → if Unknown Channel: null out `scheduleChannel`, return
3. Try to fetch the message by ID → if found: edit with new content
4. If not found or no ID stored: post new message
5. Write `scheduleMessageId` back to Firestore
6. Return the message ID

**Update existing:**
```typescript
export async function updateMessage(
    client: Client,
    channelId: string,
    messageId: string,
    imageBuffer: Buffer,
    embed: EmbedBuilder,
): Promise<string | null>  // returns messageId or null if recovery needed
```

Flow:
1. Try to edit message → success: return messageId
2. Unknown Message error → post new message, update Firestore, return new ID
3. Unknown Channel error → null out scheduleChannel, return null

**Message content:**
```typescript
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';

const attachment = new AttachmentBuilder(imageBuffer, { name: 'schedule.png' });
const embed = new EmbedBuilder()
    .setImage('attachment://schedule.png')
    .setColor(0x8b7cf0);  // primary purple

await channel.send({
    embeds: [embed],
    files: [attachment],
    // Action rows added in slice 5
});
```

### 3. `src/modules/availability/embed.ts` — Embed builder

Build the text embed shown below the grid image:

```typescript
export function buildScheduleEmbed(
    teamTag: string,
    weekId: string,
    scheduledMatches: Array<{ opponentTag: string; slotId: string; scheduledDate: string }>,
    activeProposals: Array<{ opponentTag: string; viableSlots: number }>,
): EmbedBuilder
```

Format:
```
]SR[ · Week 8 · Feb 16-22

📋 MATCHES
  vs book — Sat 21st 21:00 CET
  vs sd — Sun 22nd 23:00 CET

📨 PROPOSALS
  vs sd — 3 viable slots

Updated just now
```

If no matches/proposals, omit those sections. Keep it concise.

### 4. Update `index.ts` — Wire lifecycle

```typescript
import { startAllListeners, stopAllListeners } from './listener.js';

async onReady(client: Client) {
    const db = initFirestore();
    await startAllListeners(db, client);
    logger.info('Availability module: ready, listeners started');
},

async onShutdown() {
    stopAllListeners();
    logger.info('Availability module: shutdown, listeners stopped');
},
```

---

## Key Patterns from Existing Code

**Firestore listener** — follow `src/modules/scheduler/listener.ts`:
- `query.onSnapshot(snapshot => { ... }, err => { logger.error(...) })`
- Store unsubscribe function, call in cleanup

**Firebase init** — `import { initFirestore, getDb } from '../standin/firestore.js';`

**Logger** — check what scheduler uses (likely `../../utils/logger.js` or inline console)

**Discord message editing** — the bot already does this in `scheduler/embeds.ts` for notification delivery. Follow that pattern for `channel.send()` and `message.edit()`.

---

## Verification

### Test Environment Setup
1. In Firestore (via MatchScheduler emulator or prod): set `botRegistrations/{slackersTeamId}.scheduleChannel.channelId` to a test channel ID in Slackers Discord
2. Ensure `availability/{slackersTeamId}_{currentWeekId}` document has some availability data

### Test Scenarios
1. **Bot starts** → detects configured schedule channel → posts grid image
2. **Change availability on website** → grid updates in Discord within ~5 seconds (3s debounce + render time)
3. **Restart bot** → same message is edited (not a second message posted)
4. **Delete the Discord message** → on next availability change, bot posts a new one
5. **Remove `scheduleChannel.channelId`** from Firestore → bot stops updating, unsubscribes listener
6. **Week rollover** → grid shows new empty week
