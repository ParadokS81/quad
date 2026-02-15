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
 * destroy voice connection, leave the guild, and delete the Firestore doc.
 */
async function handleDisconnectRequest(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  client: Client,
): Promise<void> {
  const data = doc.data();
  const guildId = data.guildId as string | undefined;

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
    const activeSession = getActiveSession();
    if (activeSession?.guildId === guildId) {
      logger.info('Stopping active recording in disconnecting guild', { guildId });
      await performStop('guild disconnect request');
    }

    // Destroy voice connection if any
    const voiceConnection = getVoiceConnection(guildId);
    if (voiceConnection) {
      voiceConnection.destroy();
      logger.info('Destroyed voice connection', { guildId });
    }

    // Leave the Discord guild
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      const guildName = guild.name;
      await guild.leave();
      logger.info('Left guild', { guildId, guildName });
    } else {
      logger.info('Guild not found in cache (bot may already have been removed)', { guildId });
    }
  } catch (err) {
    // If guild.leave() fails (bot was already kicked), still delete the doc
    logger.warn('Error during disconnect cleanup, will still delete doc', {
      docId: doc.id,
      guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Always delete the Firestore document
  await doc.ref.delete();
  logger.info('Disconnect request completed — doc deleted', {
    docId: doc.id,
    teamId: data.teamId,
    guildId,
  });
}
