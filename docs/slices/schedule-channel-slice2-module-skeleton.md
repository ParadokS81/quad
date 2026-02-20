# Slice 2: Module Skeleton + Shared Utilities (Quad)

> **Project**: Quad (`/home/paradoks/projects/quake/quad/`)
> **Effort**: Small (~30 min)
> **Dependencies**: None
> **PRD**: `/home/paradoks/projects/quake/SCHEDULE-CHANNEL-PRD.md`

## Goal

Register an empty `availability` module in the bot. Build the reusable utilities (time conversion, user resolution) that slices 3-5 depend on.

---

## New Files

All under `src/modules/availability/`:

### 1. `types.ts` — Shared interfaces

```typescript
export interface ResolvedUser {
    uid: string;            // Firebase UID
    displayName: string;
    initials: string;       // e.g. "PR" for ParadokS
}

export interface AvailabilityData {
    teamId: string;
    weekId: string;         // "YYYY-WW" e.g. "2026-08"
    slots: Record<string, string[]>;        // UTC slotId → userId[]
    unavailable?: Record<string, string[]>; // UTC slotId → userId[]
}

export interface TeamInfo {
    teamId: string;
    teamTag: string;
    teamName: string;
    roster: Record<string, RosterMember>;   // userId → member info
}

export interface RosterMember {
    displayName: string;
    initials: string;
}

export interface ScheduleChannelConfig {
    channelId: string;
    messageId: string | null;   // null until first message posted
}
```

### 2. `time.ts` — CET↔UTC conversion + week utilities

Key functions to implement:

```typescript
// CET = UTC+1 (hardcoded for v1, matching scheduler module)
const CET_OFFSET = 1;

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Convert UTC slot ID to CET display. "mon_1900" → { day: "mon", time: "20:00" } */
export function utcToCet(utcSlotId: string): { day: string; time: string; }

/** Convert CET day+time to UTC slot ID. ("mon", "2000") → "mon_1900" */
export function cetToUtcSlotId(cetDay: string, cetTime: string): string

/** Format UTC slot ID for CET display. "mon_1900" → "Mon 20:00" */
export function formatSlotCET(utcSlotId: string): string

/** Get current ISO week ID. Returns "YYYY-WW" e.g. "2026-08" */
export function getCurrentWeekId(): string

/** Get date objects for Mon-Sun of a given week. For day headers (e.g. "Mon 16") */
export function getWeekDates(weekId: string): Array<{ day: string; date: number; month: string; fullDate: Date }>

/** Check if a UTC slot in a given week has already passed */
export function isSlotPast(utcSlotId: string, weekId: string): boolean

/** Get all UTC slot IDs for a given CET day (19:00-23:00 CET = 9 slots) */
export function getSlotsForDay(cetDay: string): string[]

/** Get remaining (non-past) days in the current week */
export function getRemainingDays(weekId: string): string[]
```

**Important**: The existing `formatSlotForCET()` in `src/modules/scheduler/embeds.ts` has working CET conversion logic. Extract and reuse it — don't reinvent.

Handle day wraparound: if UTC hour + CET_OFFSET >= 24, the CET day is the next day. If CET hour - CET_OFFSET < 0, the UTC day is the previous day.

### 3. `user-resolver.ts` — Discord ID → Firebase UID

```typescript
import { getDb } from '../standin/firestore.js';

interface CacheEntry {
    user: ResolvedUser;
    expiry: number;  // Date.now() + TTL
}

const cache = new Map<string, CacheEntry>();  // key: `${discordUserId}:${teamId}`
const TTL = 60 * 60 * 1000;  // 1 hour

/**
 * Resolve a Discord user to their Firebase identity + team membership.
 * Returns null if user not found or not on this team.
 */
export async function resolveUser(discordUserId: string, teamId: string): Promise<ResolvedUser | null> {
    const key = `${discordUserId}:${teamId}`;
    const cached = cache.get(key);
    if (cached && cached.expiry > Date.now()) return cached.user;

    const db = getDb();
    const snap = await db.collection('users')
        .where('discordUserId', '==', discordUserId)
        .limit(1)
        .get();

    if (snap.empty) return null;

    const doc = snap.docs[0];
    const data = doc.data();

    // Verify team membership
    if (!data.teams?.[teamId]) return null;

    const user: ResolvedUser = {
        uid: doc.id,
        displayName: data.displayName || 'Unknown',
        initials: data.initials || (data.displayName || '??').slice(0, 2).toUpperCase(),
    };

    cache.set(key, { user, expiry: Date.now() + TTL });
    return user;
}

/** Clear cache (useful for testing) */
export function clearCache(): void {
    cache.clear();
}
```

### 4. `index.ts` — Module export

```typescript
import { BotModule } from '../../core/module.js';
import { Client } from 'discord.js';
import { logger } from '../../utils/logger.js';  // check actual import path

export const availabilityModule: BotModule = {
    name: 'availability',
    commands: [],

    async handleCommand() {
        // No slash commands for this module
    },

    registerEvents(client: Client) {
        // Interaction handlers added in slice 5
        logger.info('Availability module: events registered');
    },

    async onReady(client: Client) {
        // Firestore listeners added in slice 4
        logger.info('Availability module: ready');
    },

    async onShutdown() {
        // Listener cleanup added in slice 4
        logger.info('Availability module: shutdown');
    },
};
```

### 5. Register in `src/index.ts`

Add to the module array:
```typescript
import { availabilityModule } from './modules/availability/index.js';

// In the start() call, add to the array:
start(config, [recordingModule, processingModule, standinModule, registrationModule, schedulerModule, availabilityModule]);
```

---

## Reference: Existing patterns to follow

- **Module pattern**: `src/modules/scheduler/index.ts`
- **Firebase init**: `import { initFirestore, getDb } from '../standin/firestore.js';`
- **Logger**: Check what `src/modules/scheduler/listener.ts` imports — likely `../../utils/logger.js` or similar
- **CET logic**: `src/modules/scheduler/embeds.ts` → `formatSlotForCET()` function

---

## Verification

1. `npm run build` (or `tsc`) — no TypeScript errors
2. Bot starts cleanly, logs "Availability module: ready"
3. Manually test time.ts functions:
   - `getCurrentWeekId()` returns correct ISO week
   - `utcToCet("mon_1900")` returns `{ day: "mon", time: "20:00" }`
   - `cetToUtcSlotId("mon", "2000")` returns `"mon_1900"`
   - `isSlotPast("mon_1900", "2026-08")` returns true/false correctly
