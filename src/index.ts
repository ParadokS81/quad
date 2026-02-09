import { loadConfig } from './core/config.js';
import { setLogLevel, logger } from './core/logger.js';
import { start, shutdown } from './core/bot.js';
import { recordingModule } from './modules/recording/index.js';

const config = loadConfig();
setLogLevel(config.logLevel);

logger.info('Starting Quad', { version: '1.0.0' });

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM');
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT');
  await shutdown();
  process.exit(0);
});

// Start with all modules
start(config, [recordingModule]).catch((err) => {
  logger.error('Failed to start bot', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
