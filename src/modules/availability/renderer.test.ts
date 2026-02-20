/**
 * Manual test script for the availability grid renderer.
 *
 * Run after compiling:
 *   node dist/modules/availability/renderer.test.js
 *
 * Or directly with ts-node (if configured):
 *   npx ts-node --esm src/modules/availability/renderer.test.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { renderGrid } from './renderer.js';
import { getWeekDates } from './time.js';

const WEEK_ID = '2026-08';

const weekDates = getWeekDates(WEEK_ID);  // Mon Feb 16 – Sun Feb 22

const sampleInput = {
    teamTag: ']SR[',
    weekId: WEEK_ID,
    weekDates,
    slots: {
        // Mon: 2 players (not match-ready)
        'mon_1800': ['user1', 'user2'],
        'mon_1900': ['user1', 'user2', 'user3'],
        // Tue: 4 players (match-ready)
        'tue_1900': ['user1', 'user2', 'user3', 'user4'],
        'tue_1930': ['user1', 'user2', 'user3', 'user4'],
        'tue_2000': ['user1', 'user2', 'user3', 'user4'],
        // Wed: match-ready across multiple rows
        'wed_1900': ['user1', 'user2', 'user3', 'user4'],
        'wed_2000': ['user1', 'user2', 'user3', 'user4'],
        'wed_2030': ['user1', 'user2', 'user3'],
        // Thu: full team + 1 extra (overflow test)
        'thu_2000': ['user1', 'user2', 'user3', 'user4'],
        'thu_2030': ['user1', 'user2', 'user3', 'user4'],
        'thu_2100': ['user1', 'user2', 'user3', 'user4'],
        'thu_2130': ['user1', 'user2', 'user3', 'user4'],
        // Fri: sparse (today — should be highlighted)
        'fri_2000': ['user1'],
        'fri_2030': ['user1', 'user3'],
        // Sat: match-ready
        'sat_1900': ['user1', 'user2', 'user3', 'user4'],
        'sat_2000': ['user1', 'user2', 'user3'],
        // Sun: scheduled match
        'sun_1930': ['user1', 'user2', 'user3', 'user4'],
        'sun_2100': ['user1', 'user2', 'user3', 'user4'],
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
    // Set "now" to Friday 14:00 UTC → Mon–Thu fully past, Fri current, Sat–Sun future
    now: new Date('2026-02-20T14:00:00Z'),
};

async function main(): Promise<void> {
    console.log(`Rendering grid for week ${WEEK_ID}...`);
    const buffer = await renderGrid(sampleInput);
    mkdirSync('test-output', { recursive: true });
    writeFileSync('test-output/grid.png', buffer);
    console.log(`Done → test-output/grid.png (${buffer.length} bytes)`);

    console.log('\nChecklist:');
    console.log('  [ ] Dark theme — header/legend #232440, cells #2d2f45');
    console.log('  [ ] Mon–Thu are dimmed (past)');
    console.log('  [ ] Fri header is highlighted purple (today)');
    console.log('  [ ] Tue/Wed/Thu match-ready cells have purple background (#4a3d8f)');
    console.log('  [ ] Match-ready cells show player count badge (top-right)');
    console.log('  [ ] Sun 21:30 cell shows "\u2694 vs book"');
    console.log('  [ ] Legend at bottom: PR ParadokS | RZ Razor | ZR Zero | GR Grisling');
    console.log('  [ ] Player initials colored per 6-color palette');
}

main().catch(console.error);
