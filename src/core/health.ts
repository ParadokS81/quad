import { createServer, type Server } from 'node:http';
import { logger } from './logger.js';

let server: Server | null = null;

interface HealthStatus {
  active: boolean;
  sessionCount: number;
  sessions: Array<{ guildId: string; sessionId: string }>;
}

/** Function that returns current recording status. Set by the caller. */
let getRecordingStatus: (() => HealthStatus) | null = null;

export function setRecordingStatusProvider(fn: () => HealthStatus): void {
  getRecordingStatus = fn;
}

export function startHealthServer(port: number, modules: string[]): void {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const recording = getRecordingStatus?.() ?? { active: false, sessionCount: 0, sessions: [] };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        modules,
        recording,
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    logger.info(`Health endpoint listening on port ${port}`);
  });
}

export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
