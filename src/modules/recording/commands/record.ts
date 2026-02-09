import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import {
  joinVoiceChannel,
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

// Module-level state
let activeSession: RecordingSession | null = null;

export function isRecording(): boolean {
  return activeSession !== null;
}

export function getRecordingChannelId(): string | null {
  return activeSession?.channelId ?? null;
}

export function getRecordingGuildId(): string | null {
  return activeSession?.guildId ?? null;
}

export function getActiveSession(): RecordingSession | null {
  return activeSession;
}

export async function stopRecording(): Promise<SessionSummary | null> {
  if (!activeSession) return null;

  const session = activeSession;
  activeSession = null; // Clear immediately to prevent double-stop

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
  // Guard: already recording
  if (activeSession) {
    await interaction.reply({ content: 'Already recording.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Validate: user must be in a voice channel
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'You must be in a voice channel to start recording.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const config = loadConfig();
  const sessionId = randomUUID();

  logger.info('Recording start requested', {
    user: interaction.user.tag,
    guild: interaction.guildId,
    channel: voiceChannel.name,
    channelId: voiceChannel.id,
    sessionId,
  });

  // Create session and output directory
  activeSession = new RecordingSession({
    sessionId,
    recordingDir: config.recordingDir,
    guildId: interaction.guildId,
    guildName: interaction.guild.name,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name,
  });

  try {
    await activeSession.init();
  } catch (err) {
    logger.error('Failed to create session directory', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
    activeSession = null;
    await interaction.reply({ content: 'Failed to create recording directory.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch {
    connection.destroy();
    activeSession = null;
    await interaction.reply({ content: 'Failed to join voice channel (timeout).', flags: MessageFlags.Ephemeral });
    return;
  }

  // Start the session — sets up speaking listeners and subscribes to users
  activeSession.start(connection, interaction.guild);

  // If the connection is lost (kicked, network failure), auto-stop and save
  activeSession.onConnectionLost = () => {
    logger.warn('Connection lost — auto-stopping recording', { sessionId });
    stopRecording().catch((err) => {
      logger.error('Failed to auto-stop recording after connection loss', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      });
    });
  };

  // Count current users in the channel (excluding the bot)
  const userCount = voiceChannel.members.filter((m) => !m.user.bot).size;

  await interaction.reply({
    content: `Recording started in #${voiceChannel.name}. ${userCount} user(s) in channel.`,
    flags: MessageFlags.Ephemeral,
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
  if (!activeSession) {
    await interaction.reply({ content: 'Not currently recording.', flags: MessageFlags.Ephemeral });
    return;
  }

  const sessionId = activeSession.sessionId;

  logger.info('Recording stop requested', {
    user: interaction.user.tag,
    guild: interaction.guildId,
    sessionId,
  });

  // Defer reply since stopping may take a moment (flushing streams)
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const summary = await stopRecording();

  if (summary) {
    const durationSec = Math.round((summary.endTime.getTime() - summary.startTime.getTime()) / 1000);
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;
    const trackList = summary.tracks.map((t) => `  ${t.track_number}. ${t.discord_display_name}`).join('\n');

    await interaction.editReply({
      content: `Recording stopped. ${summary.trackCount} track(s), ${minutes}m ${seconds}s.\nSession: \`${summary.sessionId}\`\n${trackList}`,
    });
  } else {
    await interaction.editReply({ content: 'Recording stopped.' });
  }

  logger.info('Recording stopped', { sessionId, trackCount: summary?.trackCount });
}
