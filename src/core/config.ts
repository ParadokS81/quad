export interface Config {
  discordToken: string;
  recordingDir: string;
  teamTag: string;
  teamName: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  healthPort: number;
}

export function loadConfig(): Config {
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) {
    console.error('DISCORD_TOKEN environment variable is required');
    process.exit(1);
  }

  return {
    discordToken,
    recordingDir: process.env.RECORDING_DIR || './recordings',
    teamTag: process.env.TEAM_TAG || '',
    teamName: process.env.TEAM_NAME || '',
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) || 'info',
    healthPort: parseInt(process.env.HEALTH_PORT || '3000', 10),
  };
}
