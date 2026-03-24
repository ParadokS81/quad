import {
  ChatInputCommandInteraction,
  type Guild,
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
import { sessionRegistry } from '../../../shared/session-registry.js';
import { getRegistrationForGuild } from '../../registration/register.js';
import { startMumbleRecording, stopMumbleRecording, getMumbleChannelUsers } from '../../mumble/index.js';

export const recordCommand = new SlashCommandBuilder()
  .setName('record')
  .setDescription('Voice recording commands')
  .addSubcommand((sub) =>
    sub.setName('start')
      .setDescription('Start recording — auto-detects platform or specify one')
      .addStringOption((opt) =>
        opt.setName('platform')
          .setDescription('Which voice platform to record')
          .setRequired(false)
          .addChoices(
            { name: 'Discord', value: 'discord' },
            { name: 'Mumble', value: 'mumble' },
          )
      )
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Stop all active recordings for your team')
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show active recording status')
  )
  .addSubcommand((sub) =>
    sub.setName('reset').setDescription('Force-reset: stop recording, leave voice, clear all state')
  ) as SlashCommandBuilder;

// Module-level state — per-guild sessions for concurrent multi-server recording
const activeSessions = new Map<string, RecordingSession>();
const joiningGuilds = new Set<string>(); // Prevent concurrent join attempts per guild

// Reference to DiscordAutoRecord engine — set by recording/index.ts to avoid circular imports
interface DiscordAutoRecordRef { suppress: (guildId: string) => void; }
let _discordAutoRecord: DiscordAutoRecordRef | null = null;
export function setDiscordAutoRecord(ar: DiscordAutoRecordRef): void {
  _discordAutoRecord = ar;
}

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
  sessionRegistry.unregister(`discord:${guildId}`);

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
export function checkVoicePermissions(channel: VoiceBasedChannel, botMember: GuildMember): string | null {
  const perms = channel.permissionsFor(botMember);
  if (!perms) return 'Could not check permissions — the bot role may be misconfigured.';

  const required: Array<{ flag: bigint; name: string }> = [
    { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { flag: PermissionFlagsBits.Connect, name: 'Connect' },
    { flag: PermissionFlagsBits.Speak, name: 'Speak' },
    { flag: PermissionFlagsBits.MoveMembers, name: 'Move Members' },
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
      'To fix: right-click the voice channel → **Edit Channel** → **Permissions** → add the bot\'s role → enable all four.',
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
  const maxAttempts = 3;
  const timeoutPerAttempt = 30_000;
  const maxBounces = 50; // Safety net — abort if stuck in loop for ~15s

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      debug: true,
      // Lower from default 36 — triggers DAVE session reinit faster on key rotation failures.
      // At 50 packets/sec, 10 failures = ~200ms before reinit (vs ~720ms at 36).
      decryptionFailureTolerance: 10,
    });

    // Log DAVE/networking debug events — info level so they show in production logs
    const debugLog = (message: string) => {
      logger.info('Voice debug', { sessionId, attempt, message });
    };
    connection.on('debug', debugLog);

    // Track state bounces — if Signalling↔Connecting loops too many times, bail early
    let bounceCount = 0;
    let lastStatus = '';
    let abortController: AbortController | null = new AbortController();

    const stateLog = (oldState: { status: string }, newState: { status: string }) => {
      logger.info('Voice state', {
        sessionId, attempt,
        from: oldState.status, to: newState.status,
      });

      // Detect the auto-rejoin loop: Connecting→Signalling→Connecting...
      if (newState.status === VoiceConnectionStatus.Signalling && lastStatus === VoiceConnectionStatus.Connecting) {
        bounceCount++;
        if (bounceCount >= maxBounces) {
          logger.warn('Voice connection stuck in Signalling↔Connecting loop — aborting attempt early', {
            sessionId, attempt, bounceCount,
          });
          abortController?.abort();
        }
      }
      lastStatus = newState.status;
    };
    connection.on('stateChange', stateLog);

    try {
      // Combine timeout + bounce detection into one abort signal (Node 22+ required)
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutPerAttempt),
        abortController.signal,
      ]);
      await entersState(connection, VoiceConnectionStatus.Ready, signal);
      connection.off('stateChange', stateLog);
      connection.off('debug', debugLog);
      abortController = null;
      return connection;
    } catch {
      connection.off('stateChange', stateLog);
      connection.off('debug', debugLog);
      abortController = null;
      const isLastAttempt = attempt === maxAttempts;

      logger.warn('Voice connection failed', {
        sessionId, guildId,
        channel: voiceChannel.name,
        attempt: `${attempt}/${maxAttempts}`,
        bounceCount,
        timeoutMs: timeoutPerAttempt,
      });

      // Just destroy the connection — do NOT create temp connections (poisons DAVE state)
      try { connection.destroy(); } catch { /* already destroyed */ }

      if (!isLastAttempt) {
        // 5s delay — Discord needs time to fully tear down the DAVE session
        logger.info('Retrying voice connection in 5s', { sessionId, attempt });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return null;
}

/**
 * Start a recording session in a voice channel.
 * Shared by both manual /record start and the auto-record engine.
 * Returns the session and a summary string, or null if unable to start.
 */
export async function startRecordingSession(opts: {
  voiceChannel: VoiceBasedChannel;
  guild: Guild;
  sourceTextChannelId?: string;
  origin: 'manual' | 'auto';
  teamId: string;
}): Promise<{ session: RecordingSession; summary: string } | null> {
  const { voiceChannel, guild, sourceTextChannelId, origin, teamId } = opts;
  const guildId = guild.id;

  // Guard: already recording or joining in THIS guild
  if (activeSessions.has(guildId)) {
    logger.debug('startRecordingSession blocked — already recording', { guildId });
    return null;
  }
  if (joiningGuilds.has(guildId)) {
    logger.debug('startRecordingSession blocked — already joining', { guildId });
    return null;
  }

  // Lock this guild while joining — prevents concurrent start race condition
  joiningGuilds.add(guildId);

  // Clean up any stale @discordjs/voice internal state (NOT a DAVE handshake — just memory cleanup)
  const existingConnection = getVoiceConnection(guildId);
  if (existingConnection) {
    logger.info('Cleaning up stale voice connection state', { guildId });
    try { existingConnection.destroy(); } catch { /* already destroyed */ }
  }

  const config = loadConfig();
  const sessionId = randomUUID();

  logger.info('Recording start', {
    origin,
    guild: guildId,
    channel: voiceChannel.name,
    channelId: voiceChannel.id,
    sessionId,
    concurrentSessions: activeSessions.size,
  });

  const session = new RecordingSession({
    sessionId,
    recordingDir: config.recordingDir,
    guildId,
    guildName: guild.name,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name,
    sourceTextChannelId,
  });

  try {
    await session.init();
  } catch (err) {
    joiningGuilds.delete(guildId);
    logger.error('Failed to create session directory', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
    return null;
  }

  const connection = await joinWithRetry({ voiceChannel, guildId, sessionId });

  if (!connection) {
    joiningGuilds.delete(guildId);
    await rm(session.outputDir, { recursive: true, force: true }).catch(() => {});

    // Ensure bot actually leaves via REST API
    try {
      const me = guild.members.me;
      if (me?.voice.channelId) {
        await me.voice.disconnect();
        logger.info('REST disconnect after join failure', { guildId });
      }
    } catch (err) {
      logger.warn('REST disconnect failed after join failure', {
        guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  // Voice connected — release the joining lock
  joiningGuilds.delete(guildId);

  // Register session BEFORE starting — so VoiceStateUpdate handler can find it
  activeSessions.set(guildId, session);
  sessionRegistry.register(`discord:${guildId}`, {
    platform: 'discord',
    origin,
    sessionId: session.sessionId,
    channelId: session.channelId,
    guildId,
    teamId,
    startTime: session.startTime,
  });

  // Start the session — sets up speaking listeners and subscribes to users
  session.start(connection, guild);

  // Fire start callbacks (e.g., Firestore session tracker)
  for (const cb of onStartCallbacks) {
    try {
      cb(session);
    } catch (err) {
      logger.error('Post-recording-start callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fire initial participant snapshot
  const initialParticipants = voiceChannel.members
    .filter((m) => !m.user.bot)
    .map((m) => m.displayName);
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

  const userCount = voiceChannel.members.filter((m) => !m.user.bot).size;
  const startUnix = Math.floor(session.startTime.getTime() / 1000);
  const shortId = sessionId.slice(0, 8);

  logger.info('Recording started', {
    sessionId, origin,
    channel: voiceChannel.name,
    channelId: voiceChannel.id,
    guild: guildId,
    usersInChannel: userCount,
  });

  return {
    session,
    summary: [
      `**Channel:** <#${voiceChannel.id}>`,
      `**Recording ID:** \`${shortId}\``,
      `**Started:** <t:${startUnix}:t>`,
      `**Users in channel:** ${userCount}`,
    ].join('\n'),
  };
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
    case 'status':
      await handleStatus(interaction);
      break;
    case 'reset':
      await handleReset(interaction);
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

  const guildId = interaction.guildId;
  const explicitPlatform = interaction.options.getString('platform') as 'discord' | 'mumble' | null;
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  // --- Mumble path: explicit platform:mumble, or auto-detect when user is not in Discord voice ---
  if (explicitPlatform === 'mumble' || (!explicitPlatform && !voiceChannel)) {
    const registration = await getRegistrationForGuild(guildId);

    if (!registration) {
      const msg = explicitPlatform
        ? 'No team registration found for this server.'
        : 'No active voice channel found. Join a Discord voice channel or have team members in Mumble.';
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }

    // For auto-detect: confirm Mumble channel has users
    if (!explicitPlatform) {
      const mumbleUsers = getMumbleChannelUsers(registration.teamId);
      if (mumbleUsers.length === 0) {
        await interaction.reply({
          content: 'No active voice channel found. Join a Discord voice channel or have team members in Mumble.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // Permission: user must be a registered team member
    if (!(interaction.user.id in registration.knownPlayers)) {
      await interaction.reply({
        content: 'Only registered team members can start Mumble recording.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    const session = await startMumbleRecording(registration.teamId);
    if (!session) {
      await interaction.editReply('Failed to start Mumble recording. Is the Mumble channel active?');
      return;
    }

    await interaction.editReply([
      `\u{1F534} **Recording started**`,
      ``,
      `**Platform:** Mumble`,
      `**Channel:** ${session.channelName}`,
    ].join('\n'));
    return;
  }

  // --- Discord path: explicit platform:discord, or auto-detect when user is in Discord voice ---

  // Guard: already recording or joining in THIS guild
  if (activeSessions.has(guildId)) {
    const existing = activeSessions.get(guildId)!;
    logger.warn('Record start blocked — already recording', {
      guildId,
      guildName: interaction.guild.name,
      existingSessionId: existing.sessionId,
      existingChannel: existing.channelId,
      allActiveGuilds: [...activeSessions.keys()],
      user: interaction.user.tag,
    });
    await interaction.reply({ content: 'Already recording in this server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (joiningGuilds.has(guildId)) {
    logger.warn('Record start blocked — already joining', {
      guildId,
      guildName: interaction.guild.name,
      allJoiningGuilds: [...joiningGuilds],
      user: interaction.user.tag,
    });
    await interaction.reply({ content: 'Already connecting — please wait.', flags: MessageFlags.Ephemeral });
    return;
  }

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

  // Look up team registration for teamId (used in session registry for cross-platform stop)
  const registration = await getRegistrationForGuild(guildId);

  if (!registration) {
    await interaction.editReply('No team registration found for this server. Use `/register` first.');
    return;
  }

  const result = await startRecordingSession({
    voiceChannel,
    guild: interaction.guild,
    sourceTextChannelId: interaction.channelId,
    origin: 'manual',
    teamId: registration.teamId,
  });

  if (!result) {
    await interaction.editReply({
      content: [
        'Failed to join voice channel after 3 attempts. Make sure the bot has all four permissions on this channel:',
        '',
        '  •  **View Channel**',
        '  •  **Connect**',
        '  •  **Speak**',
        '  •  **Move Members**',
        '',
        'To fix: right-click the voice channel → **Edit Channel** → **Permissions** → add the bot\'s role → enable all four.',
        '',
        'If permissions look correct, check for channel-level overrides that might be blocking the bot\'s role.',
      ].join('\n'),
    });
    return;
  }

  const { session } = result;
  const userCount = voiceChannel.members.filter((m) => !m.user.bot).size;
  const startUnix = Math.floor(session.startTime.getTime() / 1000);
  const shortId = session.sessionId.slice(0, 8);

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
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Must be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Check registry for active sessions across all platforms
  const sessions = sessionRegistry.getByGuildId(guildId);

  if (sessions.length === 0) {
    // No tracked sessions — clean up stale @discordjs/voice state if any
    const vc = getVoiceConnection(guildId);
    if (vc) {
      try { vc.destroy(); } catch { /* */ }
      await interaction.reply({ content: 'Not recording, but cleaned up stale voice state. Try `/record start` again.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: 'No active recordings in this server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const replyLines: string[] = [];

  for (const regSession of sessions) {
    if (regSession.platform === 'discord') {
      logger.info('Recording stop requested', {
        user: interaction.user.tag,
        guildId,
        guildName: interaction.guild?.name,
        sessionId: regSession.sessionId,
        allActiveGuilds: [...activeSessions.keys()],
      });

      const summary = await stopRecording(guildId);

      // Suppress Discord auto-record if this was an auto-started session
      if (regSession.origin === 'auto' && _discordAutoRecord) {
        _discordAutoRecord.suppress(guildId);
      }

      if (summary) {
        const durationSec = Math.round((summary.endTime.getTime() - summary.startTime.getTime()) / 1000);
        const duration = formatDuration(durationSec);
        const shortId = summary.sessionId.slice(0, 8);
        const trackList = summary.tracks.map((t) => `${t.track_number}. ${t.discord_display_name}`).join('\n');
        replyLines.push(
          `\u2B1B **Discord recording ended**`,
          ``,
          `**Channel:** <#${summary.channelId}>`,
          `**Recording ID:** \`${shortId}\``,
          `**Duration:** ${duration}`,
          `**Tracks:** ${summary.trackCount}`,
          ``,
          trackList,
        );
        logger.info('Discord recording stopped', { sessionId: summary.sessionId, trackCount: summary.trackCount });
      } else {
        replyLines.push('Discord recording stopped.');
      }

      fireStopCallbacks(summary);

    } else if (regSession.platform === 'mumble') {
      if (!regSession.teamId) {
        logger.error('Mumble stop failed: missing teamId in session registry', { sessionId: regSession.sessionId });
        replyLines.push(`\u2B1B **Mumble recording stop failed** — missing team reference. Recording may still be active.`);
      } else {
        await stopMumbleRecording(regSession.teamId);
        replyLines.push(`\u2B1B **Mumble recording ended**`);
        logger.info('Mumble recording stopped', { teamId: regSession.teamId, sessionId: regSession.sessionId });
      }
    }
  }

  try {
    await interaction.editReply({ content: replyLines.join('\n') || 'Recording stopped.' });
  } catch (err) {
    logger.warn('Could not reply to stop interaction — recording was still saved', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Must be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const sessions = sessionRegistry.getByGuildId(guildId);

  if (sessions.length === 0) {
    await interaction.reply({ content: 'No active recordings.', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = sessions.map((s) => {
    const durationSec = Math.floor((Date.now() - s.startTime.getTime()) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    return `**${s.platform}** — ${mins}m ${secs}s — ${s.origin} — channel: ${s.channelId}`;
  });

  await interaction.reply({ content: `Active recordings:\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
}

async function handleReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Must be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Defer immediately — REST disconnect and stopRecording can take time
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const actions: string[] = [];

  // 1. Stop any active recording for this guild
  if (activeSessions.has(guildId)) {
    const session = activeSessions.get(guildId)!;
    await stopRecording(guildId);
    actions.push(`Stopped recording (session ${session.sessionId.slice(0, 8)})`);
  }

  // 2. Clear joining lock
  if (joiningGuilds.has(guildId)) {
    joiningGuilds.delete(guildId);
    actions.push('Cleared joining lock');
  }

  // 3. Destroy any @discordjs/voice connection state
  const vc = getVoiceConnection(guildId);
  if (vc) {
    try { vc.destroy(); } catch { /* */ }
    actions.push('Destroyed voice connection');
  }

  // 4. Force-disconnect via REST API (requires Move Members permission).
  //    Gateway opcode 4 doesn't reliably disconnect during stuck DAVE handshakes.
  const guild = interaction.guild;
  const me = guild?.members.me;
  if (me?.voice.channelId) {
    const channelName = me.voice.channel?.name;
    try {
      await me.voice.disconnect();
      actions.push(`Disconnected from voice channel "${channelName}"`);
    } catch (err) {
      actions.push(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (actions.length === 0) {
    await interaction.editReply({ content: 'Nothing to reset — no active recording, no voice connection.' });
  } else {
    logger.info('Manual reset performed', { guildId, actions });
    await interaction.editReply({
      content: `**Reset complete:**\n${actions.map(a => `- ${a}`).join('\n')}`,
    });
  }
}
