import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { randomUUID } from 'node:crypto';
import { logger } from '../../../core/logger.js';
import { loadConfig } from '../../../core/config.js';
import { RecordingSession, type SessionSummary } from '../session.js';

export const recordCommand = new SlashCommandBuilder()
  .setName('record')
  .setDescription('Voice recording commands')
  .addSubcommand((sub) =>
    sub.setName('start').setDescription('Start recording the voice channel')
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Stop recording and save files')
  ) as SlashCommandBuilder;

// Module-level state — per-guild sessions for concurrent multi-server recording
const activeSessions = new Map<string, RecordingSession>();

// Post-recording callbacks (e.g., auto-trigger processing pipeline)
type RecordingStopCallback = (sessionDir: string, sessionId: string) => void;
const onStopCallbacks: RecordingStopCallback[] = [];

/**
 * Register a callback to fire after a recording session stops successfully.
 * Used by the processing module to auto-trigger the fast pipeline.
 */
export function onRecordingStop(callback: RecordingStopCallback): void {
  onStopCallbacks.push(callback);
}

export function isRecording(guildId?: string): boolean {
  if (guildId) return activeSessions.has(guildId);
  return activeSessions.size > 0;
}

export function getRecordingChannelId(guildId: string): string | null {
  return activeSessions.get(guildId)?.channelId ?? null;
}

export function getRecordingGuildId(): string | null {
  // Legacy: return first active guild (used by health endpoint)
  const first = activeSessions.values().next();
  return first.done ? null : first.value.guildId;
}

export function getActiveSession(guildId?: string): RecordingSession | null {
  if (guildId) return activeSessions.get(guildId) ?? null;
  // Legacy: return first (for health endpoint)
  const first = activeSessions.values().next();
  return first.done ? null : first.value;
}

/** Get all active sessions (for health endpoint / shutdown). */
export function getActiveSessions(): Map<string, RecordingSession> {
  return activeSessions;
}

export async function stopRecording(guildId: string): Promise<SessionSummary | null> {
  const session = activeSessions.get(guildId);
  if (!session) return null;

  activeSessions.delete(guildId); // Clear immediately to prevent double-stop

  try {
    return await session.stop();
  } catch (err) {
    logger.error('Error during session stop — files may be partial', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: session.sessionId,
    });
    return null;
  }
}

/**
 * Stop recording and fire post-recording callbacks. Used by both /record stop and idle auto-stop.
 * Returns the session summary (or null if no active session).
 */
export async function performStop(guildId: string, reason: string): Promise<SessionSummary | null> {
  const session = activeSessions.get(guildId);
  if (!session) return null;

  const sessionId = session.sessionId;
  logger.info(`Recording stop: ${reason}`, { sessionId, guildId });

  const summary = await stopRecording(guildId);
  logger.info('Recording stopped', { sessionId, reason, trackCount: summary?.trackCount });

  fireStopCallbacks(summary);
  return summary;
}

function fireStopCallbacks(summary: SessionSummary | null): void {
  if (!summary) return;
  for (const cb of onStopCallbacks) {
    try {
      cb(summary.outputDir, summary.sessionId);
    } catch (err) {
      logger.error('Post-recording callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

export async function handleRecordCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'start':
      await handleStart(interaction);
      break;
    case 'stop':
      await handleStop(interaction);
      break;
    default:
      await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, flags: MessageFlags.Ephemeral });
  }
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Guard: already recording in THIS guild
  if (activeSessions.has(interaction.guildId)) {
    await interaction.reply({ content: 'Already recording in this server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Validate: user must be in a voice channel
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'You must be in a voice channel to start recording.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Defer reply immediately — voice join can take several seconds
  await interaction.deferReply();

  const config = loadConfig();
  const sessionId = randomUUID();
  const guildId = interaction.guildId;

  logger.info('Recording start requested', {
    user: interaction.user.tag,
    guild: guildId,
    channel: voiceChannel.name,
    channelId: voiceChannel.id,
    sessionId,
    concurrentSessions: activeSessions.size,
  });

  // Create session and output directory
  const session = new RecordingSession({
    sessionId,
    recordingDir: config.recordingDir,
    guildId,
    guildName: interaction.guild.name,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name,
  });

  try {
    await session.init();
  } catch (err) {
    logger.error('Failed to create session directory', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
    await interaction.editReply({ content: 'Failed to create recording directory.' });
    return;
  }

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch {
    // Ensure the bot fully leaves the voice channel
    connection.destroy();
    // Belt-and-suspenders: also try getVoiceConnection in case destroy didn't clean up
    const lingering = getVoiceConnection(guildId);
    if (lingering) lingering.destroy();

    await interaction.editReply({ content: 'Failed to join voice channel (timeout). Please try again.' });
    return;
  }

  // Register session BEFORE starting — so VoiceStateUpdate handler can find it
  activeSessions.set(guildId, session);

  // Start the session — sets up speaking listeners and subscribes to users
  session.start(connection, interaction.guild);

  // If the connection is lost (kicked, network failure), auto-stop and save
  session.onConnectionLost = () => {
    logger.warn('Connection lost — auto-stopping recording', { sessionId, guildId });
    stopRecording(guildId).catch((err) => {
      logger.error('Failed to auto-stop recording after connection loss', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      });
    });
  };

  // Count current users in the channel (excluding the bot)
  const userCount = voiceChannel.members.filter((m) => !m.user.bot).size;
  const startUnix = Math.floor(session.startTime.getTime() / 1000);
  const shortId = sessionId.slice(0, 8);

  await interaction.editReply({
    content: [
      `\u{1F534} **Recording started**`,
      ``,
      `**Channel:** <#${voiceChannel.id}>`,
      `**Recording ID:** \`${shortId}\``,
      `**Started:** <t:${startUnix}:t>`,
      `**Users in channel:** ${userCount}`,
    ].join('\n'),
  });

  logger.info('Recording started', {
    sessionId,
    channel: voiceChannel.name,
    channelId: voiceChannel.id,
    guild: interaction.guildId,
    usersInChannel: userCount,
  });
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !activeSessions.has(guildId)) {
    await interaction.reply({ content: 'Not currently recording in this server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const sessionId = activeSessions.get(guildId)!.sessionId;

  logger.info('Recording stop requested', {
    user: interaction.user.tag,
    guild: guildId,
    sessionId,
  });

  // CRITICAL: Stop the recording FIRST, then try to reply.
  // If deferReply/editReply fail (Discord API hiccup), the recording is still saved.
  const summary = await stopRecording(guildId);

  // Best-effort reply to the interaction — never let a Discord API error undo the stop
  try {
    await interaction.deferReply();

    if (summary) {
      const durationSec = Math.round((summary.endTime.getTime() - summary.startTime.getTime()) / 1000);
      const duration = formatDuration(durationSec);
      const shortId = summary.sessionId.slice(0, 8);
      const trackList = summary.tracks.map((t) => `${t.track_number}. ${t.discord_display_name}`).join('\n');

      await interaction.editReply({
        content: [
          `\u2B1B **Recording ended**`,
          ``,
          `**Channel:** <#${summary.channelId}>`,
          `**Recording ID:** \`${shortId}\``,
          `**Duration:** ${duration}`,
          `**Tracks:** ${summary.trackCount}`,
          ``,
          trackList,
        ].join('\n'),
      });
    } else {
      await interaction.editReply({ content: 'Recording stopped.' });
    }
  } catch (err) {
    logger.warn('Could not reply to stop interaction — recording was still saved', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
  }

  logger.info('Recording stopped', { sessionId, trackCount: summary?.trackCount });

  // Fire post-recording callbacks (e.g., auto-trigger processing)
  fireStopCallbacks(summary);
}
