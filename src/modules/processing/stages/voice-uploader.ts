/**
 * Voice Uploader — uploads per-map split audio to Firebase Storage
 * and writes a manifest document to Firestore.
 *
 * Called after the fast pipeline (audio-splitter) completes.
 * Best-effort: skips gracefully if Firebase is not configured.
 *
 * Storage path:  voice-recordings/{demoSha256}/{playerName}.ogg
 * Firestore doc: /voiceRecordings/{demoSha256}
 */

import { stat } from 'node:fs/promises';
import { logger } from '../../../core/logger.js';
import type { SegmentMetadata } from '../types.js';

export interface UploadResult {
  uploaded: number;
  skipped: number;
}

/**
 * Upload voice recordings for all non-intermission segments.
 *
 * @param segments - Segments from the audio-splitter stage
 * @param teamTag - Team tag from session metadata (e.g., "sr")
 */
export async function uploadVoiceRecordings(
  segments: SegmentMetadata[],
  teamTag: string,
): Promise<UploadResult> {
  // Lazy-import Firebase — skip entirely if not configured
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let bucket: any;

  try {
    const firebase = await import('../../standin/firestore.js');
    db = firebase.getDb();
    const b = firebase.getBucket();
    if (!b) {
      logger.info('Voice upload skipped — Storage bucket not initialized');
      return { uploaded: 0, skipped: segments.length };
    }
    bucket = b;
  } catch {
    logger.info('Voice upload skipped — Firebase not configured');
    return { uploaded: 0, skipped: segments.length };
  }

  let uploaded = 0;
  let skipped = 0;

  for (const segment of segments) {
    // Skip intermissions — only upload map voice
    if (segment.isIntermission) {
      skipped++;
      continue;
    }

    // Skip segments without a demo SHA256
    if (!segment.demoSha256) {
      logger.warn(`Voice upload: skipping segment ${segment.dirName} — no demoSha256`);
      skipped++;
      continue;
    }

    // Skip segments with no players
    if (!segment.players || segment.players.length === 0) {
      skipped++;
      continue;
    }

    try {
      const tracks: Array<{
        playerName: string;
        fileName: string;
        storagePath: string;
        size: number;
        duration: number | null;
      }> = [];

      for (const player of segment.players) {
        const fileName = `${player.name}.ogg`;
        const storagePath = `voice-recordings/${segment.demoSha256}/${fileName}`;
        const localPath = player.audioFile;

        // Get file size
        const fileStat = await stat(localPath);

        // Upload to Firebase Storage
        await bucket.upload(localPath, {
          destination: storagePath,
          contentType: 'audio/ogg',
          metadata: {
            metadata: {
              demoSha256: segment.demoSha256,
              map: segment.map,
              player: player.name,
            },
          },
        });

        tracks.push({
          playerName: player.name,
          fileName,
          storagePath,
          size: fileStat.size,
          duration: player.duration || null,
        });
      }

      // Write manifest to Firestore
      await db.collection('voiceRecordings').doc(segment.demoSha256).set({
        demoSha256: segment.demoSha256,
        teamTag: teamTag.toLowerCase(),
        teamId: '',  // Quad doesn't know the Firestore team ID
        source: 'firebase_storage',
        tracks,
        mapName: segment.map,
        recordedAt: new Date(segment.matchData.timestamp),
        uploadedAt: new Date(),
        uploadedBy: 'quad-bot',
        trackCount: tracks.length,
      });

      uploaded++;
      logger.info(`Voice recording uploaded: ${segment.map}`, {
        demoSha256: segment.demoSha256.slice(0, 12) + '…',
        tracks: tracks.length,
        totalSize: tracks.reduce((sum, t) => sum + t.size, 0),
      });
    } catch (err) {
      logger.error(`Voice upload failed for ${segment.dirName}`, {
        error: err instanceof Error ? err.message : String(err),
        demoSha256: segment.demoSha256?.slice(0, 12),
      });
      skipped++;
    }
  }

  return { uploaded, skipped };
}
