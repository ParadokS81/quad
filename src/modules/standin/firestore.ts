/**
 * Firebase Admin SDK setup for the standin module.
 *
 * Connects to the same Firestore instance as MatchScheduler.
 * Uses a service account for full read/write access (bypasses security rules).
 *
 * Config: FIREBASE_SERVICE_ACCOUNT env var — path to JSON file or inline JSON string.
 */

import { initializeApp, cert, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { readFileSync } from 'node:fs';
import { logger } from '../../core/logger.js';

let db: Firestore | null = null;
let storageBucket: ReturnType<ReturnType<typeof getStorage>['bucket']> | null = null;

export function initFirestore(): Firestore {
  if (db) return db;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required for standin module');
  }

  let serviceAccount: ServiceAccount;

  // Try as file path first, then as inline JSON
  if (raw.startsWith('{')) {
    serviceAccount = JSON.parse(raw) as ServiceAccount;
  } else {
    const contents = readFileSync(raw, 'utf-8');
    serviceAccount = JSON.parse(contents) as ServiceAccount;
  }

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET
    || `${serviceAccount.projectId}.firebasestorage.app`;

  const app = initializeApp({
    credential: cert(serviceAccount),
    storageBucket: bucketName,
  }, 'standin'); // named app to avoid conflicts if other modules use firebase-admin

  db = getFirestore(app);
  storageBucket = getStorage(app).bucket();
  logger.info('Firebase Admin initialized (Firestore + Storage)', { bucket: bucketName });

  return db;
}

export function getDb(): Firestore {
  if (!db) {
    throw new Error('Firestore not initialized — call initFirestore() first');
  }
  return db;
}

/** Returns the Storage bucket, or null if Firebase not initialized. */
export function getBucket(): typeof storageBucket {
  return storageBucket;
}
