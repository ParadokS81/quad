/**
 * Mumble session_metadata.json writer.
 *
 * Produces the contract format from docs/mumble/phase-M5-recording-bot.md:
 *   schema_version: 1
 *   source: "mumble"               -- identifies Mumble origin (not "quad")
 *   guild: null                    -- no Discord guild concept
 *   channel: { id, name }          -- Mumble channel ID + name
 *   team: { tag, name, teamId }    -- from mumbleConfig Firestore doc
 *   mumble_server: { host, port }  -- server connection info
 *   tracks: [{ mumble_session_id, mumble_username, ... }]
 */

import { writeFile } from 'node:fs/promises';
import { type MumbleTrackMetadata } from './mumble-track.js';
import { type MumbleRecordingSession } from './mumble-session.js';
import { logger } from '../../core/logger.js';

interface MumbleSessionMetadata {
  schema_version: number;
  source: string;
  source_version: string;
  recording_start_time: string;
  recording_end_time: string;
  recording_id: string;
  guild: null;
  channel: { id: string; name: string };
  team: { tag: string; name: string; teamId: string };
  mumble_server: { host: string; port: number };
  tracks: MumbleTrackMetadata[];
}

export async function writeMumbleSessionMetadata(opts: {
  session: MumbleRecordingSession;
  endTime: Date;
  tracks: MumbleTrackMetadata[];
}): Promise<void> {
  const { session, endTime, tracks } = opts;

  const metadata: MumbleSessionMetadata = {
    schema_version: 1,
    source: 'mumble',
    source_version: '1.0.0',
    recording_start_time: session.startTime.toISOString(),
    recording_end_time: endTime.toISOString(),
    recording_id: session.sessionId,
    guild: null,
    channel: {
      id: String(session.channelId),
      name: session.channelName,
    },
    team: {
      tag: session.teamTag,
      name: session.teamName,
      teamId: session.teamId,
    },
    mumble_server: {
      host: process.env.MUMBLE_HOST || 'mumble',
      port: parseInt(process.env.MUMBLE_PORT || '64738', 10),
    },
    tracks,
  };

  const filePath = `${session.outputDir}/session_metadata.json`;
  await writeFile(filePath, JSON.stringify(metadata, null, 2) + '\n');

  logger.info(`Mumble session metadata written: ${filePath}`, {
    sessionId: session.sessionId,
    trackCount: tracks.length,
  });
}
