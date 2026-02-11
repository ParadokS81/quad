/**
 * /process slash command — triggers and monitors the processing pipeline.
 *
 * Subcommands:
 *   /process status [session_id]     — Show processing status
 *   /process transcribe [session_id] — Run transcription (slow pipeline)
 *   /process analyze [session_id]    — Run Claude analysis
 *   /process rerun [session_id]      — Re-run the full pipeline
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { loadConfig } from '../../../core/config.js';
import { logger } from '../../../core/logger.js';
import {
  resolveSessionDir,
  getPipelineStatus,
  formatStatus,
  isRunning,
  runFastPipeline,
  runTranscribePipeline,
  runAnalyzePipeline,
  runFullPipeline,
} from '../pipeline.js';

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
  const sessionIdArg = interaction.options.getString('session_id');
  const config = loadConfig();

  // Resolve session directory
  const sessionDir = await resolveSessionDir(config.recordingDir, sessionIdArg);
  if (!sessionDir) {
    await interaction.reply({
      content: sessionIdArg
        ? `Session \`${sessionIdArg}\` not found in \`${config.recordingDir}\`.`
        : `No recording sessions found in \`${config.recordingDir}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (subcommand) {
    case 'status':
      await handleStatus(interaction, sessionDir);
      break;
    case 'transcribe':
      await handleTranscribe(interaction, sessionDir, config.processing);
      break;
    case 'analyze':
      await handleAnalyze(interaction, sessionDir, config.processing);
      break;
    case 'rerun':
      await handleRerun(interaction, sessionDir, config.processing);
      break;
    default:
      await interaction.reply({
        content: `Unknown subcommand: ${subcommand}`,
        flags: MessageFlags.Ephemeral,
      });
  }
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  sessionDir: string,
): Promise<void> {
  const status = await getPipelineStatus(sessionDir);
  const message = formatStatus(status, sessionDir);

  await interaction.reply({
    content: message,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTranscribe(
  interaction: ChatInputCommandInteraction,
  sessionDir: string,
  config: import('../../../core/config.js').ProcessingConfig,
): Promise<void> {
  // Check if the fast pipeline has been run
  const status = await getPipelineStatus(sessionDir);
  if (!status || (status.stage !== 'complete' && status.stage !== 'error')) {
    // Auto-run fast pipeline first if not done
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await runFastPipeline(sessionDir, config);
      await interaction.editReply({
        content: `Fast pipeline complete (${result.pairings.length} matches). Starting transcription in background...`,
      });
    } catch (err) {
      await interaction.editReply({
        content: `Fast pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  // Run transcription in background (don't await — it takes hours)
  runTranscribePipeline(sessionDir, config)
    .then((result) => {
      logger.info('Background transcription complete', {
        sessionDir,
        segmentsProcessed: result.segmentsProcessed,
        totalEntries: result.totalEntries,
      });
    })
    .catch((err) => {
      logger.error('Background transcription failed', {
        sessionDir,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await interaction.editReply({
    content: 'Transcription started in background. Use `/process status` to check progress.',
  });
}

async function handleAnalyze(
  interaction: ChatInputCommandInteraction,
  sessionDir: string,
  config: import('../../../core/config.js').ProcessingConfig,
): Promise<void> {
  if (!config.anthropicApiKey) {
    await interaction.reply({
      content: 'ANTHROPIC_API_KEY is not configured. Set it in your environment to enable analysis.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Run analysis in background
  runAnalyzePipeline(sessionDir, config)
    .then((result) => {
      logger.info('Background analysis complete', {
        sessionDir,
        mapsAnalyzed: result.mapsAnalyzed,
        totalTokens: result.totalTokens,
      });
    })
    .catch((err) => {
      logger.error('Background analysis failed', {
        sessionDir,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await interaction.editReply({
    content: 'Analysis started in background. Use `/process status` to check progress.',
  });
}

async function handleRerun(
  interaction: ChatInputCommandInteraction,
  sessionDir: string,
  config: import('../../../core/config.js').ProcessingConfig,
): Promise<void> {
  // Check for existing run
  const status = await getPipelineStatus(sessionDir);
  if (status && isRunning(status.sessionId)) {
    await interaction.reply({
      content: `Pipeline is already running for this session (stage: ${status.stage}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Run full pipeline in background
  runFullPipeline(sessionDir, config)
    .then(() => {
      logger.info('Background full pipeline complete', { sessionDir });
    })
    .catch((err) => {
      logger.error('Background full pipeline failed', {
        sessionDir,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await interaction.editReply({
    content: 'Full pipeline rerun started in background. Use `/process status` to check progress.',
  });
}
