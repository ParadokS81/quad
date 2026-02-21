import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type VoiceBasedChannel,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  type VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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
const joiningGuilds = new Set<string>(); // Prevent concurrent join attempts per guild

// Lifecycle callbacks
type RecordingStartCallback = (session: RecordingSession) => void;
const onStartCallbacks: RecordingStartCallback[] = [];

type RecordingStopCallback = (sessionDir: string, sessionId: string) => void;
const onStopCallbacks: RecordingStopCallback[] = [];

type ParticipantChangeCallback = (guildId: string, participants: string[]) => void;
const onParticipantChangeCallbacks: ParticipantChangeCallback[] = [];

export function onRecordingStart(callback: RecordingStartCallback): void {
  onStartCallbacks.push(callback);
}

/**
 * Register a callback to fire after a recording session stops successfully.
 * Used by the processing module to auto-trigger the fast pipeline.
 */
export function onRecordingStop(callback: RecordingStopCallback): void {
  onStopCallbacks.push(callback);
}

export function onParticipantChange(callback: ParticipantChangeCallback): void {
  onParticipantChangeCallbacks.push(callback);
}

export function fireParticipantChangeCallbacks(guildId: string, participants: string[]): void {
  for (const cb of onParticipantChangeCallbacks) {
    try {
      cb(guildId, participants);
    } catch (err) {
      logger.error('Participant change callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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

/**
 * Check bot permissions in a voice channel before attempting to join.
 * Returns null if all good, or a user-facing error string if something is missing.
 */
function checkVoicePermissions(channel: VoiceBasedChannel, botMember: GuildMember): string | null {
  const perms = channel.permissionsFor(botMember);
  if (!perms) return 'Could not check permissions — the bot role may be misconfigured.';

  const required: Array<{ flag: bigint; name: string }> = [
    { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { flag: PermissionFlagsBits.Connect, name: 'Connect' },
    { flag: PermissionFlagsBits.Speak, name: 'Speak' },
  ];

  const lines = required.map(({ flag, name }) => {
    const has = perms.has(flag);
    return has ? `  ✓  ${name}` : `  ✗  **${name}** ← missing`;
  });

  const hasMissing = required.some(({ flag }) => !perms.has(flag));

  if (hasMissing) {
    return [
      `The bot is missing permissions in <#${channel.id}>:`,
      '',
      ...lines,
      '',
      'To fix: right-click the voice channel → **Edit Channel** → **Permissions** → add the bot\'s role → enable all three.',
    ].join('\n');
  }

  // Check channel user limit
  if (channel.userLimit > 0 && channel.members.size >= channel.userLimit) {
    return `Voice channel <#${channel.id}> is full (${channel.userLimit}/${channel.userLimit}). Make room or increase the user limit.`;
  }

  return null;
}

/**
 * Attempt to join a voice channel with one automatic retry.
 * The DAVE (Discord Audio & Video E2E Encryption) handshake can take 15-20+ seconds
 * on first connection, or fail transiently. We use a 30s timeout and retry once.
 */
async function joinWithRetry(opts: {
  voiceChannel: VoiceBasedChannel;
  guildId: string;
  sessionId: string;
}): Promise<VoiceConnection | null> {
  const { voiceChannel, guildId, sessionId } = opts;
  const maxAttempts = 2;
  const timeout = 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    // Log state transitions for debugging
    const stateLog = (oldState: { status: string }, newState: { status: string }) => {
      logger.info('Voice connection state change', {
        sessionId, attempt,
        from: oldState.status, to: newState.status,
      });
    };
    connection.on('stateChange', stateLog);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, timeout);
      connection.off('stateChange', stateLog);
      return connection;
    } catch {
      connection.off('stateChange', stateLog);
      const isLastAttempt = attempt === maxAttempts;

      logger.warn('Voice connection failed', {
        sessionId, guildId,
        channel: voiceChannel.name,
        attempt: `${attempt}/${maxAttempts}`,
        timeoutMs: timeout,
      });

      // Just destroy the connection — do NOT create temp connections (poisons DAVE state)
      try { connection.destroy(); } catch { /* already destroyed */ }

      if (!isLastAttempt) {
        logger.info('Retrying voice connection in 2s', { sessionId, attempt });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return null;
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

  // Guard: already recording or joining in THIS guild
  if (activeSessions.has(interaction.guildId)) {
    await interaction.reply({ content: 'Already recording in this server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (joiningGuilds.has(interaction.guildId)) {
    await interaction.reply({ content: 'Already connecting — please wait.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Validate: user must be in a voice channel
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'You must be in a voice channel to start recording.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Pre-check: does the bot have the permissions it needs?
  const botMember = interaction.guild.members.me;
  if (botMember) {
    const permError = checkVoicePermissions(voiceChannel, botMember);
    if (permError) {
      await interaction.reply({ content: permError, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  // Defer reply immediately — voice join can take several seconds (DAVE handshake)
  await interaction.deferReply();

  // Lock this guild while joining — prevents concurrent /record start race condition
  joiningGuilds.add(interaction.guildId);

  // Clean up any stale @discordjs/voice internal state (NOT a DAVE handshake — just memory cleanup)
  const existingConnection = getVoiceConnection(interaction.guildId);
  if (existingConnection) {
    logger.info('Cleaning up stale voice connection state', { guildId: interaction.guildId });
    try { existingConnection.destroy(); } catch { /* already destroyed */ }
  }

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
    joiningGuilds.delete(guildId);
    logger.error('Failed to create session directory', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
    await interaction.editReply({ content: 'Failed to create recording directory.' });
    return;
  }

  // Join voice channel — with retry for transient DAVE handshake failures
  const connection = await joinWithRetry({
    voiceChannel,
    guildId,
    sessionId,
  });

  if (!connection) {
    joiningGuilds.delete(guildId);
    // Clean up empty session directory from failed attempt
    await rm(session.outputDir, { recursive: true, force: true }).catch(() => {});

    // Ensure bot actually leaves the voice channel at the gateway level.
    // connection.destroy() in joinWithRetry may not send a gateway disconnect
    // if the DAVE handshake never completed, leaving the bot visually stuck.
    try {
      const me = interaction.guild?.members.me;
      if (me?.voice.channelId) await me.voice.disconnect();
    } catch { /* best effort */ }

    await interaction.editReply({
      content: [
        'Failed to join voice channel after 2 attempts. Make sure the bot has all three permissions on this channel:',
        '',
        '  •  **View Channel**',
        '  •  **Connect**',
        '  •  **Speak**',
        '',
        'To fix: right-click the voice channel → **Edit Channel** → **Permissions** → add the bot\'s role → enable all three.',
        '',
        'If permissions look correct, check for channel-level overrides that might be blocking the bot\'s role.',
      ].join('\n'),
    });
    return;
  }

  // Voice connected — release the joining lock
  joiningGuilds.delete(guildId);

  // Register session BEFORE starting — so VoiceStateUpdate handler can find it
  activeSessions.set(guildId, session);

  // Start the session — sets up speaking listeners and subscribes to users
  session.start(connection, interaction.guild);

  // Fire start callbacks (e.g., Firestore session tracker)
  const initialParticipants = voiceChannel.members
    .filter((m) => !m.user.bot)
    .map((m) => m.displayName);
  for (const cb of onStartCallbacks) {
    try {
      cb(session);
    } catch (err) {
      logger.error('Post-recording-start callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Also fire initial participant snapshot
  fireParticipantChangeCallbacks(guildId, initialParticipants);

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
    // Clean up any stale @discordjs/voice state (no DAVE handshake — just memory cleanup)
    if (guildId) {
      const vc = getVoiceConnection(guildId);
      if (vc) {
        try { vc.destroy(); } catch { /* */ }
        await interaction.reply({ content: 'Not recording, but cleaned up stale voice state. Try `/record start` again.', flags: MessageFlags.Ephemeral });
        return;
      }
    }
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
