/**
 * Listens for disconnect requests from MatchScheduler.
 * When a team leader clicks "Disconnect", the Cloud Function sets
 * botRegistrations status to 'disconnecting'. We pick that up,
 * stop any active recording, leave the guild, and delete the doc.
 */

import { type Client } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { getActiveSession, performStop } from '../recording/commands/record.js';

let unsubscribe: (() => void) | null = null;

/**
 * Start listening for disconnect requests.
 * Called from the registration module's onReady when Firebase is configured.
 */
export function startDisconnectListener(db: Firestore, client: Client): void {
  const query = db.collection('botRegistrations').where('status', '==', 'disconnecting');

  unsubscribe = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          handleDisconnectRequest(change.doc, client).catch((err) => {
            logger.error('Disconnect request handler failed', {
              docId: change.doc.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    },
    (err) => {
      logger.error('Disconnect listener error', {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  logger.info('Disconnect request listener started');
}

/**
 * Stop the disconnect listener. Called on module shutdown.
 */
export function stopDisconnectListener(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
    logger.info('Disconnect request listener stopped');
  }
}

/**
 * Handle a single disconnect request: stop recording if active in this guild,
 * destroy voice connection, delete the Firestore doc, then leave the guild
 * only if no other active registrations remain.
 */
async function handleDisconnectRequest(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  client: Client,
): Promise<void> {
  const data = doc.data();
  const guildId = data.guildId as string | undefined;
  const db = doc.ref.firestore;

  if (!guildId) {
    logger.warn('Disconnect request missing guildId, deleting doc', { docId: doc.id });
    await doc.ref.delete();
    return;
  }

  logger.info('Processing disconnect request', {
    docId: doc.id,
    teamId: data.teamId,
    teamName: data.teamName,
    guildId,
  });

  try {
    // Stop active recording if it's in this guild
    const activeSession = getActiveSession(guildId);
    if (activeSession) {
      logger.info('Stopping active recording in disconnecting guild', { guildId });
      await performStop(guildId, 'guild disconnect request');
    }

    // Destroy voice connection if any
    const voiceConnection = getVoiceConnection(guildId);
    if (voiceConnection) {
      voiceConnection.destroy();
      logger.info('Destroyed voice connection', { guildId });
    }
  } catch (err) {
    logger.warn('Error during disconnect cleanup, will still delete doc', {
      docId: doc.id,
      guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Delete the Firestore document BEFORE checking remaining registrations,
  // so the check correctly excludes the just-disconnected team.
  await doc.ref.delete();
  logger.info('Disconnect request completed — doc deleted', {
    docId: doc.id,
    teamId: data.teamId,
    guildId,
  });

  // Check if other teams are still registered in this guild
  const remainingRegs = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (remainingRegs.empty) {
    // No other teams — leave the guild
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      const guildName = guild.name;
      try {
        await guild.leave();
        logger.info('Left guild (last team disconnected)', { guildId, guildName });
      } catch (err) {
        logger.warn('Failed to leave guild (bot may already have been removed)', {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.info('Guild not found in cache (bot may already have been removed)', { guildId });
    }
  } else {
    logger.info('Other teams still registered — staying in guild', {
      guildId,
      remainingTeams: remainingRegs.size,
    });
  }
}
