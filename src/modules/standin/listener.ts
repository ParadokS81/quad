/**
 * Firestore listener — watches standin_requests for changes and dispatches actions.
 *
 * Two listeners:
 * 1. Pending requests: new docs or docs that need DMs sent
 * 2. Confirmed requests: status changed to "confirmed" → send confirmation/rejection DMs
 */

import { type Client } from 'discord.js';
import { FieldValue, type Firestore, type DocumentChange } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { type StandinRequest, type StandinPreferences } from './types.js';
import { sendStandinRequestDM, sendConfirmationDM, sendRejectionDM } from './dm.js';

let unsubscribePending: (() => void) | null = null;

/**
 * Start listening for standin requests.
 * Called from module onReady.
 */
export function startListening(db: Firestore, client: Client): void {
  // Watch all pending requests
  const query = db.collection('standin_requests').where('status', '==', 'pending');

  unsubscribePending = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          handleNewRequest(db, client, change).catch((err) => {
            logger.error('Error handling new standin request', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        if (change.type === 'modified') {
          handleModifiedRequest(db, client, change).catch((err) => {
            logger.error('Error handling modified standin request', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    },
    (err) => {
      logger.error('Standin request listener error', {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  logger.info('Standin Firestore listener started');
}

/**
 * Stop listening. Called from module onShutdown.
 */
export function stopListening(): void {
  if (unsubscribePending) {
    unsubscribePending();
    unsubscribePending = null;
    logger.info('Standin Firestore listener stopped');
  }
}

/**
 * New pending request appeared — send DMs to all candidates who haven't been contacted yet.
 */
async function handleNewRequest(
  db: Firestore,
  client: Client,
  change: DocumentChange,
): Promise<void> {
  const data = change.doc.data() as StandinRequest;
  const requestId = change.doc.id;

  logger.info('New standin request detected', {
    requestId,
    team: data.requestedBy.teamName,
    candidates: Object.keys(data.candidates).length,
  });

  const schedulerUrl = process.env.SCHEDULER_URL || 'https://scheduler.quake.world';

  for (const [discordUserId, candidate] of Object.entries(data.candidates)) {
    // Skip if we already have a response entry (e.g. bot restarted and re-read)
    if (data.responses?.[discordUserId]) continue;

    // Check preferences
    const blocked = await isBlocked(db, discordUserId, data);
    if (blocked) {
      await change.doc.ref.update({
        [`responses.${discordUserId}`]: {
          status: 'pending',
          dmDelivered: false,
          dmError: 'blocked_by_preferences',
        },
      });
      logger.debug('Skipped blocked candidate', { requestId, discordUserId });
      continue;
    }

    // Send DM
    try {
      const user = await client.users.fetch(discordUserId);
      await sendStandinRequestDM(user, data, requestId, schedulerUrl);

      await change.doc.ref.update({
        [`responses.${discordUserId}`]: {
          status: 'pending',
          dmDelivered: true,
        },
      });

      logger.info('Standin DM sent', {
        requestId,
        discordUserId,
        displayName: candidate.displayName,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await change.doc.ref.update({
        [`responses.${discordUserId}`]: {
          status: 'pending',
          dmDelivered: false,
          dmError: errorMsg,
        },
      });
      logger.warn('Failed to send standin DM', {
        requestId,
        discordUserId,
        error: errorMsg,
      });
    }
  }
}

/**
 * Request was modified — check if status changed to "confirmed".
 */
async function handleModifiedRequest(
  db: Firestore,
  client: Client,
  change: DocumentChange,
): Promise<void> {
  const data = change.doc.data() as StandinRequest;
  const requestId = change.doc.id;

  if (data.status === 'confirmed' && data.confirmedDiscordId) {
    logger.info('Standin request confirmed', {
      requestId,
      confirmedDiscordId: data.confirmedDiscordId,
    });

    const confirmedCandidate = data.candidates[data.confirmedDiscordId];

    // Send "you're in" to the confirmed player
    try {
      const confirmedUser = await client.users.fetch(data.confirmedDiscordId);
      await sendConfirmationDM(confirmedUser, data);
    } catch (err) {
      logger.warn('Failed to send confirmation DM', {
        requestId,
        discordUserId: data.confirmedDiscordId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Send "slot filled" to everyone else who accepted
    for (const [discordUserId, response] of Object.entries(data.responses)) {
      if (discordUserId === data.confirmedDiscordId) continue;
      if (response.status !== 'accepted') continue;

      try {
        const user = await client.users.fetch(discordUserId);
        await sendRejectionDM(user, data);
      } catch (err) {
        logger.warn('Failed to send rejection DM', {
          requestId,
          discordUserId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Check if a candidate is blocked by their standin preferences.
 */
async function isBlocked(
  db: Firestore,
  discordUserId: string,
  request: StandinRequest,
): Promise<boolean> {
  const prefDoc = await db.collection('standin_preferences').doc(discordUserId).get();
  if (!prefDoc.exists) return false;

  const prefs = prefDoc.data() as StandinPreferences;

  if (prefs.optedOut) return true;
  if (prefs.blockedUsers?.includes(request.requestedBy.firebaseUid)) return true;
  if (prefs.blockedTeams?.includes(request.requestedBy.teamId)) return true;
  if (prefs.blockedDivisions?.includes(request.match.division)) return true;

  return false;
}
