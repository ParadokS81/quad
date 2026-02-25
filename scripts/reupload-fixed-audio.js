/**
 * Re-upload fixed audio files to Firebase Storage.
 * Reads existing Firestore manifests to determine correct storage paths.
 *
 * Usage: node scripts/reupload-fixed-audio.js <session-id> [<session-id> ...]
 * Run inside the Docker container where Firebase credentials are available.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const RECORDING_DIR = process.env.RECORDING_DIR || './recordings';

// Initialize Firebase — env var can be JSON string or a file path
const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountEnv) {
  console.error('FIREBASE_SERVICE_ACCOUNT env var not set');
  process.exit(1);
}
let serviceAccount;
if (serviceAccountEnv.trim().startsWith('{')) {
  serviceAccount = JSON.parse(serviceAccountEnv);
} else {
  serviceAccount = JSON.parse(await readFile(serviceAccountEnv, 'utf-8'));
}
const app = initializeApp({
  credential: cert(serviceAccount),
  storageBucket: `${serviceAccount.project_id}.firebasestorage.app`,
});
const db = getFirestore(app);
const bucket = getStorage(app).bucket();

async function reuploadSession(sessionId) {
  const processedDir = join(RECORDING_DIR, sessionId, 'processed');
  const matchDirs = (await readdir(processedDir, { withFileTypes: true }))
    .filter(d => d.isDirectory());

  let uploaded = 0;
  let skipped = 0;

  for (const matchDir of matchDirs) {
    const metadataPath = join(processedDir, matchDir.name, 'metadata.json');
    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
    } catch {
      continue; // No metadata.json — skip
    }

    const demoSha256 = metadata.demoSha256;
    if (!demoSha256) {
      console.log(`  Skip ${matchDir.name}: no demoSha256`);
      skipped++;
      continue;
    }

    // Get existing Firestore manifest to find storage paths
    const doc = await db.collection('voiceRecordings').doc(demoSha256).get();
    if (!doc.exists) {
      console.log(`  Skip ${matchDir.name}: no Firestore manifest for ${demoSha256}`);
      skipped++;
      continue;
    }

    const manifest = doc.data();
    const tracks = manifest.tracks || [];
    const audioDir = join(processedDir, matchDir.name, 'audio');

    console.log(`  ${matchDir.name} (${demoSha256.slice(0, 8)}...)`);

    for (const track of tracks) {
      // Find matching local file
      // Track has: playerName, discordUserId, storagePath, fileName
      const localFile = join(audioDir, `${track.playerName}.ogg`);
      let fileStat;
      try {
        fileStat = await stat(localFile);
      } catch {
        // Try with discordUserId filename (fallback)
        try {
          const altFile = join(audioDir, `${track.discordUserId}.ogg`);
          fileStat = await stat(altFile);
        } catch {
          console.log(`    Skip ${track.playerName}: no local file`);
          skipped++;
          continue;
        }
      }

      // Re-upload
      await bucket.upload(localFile, {
        destination: track.storagePath,
        contentType: 'audio/ogg',
        metadata: {
          cacheControl: 'public, max-age=31536000, immutable',
          metadata: {
            demoSha256,
            map: manifest.mapName || '',
            player: track.playerName,
            discordUserId: track.discordUserId || '',
            teamId: manifest.teamId || '',
          },
        },
      });

      console.log(`    Uploaded ${track.playerName} -> ${track.storagePath} (${(fileStat.size / 1024).toFixed(0)}KB)`);
      uploaded++;
    }
  }

  return { uploaded, skipped };
}

// Main
const sessionIds = process.argv.slice(2);
if (sessionIds.length === 0) {
  console.error('Usage: node scripts/reupload-fixed-audio.js <session-id> [...]');
  process.exit(1);
}

console.log(`Re-uploading fixed audio for ${sessionIds.length} session(s)...\n`);

let totalUploaded = 0;
let totalSkipped = 0;

for (const sessionId of sessionIds) {
  console.log(`Session: ${sessionId}`);
  try {
    const { uploaded, skipped } = await reuploadSession(sessionId);
    totalUploaded += uploaded;
    totalSkipped += skipped;
  } catch (err) {
    console.error(`  Error: ${err.message}`);
  }
  console.log('');
}

console.log(`Done: ${totalUploaded} uploaded, ${totalSkipped} skipped`);
process.exit(0);
