# Slice 3: Canvas Grid Renderer (Quad)

> **Project**: Quad (`/home/paradoks/projects/quake/quad/`)
> **Effort**: Large (~1-2 hours)
> **Dependencies**: Slice 2 (types.ts, time.ts)
> **PRD**: `/home/paradoks/projects/quake/SCHEDULE-CHANNEL-PRD.md`

## Goal

Given availability data + team roster, produce a PNG buffer of the weekly availability grid. Can be developed and tested entirely in isolation (no Discord, no Firestore listeners).

---

## Setup

### Install `@napi-rs/canvas`

```bash
npm install @napi-rs/canvas
```

This is a pure Rust/N-API package with pre-built binaries for linux-x64-gnu. Should work on `node:22-slim` (Debian) without additional apt packages. If the Docker build fails, add to Dockerfile build stage:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends libfontconfig1
```

---

## New File: `src/modules/availability/renderer.ts`

### Input Interface

```typescript
interface RenderInput {
    teamTag: string;                    // e.g. "]SR["
    weekId: string;                     // "2026-08"
    weekDates: Array<{                  // from time.ts getWeekDates()
        day: string;                    // "mon"
        date: number;                   // 16
        month: string;                  // "Feb"
    }>;
    slots: Record<string, string[]>;    // UTC slotId → userId[]
    unavailable?: Record<string, string[]>;
    roster: Record<string, {            // userId → display info
        displayName: string;
        initials: string;
    }>;
    scheduledMatches: Array<{
        slotId: string;                 // UTC slot ID
        opponentTag: string;            // e.g. "book"
    }>;
    now: Date;                          // for past-day dimming + today highlight
}
```

### Output

```typescript
export async function renderGrid(input: RenderInput): Promise<Buffer>
```

Returns a PNG buffer ready for `AttachmentBuilder` in discord.js.

### Canvas Dimensions

- **Width**: 800px
- **Height**: 480px
- **Renders crisp** at Discord's display sizes (~520px desktop, ~350px mobile)

### Layout Grid

```
┌──────────────────────────────────────────────────────────────┐
│ y=0-35: HEADER — "teamTag · Week N · Month DD-DD"           │
├──────┬───────┬───────┬───────┬───────┬───────┬───────┬──────┤
│ y=35 │Mon 16 │Tue 17 │Wed 18 │Thu 19 │Fri 20 │Sat 21 │Sun22 │  ← DAY HEADERS (25px)
├──────┼───────┼───────┼───────┼───────┼───────┼───────┼──────┤
│19:00 │       │       │       │       │       │       │      │  ← 9 TIME ROWS
│19:30 │       │       │       │       │       │       │      │    (40px each = 360px)
│20:00 │  P R  │  P R  │  P R  │  P R  │   P   │   P   │ P R  │
│20:30 │  P R  │  P R  │  P R  │  P R  │   P   │   P   │ P R  │
│21:00 │  P R  │  P R  │  P R  │  P R  │   P   │   P   │ P R  │
│21:30 │  P R  │ GPR   │  P R  │ GPRZ  │   P   │  GP   │ ⚔vs  │
│22:00 │ PRZ   │ GPRZ  │ PRZ   │ GPRZ  │  PZ   │ GPZ   │GPRZ  │
│22:30 │ PRZ   │ GPRZ  │ PRZ   │ GPRZ  │  PZ   │ GPZ   │GPRZ  │
│23:00 │ PRZ   │ GPRZ  │ PRZ   │ GPRZ  │  PZ   │ GPZ   │ ⚔vs  │
├──────┴───────┴───────┴───────┴───────┴───────┴───────┴──────┤
│ y=420-450: LEGEND — "P ParadokS  R Razor  Z Zero  G Gris"   │
└──────────────────────────────────────────────────────────────┘

Time label column: 60px wide
Day columns: (800-60) / 7 ≈ 105px each
```

### Color Palette (matches MatchScheduler dark theme)

```typescript
const COLORS = {
    background:     '#1a1b2e',
    cellEmpty:      '#2d2f45',
    cellBorder:     '#4a4d6a',
    cellMatchReady: '#4a3d8f',   // 4+ available players
    cellScheduled:  '#5b4fa0',   // has a scheduled match
    textPrimary:    '#e0e0e0',   // headers, time labels
    textSecondary:  '#9ca3af',   // dimmed text
    todayHighlight: '#8b7cf0',   // today column header
    headerBg:       '#232440',   // header/legend background
};

// Player initial colors — djb2 hash of userId → one of these
const PLAYER_COLORS = [
    '#E06666',  // Red    (0°)
    '#FFD966',  // Yellow (60°)
    '#93C47D',  // Green  (120°)
    '#76A5AF',  // Teal   (180°)
    '#6D9EEB',  // Blue   (240°)
    '#C27BA0',  // Pink   (300°)
];

function getColorForUser(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = ((hash << 5) - hash) + userId.charCodeAt(i);
        hash |= 0;
    }
    return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}
```

### Rendering Logic

For each cell `(day, timeSlot)`:

1. **Convert CET display row to UTC slot ID** using `time.ts` — e.g. CET 20:00 on Monday → `mon_1900`
2. **Look up players**: `slots[utcSlotId]` → array of userIds
3. **Check match-ready**: `players.length >= 4` → use `cellMatchReady` background
4. **Check scheduled match**: if `scheduledMatches` has this `slotId` → use `cellScheduled` bg, draw "⚔ vs TAG" instead of initials
5. **Check past**: compare cell's datetime against `now` → draw with `globalAlpha = 0.3`
6. **Draw initials**: For each userId in the cell, look up `roster[userId].initials`, take first character, draw in `getColorForUser(userId)` color. Space them horizontally within the cell.
7. **Today column**: If the day matches today's weekday, draw the header text in `todayHighlight` color

### Rendering Steps (pseudocode)

```typescript
import { createCanvas } from '@napi-rs/canvas';

export async function renderGrid(input: RenderInput): Promise<Buffer> {
    const canvas = createCanvas(800, 480);
    const ctx = canvas.getContext('2d');

    // 1. Fill background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, 800, 480);

    // 2. Draw header row
    drawHeader(ctx, input.teamTag, input.weekId, input.weekDates);

    // 3. Draw day column headers
    drawDayHeaders(ctx, input.weekDates, input.now);

    // 4. Draw time rows
    const CET_SLOTS = ['1900','1930','2000','2030','2100','2130','2200','2230','2300'];
    for (let row = 0; row < CET_SLOTS.length; row++) {
        // Draw time label
        drawTimeLabel(ctx, row, CET_SLOTS[row]);

        for (let col = 0; col < 7; col++) {
            const cetDay = DAY_ORDER[col];
            const utcSlotId = cetToUtcSlotId(cetDay, CET_SLOTS[row]);
            const isPast = isSlotPast(utcSlotId, input.weekId);

            // Save alpha for past dimming
            if (isPast) ctx.globalAlpha = 0.3;

            drawCell(ctx, row, col, utcSlotId, input);

            if (isPast) ctx.globalAlpha = 1.0;
        }
    }

    // 5. Draw legend row
    drawLegend(ctx, input.roster, input.slots);

    // 6. Export PNG
    return canvas.toBuffer('image/png');
}
```

### Font

Use `@napi-rs/canvas`'s built-in font support. Register a system font or use the default:
```typescript
import { GlobalFonts } from '@napi-rs/canvas';
// Default sans-serif should work; if not, register a font file
```

For initials, use bold 12-14px. For headers, 14-16px. For time labels, 12px.

### Player Count Badge

For match-ready cells (4+), draw a small superscript number in the top-right corner of the cell showing the player count. Use a smaller font (10px) and `textPrimary` color.

### Overflow Handling

If more than ~5-6 players in one cell, the initials won't fit. Options:
- Show first 5 initials + "+" suffix (matching the web app's overflow badge)
- Or just pack them tighter — at 105px cell width, 6-7 single-character initials fit

---

## Test Script

Create `src/modules/availability/renderer.test.ts` (or a standalone script):

```typescript
import { renderGrid } from './renderer.js';
import { writeFileSync, mkdirSync } from 'fs';

const sampleInput = {
    teamTag: ']SR[',
    weekId: '2026-08',
    weekDates: [
        { day: 'mon', date: 16, month: 'Feb' },
        { day: 'tue', date: 17, month: 'Feb' },
        // ... all 7 days
    ],
    slots: {
        'mon_1900': ['user1', 'user2'],          // 2 players
        'mon_2030': ['user1', 'user2', 'user3', 'user4'],  // 4 = match-ready
        'fri_1900': ['user1'],
        'sat_2000': ['user1', 'user3', 'user4'],
    },
    roster: {
        'user1': { displayName: 'ParadokS', initials: 'PR' },
        'user2': { displayName: 'Razor', initials: 'RZ' },
        'user3': { displayName: 'Zero', initials: 'ZR' },
        'user4': { displayName: 'Grisling', initials: 'GR' },
    },
    scheduledMatches: [
        { slotId: 'sun_2030', opponentTag: 'book' },
    ],
    now: new Date('2026-02-20T14:00:00Z'),  // Friday afternoon
};

async function main() {
    const buffer = await renderGrid(sampleInput);
    mkdirSync('test-output', { recursive: true });
    writeFileSync('test-output/grid.png', buffer);
    console.log('Grid rendered → test-output/grid.png');
}

main().catch(console.error);
```

Run with: `npx ts-node --esm src/modules/availability/renderer.test.ts`
(or compile + `node dist/modules/availability/renderer.test.js`)

---

## Verification

1. Run test script → `test-output/grid.png` is created
2. Open the PNG — visually verify:
   - [ ] Dark theme colors match MatchScheduler screenshots
   - [ ] Past days (Mon-Thu) are dimmed
   - [ ] Today (Fri) header is highlighted purple
   - [ ] Player initials are colored per the 6-color palette
   - [ ] Match-ready cells (4+) have purple background
   - [ ] Scheduled match cell shows "⚔ vs book"
   - [ ] Legend at bottom maps initials to names
   - [ ] Text is readable at ~50% zoom (simulating Discord display)
3. Docker build succeeds with @napi-rs/canvas
