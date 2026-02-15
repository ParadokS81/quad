/**
 * Backfill script — populates new fields on existing voiceRecordings docs
 * that are missing sessionId.
 *
 * For each doc:
 *   1. Query QW Hub API by demoSha256 to get match data (teams, scores, gameId)
 *   2. Group by recordedAt proximity (within 2 hours = same session)
 *   3. Generate synthetic sessionIds for each group
 *   4. Assign mapOrder by sorting within each group by recordedAt
 *   5. Update the Firestore doc with the new fields
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT=./service-account.json npx tsx src/scripts/backfill-voice-recordings.ts
 *
 * Options:
 *   --dry-run    Show what would be updated without writing to Firestore
 */

import { initializeApp, cert, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

// ============================================================
// QW Hub API (inline — no dependency on running bot)
// ============================================================

const SUPABASE_URL = 'https://ncsphkjfominimxztjip.supabase.co/rest/v1/v1_games';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jc3Boa2pmb21pbmlteHp0amlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTY5Mzg1NjMsImV4cCI6MjAxMjUxNDU2M30.' +
  'NN6hjlEW-qB4Og9hWAVlgvUdwrbBO13s8OkAJuBGVbo';

interface HubMatch {
  id: number;
  timestamp: string;
  map: string;
  mode: string;
  demo_sha256: string;
  teams: Array<{ name: string; frags: number }>;
  players: Array<{ name: string; team?: string }>;
}

async function queryHubByDemoSha256(demoSha256: string): Promise<HubMatch | null> {
  const params = new URLSearchParams({
    demo_sha256: `eq.${demoSha256}`,
  });

  const url = `${SUPABASE_URL}?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    console.error(`  Hub API error for ${demoSha256.slice(0, 12)}: ${response.status}`);
    return null;
  }

  const matches = (await response.json()) as HubMatch[];
  return matches.length > 0 ? matches[0] : null;
}

// ============================================================
// Firebase setup
// ============================================================

function initFirebase(): Firestore {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var is required');
    console.error('Usage: FIREBASE_SERVICE_ACCOUNT=./service-account.json npx tsx src/scripts/backfill-voice-recordings.ts');
    process.exit(1);
  }

  let rawJson: Record<string, unknown>;
  if (raw.startsWith('{')) {
    rawJson = JSON.parse(raw);
  } else {
    rawJson = JSON.parse(readFileSync(raw, 'utf-8'));
  }

  const app = initializeApp({
    credential: cert(rawJson as ServiceAccount),
  }, 'backfill');

  return getFirestore(app);
}

// ============================================================
// Backfill logic
// ============================================================

interface VoiceRecDoc {
  ref: FirebaseFirestore.DocumentReference;
  demoSha256: string;
  teamTag: string;
  mapName: string;
  recordedAt: Date;
}

const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Group recordings into sessions by recordedAt proximity.
 * Recordings within 2 hours of each other belong to the same session.
 */
function groupIntoSessions(docs: VoiceRecDoc[]): VoiceRecDoc[][] {
  if (docs.length === 0) return [];

  // Sort by recordedAt
  const sorted = [...docs].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  const groups: VoiceRecDoc[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.recordedAt.getTime() - prev.recordedAt.getTime();

    if (gap <= SESSION_GAP_MS) {
      // Same session
      groups[groups.length - 1].push(curr);
    } else {
      // New session
      groups.push([curr]);
    }
  }

  return groups;
}

/**
 * Generate a synthetic session ID from the earliest recording timestamp.
 * Format: bf_{timestamp_hex} — deterministic so re-runs produce the same ID.
 */
function generateSessionId(earliestTimestamp: Date): string {
  const hex = earliestTimestamp.getTime().toString(16);
  return `bf_${hex}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('=== DRY RUN — no Firestore writes ===\n');
  }

  const db = initFirebase();

  // Query all voiceRecordings docs
  console.log('Querying voiceRecordings collection...');
  const snapshot = await db.collection('voiceRecordings').get();
  console.log(`Found ${snapshot.size} total voiceRecordings docs`);

  // Filter docs missing sessionId
  const docsToBackfill: VoiceRecDoc[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!data.sessionId) {
      const recordedAt = data.recordedAt?.toDate?.() ?? new Date(data.recordedAt);
      docsToBackfill.push({
        ref: doc.ref,
        demoSha256: data.demoSha256 || doc.id,
        teamTag: data.teamTag || '',
        mapName: data.mapName || 'unknown',
        recordedAt,
      });
    }
  }

  if (docsToBackfill.length === 0) {
    console.log('No docs missing sessionId — nothing to backfill.');
    return;
  }

  console.log(`Found ${docsToBackfill.length} docs missing sessionId\n`);

  // Query QW Hub for match data for each doc
  console.log('Querying QW Hub API for match data...');
  const hubData = new Map<string, HubMatch>();
  for (const doc of docsToBackfill) {
    const match = await queryHubByDemoSha256(doc.demoSha256);
    if (match) {
      hubData.set(doc.demoSha256, match);
      console.log(`  ${doc.demoSha256.slice(0, 12)}... -> game ${match.id} (${match.map}, ${match.teams.map(t => t.name).join(' vs ')})`);
    } else {
      console.log(`  ${doc.demoSha256.slice(0, 12)}... -> not found on Hub`);
    }
    // Small delay to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Group into sessions
  const sessions = groupIntoSessions(docsToBackfill);
  console.log(`\nGrouped into ${sessions.length} session(s):\n`);

  // Process each session
  let totalUpdated = 0;
  for (const session of sessions) {
    const sessionId = generateSessionId(session[0].recordedAt);
    const dateStr = session[0].recordedAt.toISOString().split('T')[0];
    console.log(`Session ${sessionId} (${dateStr}, ${session.length} maps):`);

    // Sort within session by recordedAt for mapOrder assignment
    session.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

    for (let mapOrder = 0; mapOrder < session.length; mapOrder++) {
      const doc = session[mapOrder];
      const hub = hubData.get(doc.demoSha256);

      // Determine our team vs opponent
      let opponentTag = 'unknown';
      let teamFrags = 0;
      let opponentFrags = 0;
      let gameId = 0;

      if (hub) {
        gameId = hub.id;
        const ourTeam = hub.teams.find(t =>
          t.name.toLowerCase() === doc.teamTag.toLowerCase()
        );
        const opponentTeam = hub.teams.find(t => t !== ourTeam);

        opponentTag = opponentTeam?.name?.toLowerCase() || 'unknown';
        teamFrags = ourTeam?.frags || 0;
        opponentFrags = opponentTeam?.frags || 0;
      }

      const update = {
        sessionId,
        opponentTag,
        teamFrags,
        opponentFrags,
        gameId,
        mapOrder,
      };

      console.log(`  [${mapOrder}] ${doc.mapName} — ${doc.teamTag} vs ${opponentTag} (${teamFrags}-${opponentFrags}) gameId=${gameId}`);

      if (!dryRun) {
        await doc.ref.update(update);
        totalUpdated++;
      }
    }
    console.log();
  }

  if (dryRun) {
    console.log(`Dry run complete — ${docsToBackfill.length} docs would be updated.`);
  } else {
    console.log(`Backfill complete — ${totalUpdated} docs updated.`);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
