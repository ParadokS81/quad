/**
 * Firestore listener — watches `notifications` collection for all pending notifications.
 *
 * Notification delivery has been replaced by the availability module's "last event"
 * message in #schedule. This listener now marks notifications as delivered without
 * sending Discord messages. The proposal_cancelled handler still cleans up OLD
 * embed messages from before this migration.
 *
 * Writes delivery status back to Firestore.
 */

import { type Client, type TextChannel } from 'discord.js';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { type ChallengeNotification, type SlotConfirmedNotification, type MatchSealedNotification, type ProposalCancelledNotification } from './types.js';

let unsubscribe: (() => void) | null = null;

let firestoreDb: Firestore | null = null;

/**
 * Start listening for all pending notifications.
 * Called from module onReady.
 */
export function startListening(db: Firestore, client: Client): void {
  firestoreDb = db;
  // No type filter — handle all notification types
  const query = db.collection('notifications')
    .where('status', '==', 'pending');

  unsubscribe = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          handleNotification(db, client, change.doc).catch((err) => {
            logger.error('Error handling notification', {
              notificationId: change.doc.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    },
    (err) => {
      logger.error('Notification listener error', {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  logger.info('Scheduler notification listener started');
}

/**
 * Stop listening. Called from module onShutdown.
 */
export function stopListening(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
    logger.info('Scheduler notification listener stopped');
  }
}

/**
 * Route a notification to the appropriate handler by type.
 */
async function handleNotification(
  db: Firestore,
  client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<void> {
  const data = doc.data();
  const type = data.type as string;

  switch (type) {
    case 'challenge_proposed':
      await handleChallengeProposed(client, doc, data as ChallengeNotification);
      break;
    case 'slot_confirmed':
      await handleSlotConfirmed(client, doc, data as SlotConfirmedNotification);
      break;
    case 'match_sealed':
      await handleMatchSealed(client, doc, data as MatchSealedNotification);
      break;
    case 'proposal_cancelled':
      await handleProposalCancelled(client, doc, data as ProposalCancelledNotification);
      break;
    default:
      logger.warn('Unknown notification type', { type, id: doc.id });
      // Mark as delivered so we don't loop on it
      await doc.ref.update({ status: 'delivered', deliveredAt: FieldValue.serverTimestamp() });
  }
}

/**
 * challenge_proposed — mark as delivered without sending Discord messages.
 * The availability module's "last event" message in #schedule handles notifications.
 */
async function handleChallengeProposed(
  _client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  data: ChallengeNotification,
): Promise<void> {
  const notificationId = doc.id;

  logger.info('Processing challenge_proposed notification', {
    notificationId,
    proposer: `${data.proposerTeamTag} ${data.proposerTeamName}`,
    opponent: `${data.opponentTeamTag} ${data.opponentTeamName}`,
    gameType: data.gameType,
  });

  await doc.ref.update({
    status: 'delivered',
    deliveredAt: FieldValue.serverTimestamp(),
    deliveryResult: {
      opponentChannelSent: false,
      opponentDmSent: false,
      proposerChannelSent: false,
      note: 'Replaced by schedule channel event message',
    },
  });

  logger.info('challenge_proposed marked delivered', { notificationId });
}

/**
 * slot_confirmed — mark as delivered without sending Discord messages.
 * Intermediate slot confirmations are no longer announced — only the final
 * match_sealed event matters, shown via the availability module's match cards.
 */
async function handleSlotConfirmed(
  _client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  data: SlotConfirmedNotification,
): Promise<void> {
  const notificationId = doc.id;

  logger.info('Processing slot_confirmed notification', {
    notificationId,
    confirmedBy: `${data.confirmedByTeamTag} ${data.confirmedByTeamName}`,
    slotId: data.slotId,
  });

  await doc.ref.update({
    status: 'delivered',
    deliveredAt: FieldValue.serverTimestamp(),
    deliveryResult: { channelSent: false, dmSent: false, note: 'Replaced by schedule channel event message' },
  });

  logger.info('slot_confirmed marked delivered', { notificationId });
}

/**
 * match_sealed — mark as delivered without sending Discord messages.
 * The availability module shows match cards in #schedule and posts an event message.
 */
async function handleMatchSealed(
  _client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  data: MatchSealedNotification,
): Promise<void> {
  const notificationId = doc.id;

  logger.info('Processing match_sealed notification', {
    notificationId,
    proposer: `${data.proposerTeamTag} ${data.proposerTeamName}`,
    opponent: `${data.opponentTeamTag} ${data.opponentTeamName}`,
    slotId: data.slotId,
  });

  await doc.ref.update({
    status: 'delivered',
    deliveredAt: FieldValue.serverTimestamp(),
    deliveryResult: { channelSent: false, note: 'Replaced by schedule channel event message' },
  });

  logger.info('match_sealed marked delivered', { notificationId });
}

/**
 * proposal_cancelled — find the original challenge_proposed notification and delete
 * the Discord messages that were sent to the announcement channels of both teams.
 */
async function handleProposalCancelled(
  client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  data: ProposalCancelledNotification,
): Promise<void> {
  const notificationId = doc.id;
  const { proposalId } = data;

  logger.info('Processing proposal_cancelled notification', { notificationId, proposalId });

  if (!firestoreDb) {
    await doc.ref.update({ status: 'failed', deliveredAt: FieldValue.serverTimestamp() });
    return;
  }

  // Find the original challenge_proposed notification to get the stored message IDs
  const snap = await firestoreDb.collection('notifications')
    .where('proposalId', '==', proposalId)
    .get();

  const challengeDoc = snap.docs.find(d => d.data().type === 'challenge_proposed');
  if (!challengeDoc) {
    logger.warn('No challenge_proposed notification found for cancelled proposal', { proposalId });
    await doc.ref.update({ status: 'delivered', deliveredAt: FieldValue.serverTimestamp() });
    return;
  }

  const result = challengeDoc.data().deliveryResult ?? {};
  const targets: Array<[string | null, string | null]> = [
    [result.opponentMessageId, result.opponentMessageChannelId],
    [result.proposerMessageId, result.proposerMessageChannelId],
  ];

  let deletedCount = 0;
  for (const [messageId, channelId] of targets) {
    if (!messageId || !channelId) continue;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.delete();
        deletedCount++;
        logger.info('Deleted proposal announcement message', { notificationId, channelId, messageId });
      }
    } catch {
      // Message already deleted or channel gone — that's fine
    }
  }

  await doc.ref.update({
    status: 'delivered',
    deliveredAt: FieldValue.serverTimestamp(),
    deliveryResult: { deletedCount },
  });

  logger.info('proposal_cancelled processed', { notificationId, proposalId, deletedCount });
}
