/**
 * Button interaction handler for standin DM buttons.
 *
 * Handles: standin_yes_{requestId}, standin_no_{requestId}, standin_stop_{requestId}
 * "Preferences" is a Link button — Discord handles it natively, no handler needed.
 */

import { type ButtonInteraction, MessageFlags } from 'discord.js';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { getDb } from './firestore.js';
import { type StandinRequest } from './types.js';

/** Button ID prefix for this module */
const PREFIX = 'standin_';

/**
 * Check if a button interaction belongs to this module.
 */
export function isStandinButton(customId: string): boolean {
  return customId.startsWith(PREFIX);
}

/**
 * Handle a standin button click.
 */
export async function handleStandinButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  const discordUserId = interaction.user.id;

  // Parse: standin_{action}_{requestId}
  const withoutPrefix = customId.slice(PREFIX.length);
  const underscoreIdx = withoutPrefix.indexOf('_');
  if (underscoreIdx === -1) {
    await interaction.reply({
      content: 'Invalid button.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const action = withoutPrefix.slice(0, underscoreIdx);
  const requestId = withoutPrefix.slice(underscoreIdx + 1);

  const db = getDb();
  const docRef = db.collection('standin_requests').doc(requestId);
  const doc = await docRef.get();

  if (!doc.exists) {
    await interaction.reply({
      content: 'This standin request no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const request = doc.data() as StandinRequest;

  // Check if request is still active
  if (request.status !== 'pending') {
    const statusMessages: Record<string, string> = {
      confirmed: 'This standin request has already been filled.',
      cancelled: 'This standin request was cancelled.',
      expired: 'This standin request has expired.',
    };
    await interaction.reply({
      content: statusMessages[request.status] || 'This request is no longer active.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (action) {
    case 'yes':
      await handleAccept(interaction, docRef, discordUserId, request);
      break;
    case 'no':
      await handleDecline(interaction, docRef, discordUserId, request);
      break;
    case 'stop':
      await handleStopAll(interaction, discordUserId);
      break;
    default:
      await interaction.reply({
        content: 'Unknown action.',
        flags: MessageFlags.Ephemeral,
      });
  }
}

async function handleAccept(
  interaction: ButtonInteraction,
  docRef: FirebaseFirestore.DocumentReference,
  discordUserId: string,
  request: StandinRequest,
): Promise<void> {
  await docRef.update({
    [`responses.${discordUserId}.status`]: 'accepted',
    [`responses.${discordUserId}.respondedAt`]: FieldValue.serverTimestamp(),
  });

  const teamDisplay = request.requestedBy.teamTag
    ? `${request.requestedBy.teamName} ${request.requestedBy.teamTag}`
    : request.requestedBy.teamName;

  await interaction.reply({
    content: `You accepted the standin request for **${teamDisplay}** — ${request.match.displayTime}. They'll confirm shortly!`,
    flags: MessageFlags.Ephemeral,
  });

  logger.info('Standin accepted', {
    requestId: request.requestId,
    discordUserId,
  });
}

async function handleDecline(
  interaction: ButtonInteraction,
  docRef: FirebaseFirestore.DocumentReference,
  discordUserId: string,
  request: StandinRequest,
): Promise<void> {
  await docRef.update({
    [`responses.${discordUserId}.status`]: 'declined',
    [`responses.${discordUserId}.respondedAt`]: FieldValue.serverTimestamp(),
  });

  await interaction.reply({
    content: 'No worries. Thanks for letting them know!',
    flags: MessageFlags.Ephemeral,
  });

  logger.info('Standin declined', {
    requestId: request.requestId,
    discordUserId,
  });
}

async function handleStopAll(
  interaction: ButtonInteraction,
  discordUserId: string,
): Promise<void> {
  const db = getDb();
  const schedulerUrl = process.env.SCHEDULER_URL || 'https://scheduler.quake.world';

  await db.collection('standin_preferences').doc(discordUserId).set(
    {
      discordUserId,
      discordUsername: interaction.user.username,
      optedOut: true,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await interaction.reply({
    content: `Stopped. You won't receive standin requests anymore.\nYou can re-enable or fine-tune at ${schedulerUrl}/#standin-preferences`,
    flags: MessageFlags.Ephemeral,
  });

  logger.info('User opted out of standin requests', { discordUserId });
}
