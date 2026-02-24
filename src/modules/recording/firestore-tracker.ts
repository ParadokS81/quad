/**
 * Firestore session tracker — writes live recording state to the
 * recordingSessions collection so the MatchScheduler admin panel
 * can show which teams are currently recording.
 *
 * All Firestore writes are fire-and-forget. A Firestore outage
 * must never affect the recording itself.
 */

import { FieldValue, type Firestore, type DocumentReference } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { getRegistrationsForGuild } from '../registration/register.js';
import { onRecordingStart, onRecordingStop, onParticipantChange } from './commands/record.js';
import type { RecordingSession } from './session.js';

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute
const COLLECTION = 'recordingSessions';

/** Per-guild tracking state while a session is active. */
interface TrackedSession {
  sessionId: string;
  docRef: DocumentReference;
  heartbeatTimer: ReturnType<typeof setInterval>;
  peakParticipants: number;
}

const trackedSessions = new Map<string, TrackedSession>();

let db: Firestore | null = null;

/**
 * Initialize the session tracker. Call once during module setup.
 * Registers recording lifecycle callbacks that write to Firestore.
 */
export function initSessionTracker(firestore: Firestore): void {
  db = firestore;

  onRecordingStart((session: RecordingSession) => {
    handleSessionStart(session).catch((err) => {
      logger.warn('Firestore session start write failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.sessionId,
      });
    });
  });

  onRecordingStop((_sessionDir: string, sessionId: string) => {
    handleSessionStop(sessionId).catch((err) => {
      logger.warn('Firestore session stop write failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      });
    });
  });

  onParticipantChange((guildId: string, participants: string[]) => {
    handleParticipantChange(guildId, participants).catch((err) => {
      logger.warn('Firestore participant update failed', {
        error: err instanceof Error ? err.message : String(err),
        guildId,
      });
    });
  });

  logger.info('Firestore session tracker initialized');
}

async function handleSessionStart(session: RecordingSession): Promise<void> {
  if (!db) return;

  // Look up team registration for this guild
  let teamId: string | null = null;
  try {
    const registrations = await getRegistrationsForGuild(session.guildId);
    if (registrations.length === 1) {
      teamId = registrations[0].teamId;
    } else if (registrations.length > 1 && session.sourceTextChannelId) {
      const match = registrations.find(r => r.registeredChannelId === session.sourceTextChannelId);
      teamId = match?.teamId ?? null;
    }
  } catch {
    // Unregistered guild — still track the session
  }

  const docRef = db.collection(COLLECTION).doc();

  await docRef.set({
    sessionId: session.sessionId,
    teamId,
    guildId: session.guildId,
    guildName: session.guildName,
    channelId: session.channelId,
    channelName: session.channelName,
    participants: [],
    startedAt: FieldValue.serverTimestamp(),
    status: 'recording',
    lastHeartbeat: FieldValue.serverTimestamp(),
  });

  // Start heartbeat timer
  const heartbeatTimer = setInterval(() => {
    docRef.update({ lastHeartbeat: FieldValue.serverTimestamp() }).catch((err) => {
      logger.warn('Firestore heartbeat update failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.sessionId,
      });
    });
  }, HEARTBEAT_INTERVAL_MS);

  trackedSessions.set(session.guildId, {
    sessionId: session.sessionId,
    docRef,
    heartbeatTimer,
    peakParticipants: 0,
  });

  logger.info('Recording session tracked in Firestore', {
    sessionId: session.sessionId,
    firestoreDoc: docRef.path,
    teamId,
  });
}

async function handleSessionStop(sessionId: string): Promise<void> {
  if (!db) return;

  // Find tracked session by sessionId (map is keyed by guildId)
  let guildId: string | null = null;
  let tracked: TrackedSession | null = null;
  for (const [gid, ts] of trackedSessions) {
    if (ts.sessionId === sessionId) {
      guildId = gid;
      tracked = ts;
      break;
    }
  }

  if (!guildId || !tracked) {
    logger.warn('Could not find tracked session for stop callback', { sessionId });
    return;
  }

  // Clear heartbeat
  clearInterval(tracked.heartbeatTimer);
  trackedSessions.delete(guildId);

  // Read startedAt to compute duration
  let duration = 0;
  try {
    const doc = await tracked.docRef.get();
    const data = doc.data();
    if (data?.startedAt?.toDate) {
      duration = Math.round((Date.now() - data.startedAt.toDate().getTime()) / 1000);
    }
  } catch {
    // Can't compute duration — not critical
  }

  await tracked.docRef.update({
    status: 'completed',
    endedAt: FieldValue.serverTimestamp(),
    duration,
    participantCount: tracked.peakParticipants,
  });

  logger.info('Recording session marked completed in Firestore', {
    sessionId,
    duration,
    peakParticipants: tracked.peakParticipants,
  });
}

async function handleParticipantChange(guildId: string, participants: string[]): Promise<void> {
  const tracked = trackedSessions.get(guildId);
  if (!tracked) return;

  // Update peak count
  if (participants.length > tracked.peakParticipants) {
    tracked.peakParticipants = participants.length;
  }

  await tracked.docRef.update({ participants });
}

/**
 * On startup, mark any stale `recording` docs as `interrupted`.
 * Handles crash recovery — if quad died mid-recording, those docs
 * would be stuck with status: 'recording' forever.
 */
export async function cleanupInterruptedSessions(): Promise<void> {
  if (!db) return;

  try {
    const snap = await db.collection(COLLECTION)
      .where('status', '==', 'recording')
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        status: 'interrupted',
        endedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    logger.info(`Marked ${snap.size} stale recording session(s) as interrupted`);
  } catch (err) {
    logger.warn('Failed to clean up interrupted sessions', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Graceful shutdown — mark any currently tracked sessions as completed.
 */
export async function shutdownSessionTracker(): Promise<void> {
  if (!db) return;

  for (const [guildId, tracked] of trackedSessions) {
    clearInterval(tracked.heartbeatTimer);

    try {
      let duration = 0;
      const doc = await tracked.docRef.get();
      const data = doc.data();
      if (data?.startedAt?.toDate) {
        duration = Math.round((Date.now() - data.startedAt.toDate().getTime()) / 1000);
      }

      await tracked.docRef.update({
        status: 'completed',
        endedAt: FieldValue.serverTimestamp(),
        duration,
        participantCount: tracked.peakParticipants,
      });
    } catch (err) {
      logger.warn('Failed to mark session as completed during shutdown', {
        error: err instanceof Error ? err.message : String(err),
        guildId,
      });
    }
  }

  trackedSessions.clear();
}
