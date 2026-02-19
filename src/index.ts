import { loadConfig } from './core/config.js';
import { setLogLevel, logger } from './core/logger.js';
import { start, shutdown } from './core/bot.js';
import { setRecordingStatusProvider } from './core/health.js';
import { recordingModule } from './modules/recording/index.js';
import { processingModule } from './modules/processing/index.js';
import { standinModule } from './modules/standin/index.js';
import { registrationModule } from './modules/registration/index.js';
import { schedulerModule } from './modules/scheduler/index.js';
import { isRecording, getActiveSessions } from './modules/recording/commands/record.js';

const config = loadConfig();
setLogLevel(config.logLevel);

logger.info('Starting Quad', { version: '1.0.0' });

// Provide recording status to health endpoint
setRecordingStatusProvider(() => ({
  active: isRecording(),
  sessionCount: getActiveSessions().size,
  sessions: Array.from(getActiveSessions().entries()).map(([guildId, s]) => ({
    guildId,
    sessionId: s.sessionId,
  })),
}));

// Prevent crashes from unhandled promises and exceptions
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', async (err) => {
  logger.error('Uncaught exception — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  await shutdown().catch(() => {});
  process.exit(1);
});

// Graceful shutdown
let shuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // Prevent double shutdown
  shuttingDown = true;
  logger.info(`Received ${signal}`);
  await shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Start with all modules
start(config, [recordingModule, processingModule, standinModule, registrationModule, schedulerModule]).catch((err) => {
  logger.error('Failed to start bot', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
