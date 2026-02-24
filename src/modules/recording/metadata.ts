import { writeFile } from 'node:fs/promises';
import { type RecordingSession } from './session.js';
import { type TrackMetadata } from './track.js';
import { loadConfig } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { getRegistrationsForGuild } from '../registration/register.js';

interface SessionMetadata {
  schema_version: number;
  recording_start_time: string;
  recording_end_time: string;
  recording_id: string;
  source: string;
  source_version: string;
  guild: { id: string; name: string };
  channel: { id: string; name: string };
  team?: { tag: string; name: string };
  source_text_channel_id: string | null;
  tracks: TrackMetadata[];
}

export async function writeSessionMetadata(
  session: RecordingSession,
  endTime: Date,
  tracks: TrackMetadata[],
): Promise<void> {
  const config = loadConfig();

  const metadata: SessionMetadata = {
    schema_version: 1,
    recording_start_time: session.startTime.toISOString(),
    recording_end_time: endTime.toISOString(),
    recording_id: session.sessionId,
    source: 'quad',
    source_version: '1.0.0',
    guild: { id: session.guildId, name: session.guildName },
    channel: { id: session.channelId, name: session.channelName },
    source_text_channel_id: session.sourceTextChannelId || null,
    tracks,
  };

  // Look up guild registration for team info (falls back to env vars)
  try {
    const registrations = await getRegistrationsForGuild(session.guildId);
    let registration = registrations.length === 1 ? registrations[0] : null;
    if (!registration && registrations.length > 1 && session.sourceTextChannelId) {
      registration = registrations.find(r => r.registeredChannelId === session.sourceTextChannelId) || null;
    }
    if (registration) {
      metadata.team = {
        tag: registration.teamTag,
        name: registration.teamName || session.guildName,
      };
    } else if (config.teamTag) {
      metadata.team = {
        tag: config.teamTag,
        name: config.teamName || session.guildName,
      };
    }
  } catch {
    // Firestore unavailable — fall back to env vars
    if (config.teamTag) {
      metadata.team = {
        tag: config.teamTag,
        name: config.teamName || session.guildName,
      };
    }
  }

  const filePath = `${session.outputDir}/session_metadata.json`;
  await writeFile(filePath, JSON.stringify(metadata, null, 2) + '\n');

  logger.info(`Metadata written: ${filePath}`, {
    sessionId: session.sessionId,
    trackCount: tracks.length,
  });
}
