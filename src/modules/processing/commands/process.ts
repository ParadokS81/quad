/**
 * /process slash command — triggers and monitors the processing pipeline.
 *
 * Subcommands:
 *   /process status [session_id]     — Show processing status
 *   /process transcribe [session_id] — Run transcription (slow pipeline)
 *   /process analyze [session_id]    — Run Claude analysis
 *   /process rerun [session_id]      — Re-run the full pipeline
 *
 * Skeleton — real implementation in Phase P7.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';

export const processCommand = new SlashCommandBuilder()
  .setName('process')
  .setDescription('Process a recording session')
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show processing status for a session')
      .addStringOption((opt) =>
        opt.setName('session_id').setDescription('Recording session ID (latest if omitted)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('transcribe')
      .setDescription('Run transcription on a recorded session')
      .addStringOption((opt) =>
        opt.setName('session_id').setDescription('Recording session ID (latest if omitted)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('analyze')
      .setDescription('Run Claude analysis on a transcribed session')
      .addStringOption((opt) =>
        opt.setName('session_id').setDescription('Recording session ID (latest if omitted)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rerun')
      .setDescription('Re-run the full pipeline on a session')
      .addStringOption((opt) =>
        opt.setName('session_id').setDescription('Recording session ID (latest if omitted)'),
      ),
  ) as SlashCommandBuilder;

export async function handleProcessCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const sessionId = interaction.options.getString('session_id');

  // Placeholder — real implementation in Phase P7
  await interaction.reply({
    content: `Processing command \`${subcommand}\` received.${sessionId ? ` Session: \`${sessionId}\`` : ''}\nNot implemented yet.`,
    flags: MessageFlags.Ephemeral,
  });
}
