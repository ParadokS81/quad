/**
 * Deletion request listener — watches Firestore for deletion requests from
 * MatchScheduler and cleans up local processed files (sliced per-map audio,
 * transcripts, analysis).
 *
 * Lifecycle:
 *   1. MatchScheduler Cloud Function creates deletionRequests/{id} with status: 'pending'
 *   2. This listener picks it up
 *   3. Finds and deletes the local segment directory matching demoSha256
 *   4. Updates the Firestore doc to status: 'completed'
 *   5. If files aren't found (already cleaned up), still marks completed
 */

import { type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const RECORDING_DIR = process.env.RECORDING_DIR || './recordings';

let unsubscribe: (() => void) | null = null;

/**
 * Start listening for pending deletion requests.
 * Called from the processing module's onReady when Firebase is configured.
 */
export function startDeletionListener(db: Firestore): void {
  const query = db.collection('deletionRequests').where('status', '==', 'pending');

  unsubscribe = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          handleDeletionRequest(change.doc).catch((err) => {
            logger.error('Deletion request handler failed', {
              requestId: change.doc.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    },
    (err) => {
      logger.error('Deletion listener error', {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  logger.info('Deletion request listener started');
}

/**
 * Stop the deletion listener. Called on module shutdown.
 */
export function stopDeletionListener(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
    logger.info('Deletion request listener stopped');
  }
}

/**
 * Handle a single deletion request: find the matching segment directory,
 * delete it, and update the Firestore doc status.
 */
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
    // Segment dirs live under recordings/{sessionId}/processed/{segmentDir}/
    // Each has a metadata.json with demoSha256 — find the matching one
    const processedDir = join(RECORDING_DIR, sessionId, 'processed');
    let deleted = false;

    try {
      const segmentDirs = await readdir(processedDir);

      for (const dirName of segmentDirs) {
        const metadataPath = join(processedDir, dirName, 'metadata.json');
        try {
          const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
          if (metadata.demoSha256 === demoSha256 || metadata.demo_sha256 === demoSha256) {
            const segmentPath = join(processedDir, dirName);
            await rm(segmentPath, { recursive: true });
            logger.info(`Deleted local segment: ${segmentPath}`);
            deleted = true;
            break;
          }
        } catch {
          // No metadata.json or can't parse — skip this directory
          continue;
        }
      }
    } catch {
      // processed/ directory doesn't exist — source may have already been cleaned up
      logger.info(`No processed directory found for session ${sessionId} — may already be cleaned up`);
    }

    // Mark as completed even if files weren't found (they may have been cleaned up already)
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
