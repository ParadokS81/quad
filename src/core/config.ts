export interface ProcessingConfig {
  anthropicApiKey: string;
  whisperModel: string;
  playerQuery: string;
  playerNameMap: Record<string, string>;
  processingAuto: boolean;
  processingTranscribe: boolean;
  processingIntermissions: boolean;
}

export interface Config {
  discordToken: string;
  recordingDir: string;
  teamTag: string;
  teamName: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  healthPort: number;
  processing: ProcessingConfig;
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
    processing: {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      whisperModel: process.env.WHISPER_MODEL || 'small',
      playerQuery: process.env.PLAYER_QUERY || '',
      playerNameMap: parseNameMap(process.env.PLAYER_NAME_MAP || ''),
      processingAuto: process.env.PROCESSING_AUTO !== 'false',
      processingTranscribe: process.env.PROCESSING_TRANSCRIBE === 'true',
      processingIntermissions: process.env.PROCESSING_INTERMISSIONS !== 'false',
    },
  };
}

function parseNameMap(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [key, value] = pair.split(':', 2);
    if (key && value) {
      map[key.trim().toLowerCase()] = value.trim();
    }
  }
  return map;
}
