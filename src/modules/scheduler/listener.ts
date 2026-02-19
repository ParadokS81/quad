/**
 * Firestore listener — watches `notifications` collection for pending challenge notifications.
 *
 * When a challenge_proposed notification appears, delivers Discord embeds to:
 * 1. Opponent's configured channel (or DM fallback to their leader)
 * 2. Proposer's own channel (confirmation embed)
 *
 * Writes delivery status back to Firestore.
 */

import { type Client, type TextChannel } from 'discord.js';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { type ChallengeNotification } from './types.js';
import { buildChallengeEmbed, buildProposerEmbed } from './embeds.js';

let unsubscribe: (() => void) | null = null;

/**
 * Start listening for pending challenge notifications.
 * Called from module onReady.
 */
export function startListening(db: Firestore, client: Client): void {
  const query = db.collection('notifications')
    .where('status', '==', 'pending')
    .where('type', '==', 'challenge_proposed');

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
 * Handle a single pending notification — deliver embeds and update status.
 */
async function handleNotification(
  db: Firestore,
  client: Client,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<void> {
  const data = doc.data() as ChallengeNotification;
  const notificationId = doc.id;

  logger.info('Processing challenge notification', {
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
    // Try channel delivery
    try {
      const channel = await client.channels.fetch(opp.channelId);
      if (channel && channel.isTextBased()) {
        const { embed, row } = buildChallengeEmbed(data);
        await (channel as TextChannel).send({ embeds: [embed], components: [row] });
        opponentChannelSent = true;
        logger.info('Challenge embed sent to opponent channel', {
          notificationId,
          channelId: opp.channelId,
        });
      } else {
        logger.warn('Opponent channel not found or not text-based', {
          notificationId,
          channelId: opp.channelId,
        });
      }
    } catch (err) {
      logger.warn('Failed to send to opponent channel, trying DM fallback', {
        notificationId,
        channelId: opp.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // DM fallback if channel delivery didn't work
  if (!opponentChannelSent && opp.leaderDiscordId) {
    try {
      const user = await client.users.fetch(opp.leaderDiscordId);
      const { embed, row } = buildChallengeEmbed(data);
      await user.send({ embeds: [embed], components: [row] });
      opponentDmSent = true;
      logger.info('Challenge embed sent via DM to opponent leader', {
        notificationId,
        leaderDiscordId: opp.leaderDiscordId,
      });
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

  // 2. Deliver to proposer's team channel
  const prop = data.delivery.proposer;

  if (prop.botRegistered && prop.notificationsEnabled && prop.channelId) {
    try {
      const channel = await client.channels.fetch(prop.channelId);
      if (channel && channel.isTextBased()) {
        const { embed, row } = buildProposerEmbed(data);
        await (channel as TextChannel).send({ embeds: [embed], components: [row] });
        proposerChannelSent = true;
        logger.info('Proposer confirmation embed sent', {
          notificationId,
          channelId: prop.channelId,
        });
      }
    } catch (err) {
      logger.warn('Failed to send to proposer channel', {
        notificationId,
        channelId: prop.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Update notification status
  const allFailed = !opponentChannelSent && !opponentDmSent && !proposerChannelSent;

  if (allFailed) {
    error = 'All delivery attempts failed';
  }

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

  logger.info('Notification processed', {
    notificationId,
    status: allFailed ? 'failed' : 'delivered',
    opponentChannelSent,
    opponentDmSent,
    proposerChannelSent,
  });
}
