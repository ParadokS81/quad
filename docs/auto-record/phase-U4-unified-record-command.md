# Phase U4: Unified /record Command

> **Model:** Sonnet, extended thinking
> **Project:** quad
> **Depends on:** U2 (Discord Auto-Record) + U3 (Mumble Migration)
> **Contract:** `UNIFIED-AUTO-RECORD-CONTRACT.md` at workspace root

---

## Goal

Make the `/record` command platform-aware. Add auto-detection (Discord vs Mumble), explicit platform override, cross-platform stop, and recording status display.

---

## Task 1: Update Slash Command Definition

In `src/modules/recording/commands/record.ts`, update the command builder:

```typescript
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
  )
```

---

## Task 2: Auto-Detect Platform Logic

Create a helper function for platform detection:

```typescript
interface DetectionResult {
  platform: 'discord' | 'mumble' | 'both';
  discordChannel?: VoiceBasedChannel;
  mumbleUsers?: string[];
}

function detectPlatform(
  interaction: ChatInputCommandInteraction,
  teamId: string
): DetectionResult
```

**Logic:**
1. Check if invoking user is in a Discord voice channel → `discordSignal = true`, capture channel reference
2. Call `getMumbleChannelUsers(teamId)` (exported from mumble module in U3) → if users present, `mumbleSignal = true`
3. If both signals and user IS in Discord voice → return `'discord'` (user chose to be there)
4. If both signals and user is NOT in Discord voice → return platform with more users
5. If only Discord signal → return `'discord'`
6. If only Mumble signal → return `'mumble'`
7. If neither → return error (no active voice channels)

---

## Task 3: Update handleStart

Modify `handleStart()` to handle platform detection and Mumble recording:

```typescript
async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const explicitPlatform = interaction.options.getString('platform') as 'discord' | 'mumble' | null;

  // Find the team registration for this guild
  const registration = /* look up from cache or Firestore */;
  if (!registration) {
    return interaction.reply({ content: 'No team registered in this server.', ephemeral: true });
  }

  let targetPlatform: 'discord' | 'mumble';
  let discordChannel: VoiceBasedChannel | undefined;

  if (explicitPlatform) {
    targetPlatform = explicitPlatform;
    if (targetPlatform === 'discord') {
      // Must be in voice channel
      discordChannel = (interaction.member as GuildMember).voice.channel;
      if (!discordChannel) {
        return interaction.reply({ content: 'You must be in a voice channel.', ephemeral: true });
      }
    }
  } else {
    // Auto-detect
    const detection = detectPlatform(interaction, registration.teamId);
    if (!detection.platform) {
      return interaction.reply({ content: 'No active voice channel found. Join a Discord voice channel or have team members in Mumble.', ephemeral: true });
    }
    targetPlatform = detection.platform === 'both' ? 'discord' : detection.platform;
    discordChannel = detection.discordChannel;
  }

  await interaction.deferReply();

  if (targetPlatform === 'discord') {
    // Existing flow via startRecordingSession (extracted in U2)
    const result = await startRecordingSession({
      voiceChannel: discordChannel!,
      guild: interaction.guild!,
      sourceTextChannelId: interaction.channelId,
      origin: 'manual',
    });
    // Reply with result
  } else {
    // Mumble recording
    const session = await startMumbleRecording(registration.teamId);
    if (!session) {
      return interaction.editReply('Failed to start Mumble recording. Is the Mumble channel active?');
    }
    // Register in session registry with origin: 'manual'
    sessionRegistry.register(`mumble:${session.channelId}`, {
      platform: 'mumble',
      origin: 'manual',
      sessionId: session.sessionId,
      channelId: String(session.channelId),
      guildId: interaction.guildId!,
      teamId: registration.teamId,
      startTime: new Date(),
    });
    return interaction.editReply(`Recording started in Mumble channel **${session.channelName}**`);
  }
}
```

### Permission model for Mumble recording:
When `targetPlatform === 'mumble'`, the user doesn't need to be in a Discord voice channel. Instead, verify they are a registered team member:
- Check if their Discord user ID is in `registration.knownPlayers`
- OR check if they are in the team roster (via `registration.authorizedDiscordUserIds`)

---

## Task 4: Cross-Platform Stop

Update `handleStop()`:

```typescript
async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const guildId = interaction.guildId!;
  const sessions = sessionRegistry.getByGuildId(guildId);

  if (sessions.length === 0) {
    return interaction.editReply('No active recordings.');
  }

  const results: string[] = [];

  for (const session of sessions) {
    if (session.platform === 'discord') {
      const summary = await performStop(guildId, 'manual stop via /record stop');
      if (summary) results.push(`Discord: stopped (${summary.trackCount} tracks, ${summary.duration})`);
    } else if (session.platform === 'mumble') {
      await stopMumbleRecording(session.teamId!);
      results.push(`Mumble: stopped`);
    }

    // Set suppression if this was an auto-started session
    if (session.origin === 'auto') {
      sessionRegistry.suppress(session.platform === 'discord' ? `discord:${guildId}` : `mumble:${session.channelId}`);
    }
  }

  return interaction.editReply(`Recording stopped:\n${results.join('\n')}`);
}
```

---

## Task 5: Recording Status

Add `handleStatus()`:

```typescript
async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const sessions = sessionRegistry.getByGuildId(guildId);

  if (sessions.length === 0) {
    return interaction.reply({ content: 'No active recordings.', ephemeral: true });
  }

  const lines = sessions.map(s => {
    const duration = Math.floor((Date.now() - s.startTime.getTime()) / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    return `**${s.platform}** — ${mins}m ${secs}s — ${s.origin} — channel: ${s.channelId}`;
  });

  return interaction.reply({ content: `Active recordings:\n${lines.join('\n')}`, ephemeral: true });
}
```

---

## Task 6: Update Command Router

Update `handleRecordCommand()` to route the new subcommands:

```typescript
export async function handleRecordCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case 'start': return handleStart(interaction);
    case 'stop': return handleStop(interaction);
    case 'status': return handleStatus(interaction);
    case 'reset': return handleReset(interaction);
  }
}
```

---

## Cross-Module Imports

This phase requires importing from the Mumble module:

```typescript
import { startMumbleRecording, stopMumbleRecording, getMumbleChannelUsers } from '../mumble/index';
```

These were exported in U3. If Mumble is not configured (no `MUMBLE_HOST`), these functions should return null/empty gracefully.

---

## Files to modify
- `src/modules/recording/commands/record.ts` (all tasks)

## Files NOT to modify
- `src/modules/recording/auto-record.ts` (created in U2, not touched here)
- `src/modules/mumble/auto-record.ts` (modified in U3, not touched here)
- `src/shared/session-registry.ts` (created in U1, used read-only)

## Verification
- `npm run build` compiles without errors
- `/record start` — auto-detects when user is in Discord voice
- `/record start platform:discord` — records Discord explicitly
- `/record start platform:mumble` — records Mumble from Discord text channel
- `/record stop` — stops both platforms if both recording
- `/record status` — shows active recording info
- `/record stop` during auto-record → suppression flag set
- `/record start` after suppression → works (manual overrides suppression)
