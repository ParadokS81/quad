# Phase R1+R2+R5: Recording Management — quad Side

## Context

The voice pipeline works end-to-end: recording, processing, Firebase upload. Now we need three enhancements for the new Recording Management feature in MatchScheduler:

1. **R1** — Write additional match metadata to Firestore at upload time (series grouping, scores, opponent info)
2. **R2** — Clean up source recordings after successful upload (GDPR: don't retain full session audio)
3. **R5** — Listen for deletion requests from MatchScheduler and clean up local processed files

Read `docs/multi-clan/CONTRACT.md` for the original schema reference. The full recording management contract is at the orchestrator level in `RECORDING-MANAGEMENT-CONTRACT.md`.

---

## R1: Write Additional Fields at Upload Time

### What Changes

The `voiceRecordings/{demoSha256}` Firestore document currently lacks match context needed for the MatchScheduler UI to group recordings into series and display scores. All the data is already available at upload time — we just need to write it.

### New Fields

| Field | Type | Source | Example |
|-------|------|--------|---------|
| `sessionId` | string | `session.recording_id` (ULID) | `"01JKX1234567890ABCDEF"` |
| `opponentTag` | string | The other team from `matchData.teams` | `"pol"` |
| `teamFrags` | number | Our team's frags from `matchData.teams` | `312` |
| `opponentFrags` | number | Opponent's frags from `matchData.teams` | `287` |
| `gameId` | number | `segment.gameId` | `847291` |
| `mapOrder` | number | `segment.index` (0-based) | `0` |

### Files to Modify

#### 1. `src/modules/processing/pipeline.ts`

Pass `sessionId` to the upload function. Currently (around line 278-281):

```typescript
const uploadResult = await uploadVoiceRecordings(segments, teamTag, guildId);
```

Change to:

```typescript
const sessionId = session.recording_id;  // already available at line 161
const uploadResult = await uploadVoiceRecordings(segments, teamTag, guildId, sessionId);
```

#### 2. `src/modules/processing/stages/voice-uploader.ts`

**Update function signature** — add `sessionId: string` parameter:

```typescript
export async function uploadVoiceRecordings(
  segments: SegmentMetadata[],
  teamTag: string,
  guildId: string,
  sessionId: string,       // NEW
): Promise<UploadResult> {
```

**Add opponent/score resolution** — inside the per-segment loop, determine our team vs opponent:

```typescript
// Determine our team vs opponent from matchData.teams
const resolvedTeamTag = registration?.teamTag || teamTag;
const ourTeam = segment.matchData.teams.find(t =>
  t.name.toLowerCase() === resolvedTeamTag.toLowerCase()
);
const opponentTeam = segment.matchData.teams.find(t => t !== ourTeam);
```

**Add new fields to the Firestore document write** — in the object passed to `db.collection('voiceRecordings').doc(demoSha256).set()`:

```typescript
// NEW fields for recording management
sessionId,
opponentTag: opponentTeam?.name?.toLowerCase() || 'unknown',
teamFrags: ourTeam?.frags || 0,
opponentFrags: opponentTeam?.frags || 0,
gameId: segment.gameId,
mapOrder: segment.index,
```

### Edge Cases

- **No team match in matchData** (e.g., team tag differs from Hub name): `ourTeam` will be undefined. Use `teamFrags: 0`, `opponentFrags: 0`, `opponentTag: 'unknown'`. The UI handles this gracefully (shows ungrouped).
- **Only one team in matchData** (rare edge case): The opponent find will return undefined. Same fallback.
- **Unregistered guilds**: `sessionId` still works (it's from the recording session, not registration). `opponentTag` still resolved from matchData.

### Verification

After implementation, trigger a test recording or manually run the pipeline on an existing session. Check the Firestore document in the Firebase console:
- New fields should appear on the doc
- `sessionId` should be the same ULID across all maps from the same session
- `opponentTag` should match the opponent team name from QW Hub
- `mapOrder` should be 0, 1, 2... for consecutive maps

---

## R2: Post-Upload Cleanup of Source Recordings

### What Changes

After the fast pipeline completes and all segments are uploaded to Firebase, delete the raw session audio files (the full 2-hour Discord streams). Keep processed outputs (sliced per-map audio) and metadata.

### Why

- Source recordings contain full session audio including pre/post/between-map private conversation
- Sliced outputs (per-map) only contain in-game voice — safe to retain
- GDPR posture: don't retain more audio than needed
- Disk space: source files are ~5-8 MB/hour/speaker, adds up over time

### What to Delete vs Keep

```
recordings/{sessionId}/
  ├── 1-paradoks.ogg       ← DELETE (source)
  ├── 2-razor.ogg          ← DELETE (source)
  ├── 3-zero.ogg           ← DELETE (source)
  ├── session_metadata.json ← KEEP (small, useful for debugging/backfill)
  └── processed/            ← KEEP (sliced outputs needed by quad + uploaded to Firebase)
```

### File to Modify

#### `src/modules/processing/pipeline.ts`

Add a cleanup function and call it after successful upload in `runFastPipeline()`:

```typescript
async function cleanupSourceRecordings(sessionDir: string): Promise<number> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const files = await fs.readdir(sessionDir);
  let cleaned = 0;

  for (const file of files) {
    if (file.endsWith('.ogg')) {
      await fs.unlink(path.join(sessionDir, file));
      logger.info(`Cleaned up source recording: ${file}`);
      cleaned++;
    }
  }

  return cleaned;
}
```

**Call site** — after the upload section (around line 283), add:

```typescript
// Clean up source recordings after successful upload
if (uploadResult.uploaded > 0) {
  try {
    const cleaned = await cleanupSourceRecordings(sessionDir);
    logger.info(`Cleaned up ${cleaned} source recording files`);
  } catch (err) {
    logger.warn('Source recording cleanup failed (non-fatal)', { error: String(err) });
  }
}
```

### Important Conditions

- **Only clean up after successful upload** — if `uploaded === 0` and `skipped > 0`, source files may be needed for retry
- **Non-fatal** — cleanup failure should not fail the pipeline (wrap in try/catch, log warning)
- **Only delete .ogg files in the session root** — NOT in `processed/` subdirectory
- **Keep session_metadata.json** — small file, needed for backfill script and debugging

### Verification

1. Run a test pipeline
2. Check that source .ogg files are gone from `recordings/{sessionId}/`
3. Check that `session_metadata.json` still exists
4. Check that `processed/` directory and all its contents are intact
5. Check that Firebase upload succeeded (Firestore doc exists with all tracks)

---

## R5: Deletion Request Listener

### What Changes

When a team leader deletes a recording from MatchScheduler, the Cloud Function deletes from Firebase and creates a `deletionRequests/{id}` document in Firestore. quad needs to listen for these and clean up local processed files.

### New Collection: `/deletionRequests/{requestId}`

```typescript
interface DeletionRequestDocument {
  requestId: string;        // Document ID (auto-generated by Cloud Function)
  demoSha256: string;       // Which recording to delete
  teamId: string;           // Team that owns it
  sessionId: string;        // Session ULID (for local path lookup)
  mapName: string;          // For logging

  requestedBy: string;      // Firebase UID of the team leader
  requestedAt: Timestamp;

  status: 'pending' | 'completed' | 'failed';
  completedAt: Timestamp | null;
  error: string | null;
}
```

### Files to Create/Modify

#### 1. New file: `src/modules/processing/deletion-listener.ts`

```typescript
/**
 * Listens for deletion requests from MatchScheduler and cleans up
 * local processed files (sliced per-map audio, transcripts, analysis).
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import fs from 'fs/promises';
import path from 'path';

const RECORDING_DIR = process.env.RECORDING_DIR || './recordings';

export function startDeletionListener(): void {
  const db = getFirestore();

  db.collection('deletionRequests')
    .where('status', '==', 'pending')
    .onSnapshot((snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          handleDeletionRequest(change.doc).catch((err) => {
            logger.error('Deletion request handler failed', {
              requestId: change.doc.id,
              error: String(err),
            });
          });
        }
      }
    }, (err) => {
      logger.error('Deletion listener error', { error: String(err) });
    });

  logger.info('Deletion request listener started');
}

async function handleDeletionRequest(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<void> {
  const data = doc.data();
  const { demoSha256, sessionId, mapName } = data;

  logger.info('Processing deletion request', {
    requestId: doc.id,
    demoSha256,
    sessionId,
    mapName,
  });

  try {
    // Find the segment directory for this demo in the session's processed output
    // Segment dirs are named like: 2026-02-01_]sr[_vs_red_dm4_01
    // We match by looking for metadata.json files containing the demoSha256
    const processedDir = path.join(RECORDING_DIR, sessionId, 'processed');

    let deleted = false;

    try {
      const segmentDirs = await fs.readdir(processedDir);

      for (const dirName of segmentDirs) {
        const metadataPath = path.join(processedDir, dirName, 'metadata.json');
        try {
          const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
          if (metadata.demoSha256 === demoSha256 || metadata.demo_sha256 === demoSha256) {
            // Found the matching segment — delete the entire directory
            const segmentPath = path.join(processedDir, dirName);
            await fs.rm(segmentPath, { recursive: true });
            logger.info(`Deleted local segment: ${segmentPath}`);
            deleted = true;
            break;
          }
        } catch {
          // No metadata.json or can't parse — skip
          continue;
        }
      }
    } catch {
      // processed/ directory doesn't exist — source may have already been cleaned up
      logger.info(`No processed directory found for session ${sessionId} — may already be cleaned up`);
    }

    // Mark as completed (even if files weren't found — they may have been cleaned up already)
    await doc.ref.update({
      status: 'completed',
      completedAt: new Date(),
    });

    logger.info('Deletion request completed', {
      requestId: doc.id,
      filesDeleted: deleted,
    });

  } catch (err) {
    await doc.ref.update({
      status: 'failed',
      error: String(err),
    });
    throw err;
  }
}
```

#### 2. `src/modules/processing/index.ts` (or wherever the processing module initializes)

Import and start the deletion listener when Firebase is configured:

```typescript
import { startDeletionListener } from './deletion-listener.js';

// In module initialization, after Firebase is set up:
if (firebaseConfigured) {
  startDeletionListener();
}
```

### Verification

1. Manually create a `deletionRequests` doc in Firebase console with `status: 'pending'` and a known `demoSha256` + `sessionId`
2. Check quad logs for "Processing deletion request" + "Deletion request completed"
3. Verify the local segment directory was deleted
4. Verify the Firestore doc was updated to `status: 'completed'`
5. Test with a non-existent sessionId — should still complete (graceful handling)

---

## Implementation Order

1. **R1 first** — smallest change, highest value (unblocks MatchScheduler UI)
2. **R2 second** — natural follow-up in the same file area (pipeline.ts)
3. **R5 last** — independent, can wait until MatchScheduler Cloud Function exists

R1 and R2 can be done in one commit. R5 is a separate commit.

## Build & Test

```bash
npm run build          # TypeScript compilation
npm run lint           # ESLint check
# No unit tests for these changes — verify manually with a test recording
# or via Firebase console inspection
```
