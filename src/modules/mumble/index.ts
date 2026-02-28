/**
 * Mumble module — connects to Murmur voice server and manages team channels + users.
 *
 * This module is event-driven, no slash commands. It:
 * 1. Connects to the Mumble server on startup (protocol client)
 * 2. Connects to the Murmur ICE admin API via Python sidecar (ICE client)
 * 3. Watches Firestore mumbleConfig collection for pending/disabling events
 * 4. Creates/deletes team channels on the Mumble server
 * 5. Registers/unregisters team members as Mumble users with temp passwords
 * 6. Monitors new connections to detect certificate pinning
 * 7. (M5) Auto-records per-speaker audio when users join team channels
 *
 * M1: Protocol client + channel management
 * M2: ICE client + user registration + cert pinning
 * M4: Roster sync
 * M5: Recording bot (this phase)
 *
 * Requires: MUMBLE_HOST env var.
 * ICE requires: MUMBLE_ICE_SECRET env var (same as ICESECRETWRITE in docker-compose).
 * Also requires: FIREBASE_SERVICE_ACCOUNT for Firestore listener.
 * M5 requires: MUMBLE_AUTO_RECORD=true (default true if MUMBLE_HOST is set).
 */

import { type Client, type ChatInputCommandInteraction } from 'discord.js';
import { type BotModule } from '../../core/module.js';
import { logger } from '../../core/logger.js';
import { initFirestore } from '../standin/firestore.js';
import { MumbleManager } from './mumble-manager.js';
import { IceClient } from './ice-client.js';
import { UserManager } from './user-manager.js';
import { RosterSync } from './roster-sync.js';
import { SessionMonitor } from './session-monitor.js';
import { MumbleConfigListener } from './config-listener.js';
import { AutoRecord } from './auto-record.js';
import { runFastPipeline } from '../processing/pipeline.js';
import { loadConfig } from '../../core/config.js';

const mumbleManager = new MumbleManager();
const iceClient = new IceClient();
let userManager: UserManager | null = null;
const sessionMonitor = new SessionMonitor();
let configListener: MumbleConfigListener | null = null;
const autoRecord = new AutoRecord();

export const mumbleModule: BotModule = {
  name: 'mumble',

  // No slash commands in M1-M5 — Discord link sharing comes in M6
  commands: [],

  async handleCommand(_interaction: ChatInputCommandInteraction): Promise<void> {
    // No commands yet
  },

  registerEvents(_client: Client): void {
    // No Discord events needed in M1-M5
  },

  async onReady(_client: Client): Promise<void> {
    // 1. Connect protocol client (M1)
    try {
      await mumbleManager.connect();
    } catch (err) {
      logger.error('Failed to connect to Mumble server', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Firebase is required for the rest
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      logger.info('Mumble Firestore listener skipped — FIREBASE_SERVICE_ACCOUNT not set');
      return;
    }

    const db = initFirestore();

    // 2. Connect ICE client (M2) — optional, gracefully skipped if not configured
    const iceSecret = process.env.MUMBLE_ICE_SECRET;
    if (!iceSecret) {
      logger.info('Mumble ICE client skipped — MUMBLE_ICE_SECRET not set (user registration disabled)');
    } else {
      try {
        await iceClient.connect();
        userManager = new UserManager(iceClient, db);
        logger.info('Mumble ICE client connected');
      } catch (err) {
        logger.error('Failed to connect Mumble ICE client — user registration disabled', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue without ICE: channel management (M1) still works
      }
    }

    // 3. Start Firestore config listener (M1 + M2 + M4)
    try {
      const rosterSync = userManager
        ? new RosterSync(iceClient, userManager, db)
        : null;
      configListener = new MumbleConfigListener(mumbleManager, userManager, rosterSync);
      configListener.start(db);
    } catch (err) {
      logger.error('Failed to start Mumble config listener', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. Start session monitor for cert pinning (M2)
    if (userManager) {
      try {
        sessionMonitor.start(db, mumbleManager.getClient()!);
      } catch (err) {
        logger.error('Failed to start Mumble session monitor', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Start auto-recording bot (M5)
    const autoRecordEnabled = process.env.MUMBLE_AUTO_RECORD !== 'false';
    if (autoRecordEnabled) {
      try {
        const config = loadConfig();
        const recordingDir = process.env.MUMBLE_RECORDING_DIR || config.recordingDir;
        const mumbleClient = mumbleManager.getClient()!;

        autoRecord.onRecordingStop = async (summary) => {
          logger.info('Mumble recording session ended', {
            sessionId: summary.sessionId,
            team: summary.teamTag,
            channel: summary.channelName,
            tracks: summary.trackCount,
          });

          if (config.processing.processingAuto) {
            try {
              await runFastPipeline(summary.outputDir, config.processing);
            } catch (err) {
              logger.error('Mumble processing pipeline failed', {
                sessionId: summary.sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        };

        autoRecord.start(db, mumbleClient, recordingDir);
        logger.info('Mumble auto-record started', { recordingDir });
      } catch (err) {
        logger.error('Failed to start Mumble auto-record', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.info('Mumble auto-record disabled (MUMBLE_AUTO_RECORD=false)');
    }

    logger.info('Mumble module loaded', { iceEnabled: !!userManager, autoRecord: autoRecordEnabled });
  },

  async onShutdown(): Promise<void> {
    autoRecord.stop();
    sessionMonitor.stop();
    configListener?.stop();
    await iceClient.disconnect();
    await mumbleManager.disconnect();
    logger.info('Mumble module shut down');
  },
};
