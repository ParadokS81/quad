/**
 * Firestore listener — watches `notifications` collection for all pending notifications.
 *
 * Handles three types:
 * - challenge_proposed: Opponent channel (or DM fallback) + proposer channel
 * - slot_confirmed: The OTHER side's channel (or DM fallback)
 * - match_sealed: Recipient team's channel only
 *
 * Writes delivery status back to Firestore.
 */

import { type Client, type TextChannel } from 'discord.js';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { type ChallengeNotification, type SlotConfirmedNotification, type MatchSealedNotification } from './types.js';
import { buildChallengeEmbed, buildProposerEmbed, buildSlotConfirmedEmbed, buildMatchSealedEmbed } from './embeds.js';

let unsubscribe: (() => void) | null = null;

/**
 * Start listening for all pending notifications.
 * Called from module onReady.
 */
export function startListening(db: Firestore, client: Client): void {
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
    default:
      logger.warn('Unknown notification type', { type, id: doc.id });
      // Mark as delivered so we don't loop on it
      await doc.ref.update({ status: 'delivered', deliveredAt: FieldValue.serverTimestamp() });
  }
}

/**
 * challenge_proposed — two-target delivery: opponent channel (or DM) + proposer channel.
 */
async function handleChallengeProposed(
  client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  data: ChallengeNotification,
): Promise<void> {
  const notificationId = doc.id;

  logger.info('Processing challenge_proposed notification', {
    notificationId,
    proposer: `${data.proposerTeamTag} ${data.proposerTeamName}`,
    opponent: `${data.opponentTeamTag} ${data.opponentTeamName}`,
    gameType: data.gameType,
    slots: data.confirmedSlots.length,
  });

  let opponentChannelSent = false;
  let opponentDmSent = false;
  let proposerChannelSent = false;
  let error: string | undefined;

  // 1. Deliver to opponent
  const opp = data.delivery.opponent;

  if (opp.botRegistered && opp.notificationsEnabled && opp.channelId) {
    try {
      const channel = await client.channels.fetch(opp.channelId);
      if (channel && channel.isTextBased()) {
        const { embed, row } = buildChallengeEmbed(data);
        await (channel as TextChannel).send({ embeds: [embed], components: [row] });
        opponentChannelSent = true;
        logger.info('Challenge embed sent to opponent channel', { notificationId, channelId: opp.channelId });
      } else {
        logger.warn('Opponent channel not found or not text-based', { notificationId, channelId: opp.channelId });
      }
    } catch (err) {
      logger.warn('Failed to send to opponent channel, trying DM fallback', {
        notificationId,
        channelId: opp.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // DM fallback
  if (!opponentChannelSent && opp.leaderDiscordId) {
    try {
      const user = await client.users.fetch(opp.leaderDiscordId);
      const { embed, row } = buildChallengeEmbed(data);
      await user.send({ embeds: [embed], components: [row] });
      opponentDmSent = true;
      logger.info('Challenge embed sent via DM to opponent leader', { notificationId, leaderDiscordId: opp.leaderDiscordId });
    } catch (err) {
      logger.warn('Failed to DM opponent leader', {
        notificationId,
        leaderDiscordId: opp.leaderDiscordId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!opponentChannelSent && !opponentDmSent) {
    logger.warn('No delivery possible for opponent', {
      notificationId,
      botRegistered: opp.botRegistered,
      notificationsEnabled: opp.notificationsEnabled,
      hasChannel: !!opp.channelId,
      hasLeader: !!opp.leaderDiscordId,
    });
  }

  // 2. Deliver to proposer's channel
  const prop = data.delivery.proposer;

  if (prop.botRegistered && prop.notificationsEnabled && prop.channelId) {
    try {
      const channel = await client.channels.fetch(prop.channelId);
      if (channel && channel.isTextBased()) {
        const { embed, row } = buildProposerEmbed(data);
        await (channel as TextChannel).send({ embeds: [embed], components: [row] });
        proposerChannelSent = true;
        logger.info('Proposer confirmation embed sent', { notificationId, channelId: prop.channelId });
      }
    } catch (err) {
      logger.warn('Failed to send to proposer channel', {
        notificationId,
        channelId: prop.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const allFailed = !opponentChannelSent && !opponentDmSent && !proposerChannelSent;
  if (allFailed) error = 'All delivery attempts failed';

  await doc.ref.update({
    status: allFailed ? 'failed' : 'delivered',
    deliveredAt: FieldValue.serverTimestamp(),
    deliveryResult: {
      opponentChannelSent,
      opponentDmSent,
      proposerChannelSent,
      ...(error ? { error } : {}),
    },
  });

  logger.info('challenge_proposed processed', {
    notificationId,
    status: allFailed ? 'failed' : 'delivered',
    opponentChannelSent,
    opponentDmSent,
    proposerChannelSent,
  });
}

/**
 * slot_confirmed — single-target: send to the team that did NOT confirm.
 */
async function handleSlotConfirmed(
  client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  data: SlotConfirmedNotification,
): Promise<void> {
  const notificationId = doc.id;
  const delivery = data.delivery;

  logger.info('Processing slot_confirmed notification', {
    notificationId,
    confirmedBy: `${data.confirmedByTeamTag} ${data.confirmedByTeamName}`,
    recipient: `${data.recipientTeamTag} ${data.recipientTeamName}`,
    slotId: data.slotId,
  });

  let channelSent = false;
  let dmSent = false;

  if (delivery.botRegistered && delivery.notificationsEnabled && delivery.channelId) {
    try {
      const channel = await client.channels.fetch(delivery.channelId);
      if (channel && channel.isTextBased()) {
        const { embed, row } = buildSlotConfirmedEmbed(data);
        await (channel as TextChannel).send({ embeds: [embed], components: [row] });
        channelSent = true;
        logger.info('Slot confirmed embed sent to channel', { notificationId, channelId: delivery.channelId });
      }
    } catch (err) {
      logger.warn('Failed to send slot_confirmed to channel, trying DM fallback', {
        notificationId,
        channelId: delivery.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // DM fallback
  if (!channelSent && delivery.leaderDiscordId) {
    try {
      const user = await client.users.fetch(delivery.leaderDiscordId);
      const { embed, row } = buildSlotConfirmedEmbed(data);
      await user.send({ embeds: [embed], components: [row] });
      dmSent = true;
      logger.info('Slot confirmed embed sent via DM', { notificationId, leaderDiscordId: delivery.leaderDiscordId });
    } catch (err) {
      logger.warn('Failed to DM recipient leader for slot_confirmed', {
        notificationId,
        leaderDiscordId: delivery.leaderDiscordId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await doc.ref.update({
    status: (!channelSent && !dmSent) ? 'failed' : 'delivered',
    deliveredAt: FieldValue.serverTimestamp(),
    deliveryResult: { channelSent, dmSent },
  });

  logger.info('slot_confirmed processed', { notificationId, status: (!channelSent && !dmSent) ? 'failed' : 'delivered', channelSent, dmSent });
}

/**
 * match_sealed — single-target: send to the recipient team's channel only (no DM fallback).
 * MatchScheduler writes two docs — one per team — so each team gets their own notification.
 */
async function handleMatchSealed(
  client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  data: MatchSealedNotification,
): Promise<void> {
  const notificationId = doc.id;
  const delivery = data.delivery;

  logger.info('Processing match_sealed notification', {
    notificationId,
    proposer: `${data.proposerTeamTag} ${data.proposerTeamName}`,
    opponent: `${data.opponentTeamTag} ${data.opponentTeamName}`,
    recipient: `${data.recipientTeamTag} ${data.recipientTeamName}`,
    slotId: data.slotId,
  });

  let channelSent = false;

  if (delivery.botRegistered && delivery.notificationsEnabled && delivery.channelId) {
    try {
      const channel = await client.channels.fetch(delivery.channelId);
      if (channel && channel.isTextBased()) {
        const { embed, row } = buildMatchSealedEmbed(data);
        await (channel as TextChannel).send({ embeds: [embed], components: [row] });
        channelSent = true;
        logger.info('Match sealed embed sent', { notificationId, channelId: delivery.channelId });
      }
    } catch (err) {
      logger.warn('Failed to send match_sealed embed', {
        notificationId,
        channelId: delivery.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await doc.ref.update({
    status: !channelSent ? 'failed' : 'delivered',
    deliveredAt: FieldValue.serverTimestamp(),
    deliveryResult: { channelSent },
  });

  logger.info('match_sealed processed', { notificationId, status: !channelSent ? 'failed' : 'delivered', channelSent });
}
