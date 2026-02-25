/**
 * Type definitions for the processing module.
 *
 * These types define the data flowing through the pipeline:
 * session metadata → hub matches → match pairings → segments → transcripts → timeline → analysis
 */

// ============================================================
// Session Data (from recording module's session_metadata.json)
// ============================================================

/** Matches session_metadata.json schema (public contract). */
export interface SessionMetadata {
  schema_version: number;
  recording_start_time: string;
  recording_end_time: string;
  recording_id: string;
  source: string;
  source_version: string;
  guild: { id: string; name: string };
  channel: { id: string; name: string };
  team?: { tag: string; name: string };
  source_text_channel_id?: string;
  tracks: SessionTrack[];
}

export interface SessionTrack {
  track_number: number;
  discord_user_id: string;
  discord_username: string;
  discord_display_name: string;
  joined_at: string;
  left_at: string;
  audio_file: string;
}

// ============================================================
// QW Hub API
// ============================================================

/** Match record from the QW Hub Supabase API. */
export interface HubMatch {
  id: number;
  timestamp: string;
  map: string;
  mode: string;
  hostname: string;
  demo_sha256: string;
  teams: HubTeam[];
  players: HubPlayer[];
  [key: string]: unknown;
}

export interface HubTeam {
  name: string;
  frags: number;
}

export interface HubPlayer {
  name: string;
  team?: string;
}

// ============================================================
// KtxStats (from d.quake.world)
// ============================================================

export interface KtxStats {
  duration: number;
  map: string;
  players: KtxStatsPlayer[];
  [key: string]: unknown;
}

export interface KtxStatsPlayer {
  name: string;
  team: string;
  stats: {
    frags: number;
    deaths: number;
    damage_given: number;
    damage_taken: number;
    [key: string]: unknown;
  };
  weapons: Record<string, unknown>;
  items: Record<string, unknown>;
}

// ============================================================
// Match Pairing
// ============================================================

/** A QW Hub match paired to a position in the recording. */
export interface MatchPairing {
  matchId: number;
  mapName: string;
  timestamp: Date;
  serverHostname: string;
  teams: HubTeam[];
  players: HubPlayer[];
  ktxstats: KtxStats | null;
  durationSeconds: number;
  audioOffsetSeconds: number;
  audioEndSeconds: number;
  confidence: number;
  confidenceReasons: string[];
  demoSha256: string;
}

// ============================================================
// Audio Splitting
// ============================================================

/** Metadata for a split audio segment (one map or intermission). */
export interface SegmentMetadata {
  index: number;
  dirName: string;
  map: string;
  startTime: number;
  endTime: number;
  players: SegmentPlayer[];
  audioDir: string;
  matchId: number;
  gameId: number;
  demoSha256: string;
  matchData: {
    gameId: number;
    timestamp: string;
    teams: HubTeam[];
    players: HubPlayer[];
    server: string;
    confidence: number;
    confidenceReasons: string[];
  };
  ktxstats: KtxStats | null;
  isIntermission?: boolean;
  label?: string;
  duration?: number;
  skippedTracks?: SkippedTrack[];
}

export interface SegmentPlayer {
  name: string;
  discordUserId: string;
  discordUsername: string;
  audioFile: string;
  duration: number;
  /** Number of decode errors found by ffmpegVerify. 0 = clean. */
  verifyErrors?: number;
  /** Whether the file was re-encoded to fix corrupt Opus packets. */
  repaired?: boolean;
}

/** Volume analysis result from ffmpeg volumedetect. */
export interface VolumeStats {
  meanVolume: number; // dB (e.g., -91.0 for silence, -25.0 for normal speech)
  maxVolume: number;  // dB (e.g., -91.0 for silence, -5.0 for normal speech)
}

/** Track skipped during pipeline processing. */
export interface SkippedTrack {
  discordUserId: string;
  discordUsername: string;
  reason: 'silent';
  maxVolumeDb: number;
}

// ============================================================
// Transcription
// ============================================================

/** A re-segmented transcript entry (after silence gap splitting). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

/** Raw output from the Python faster-whisper wrapper. */
export interface RawWhisperOutput {
  segments: RawWhisperSegment[];
  language: string;
  duration: number;
}

export interface RawWhisperSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob: number;
  words?: RawWhisperWord[];
}

export interface RawWhisperWord {
  start: number;
  end: number;
  word: string;
  probability: number;
}

// ============================================================
// Timeline
// ============================================================

/** A single entry in the merged chronological timeline. */
export interface TimelineEntry {
  speaker: string;
  start: number;
  end: number;
  text: string;
  confidence: number | null;
}

/** Detected speech overlap between two speakers. */
export interface OverlapEvent {
  speakers: [string, string];
  start: number;
  end: number;
  duration: number;
  texts: Record<string, string>;
}

/** Per-player communication statistics. */
export interface PlayerStats {
  segments: number;
  totalSpeakingTime: number;
  totalWords: number;
  avgSegmentDuration: number;
  wordsPerMinute: number;
}

/** Aggregated communication statistics for a segment. */
export interface CommunicationStats {
  playerStats: Record<string, PlayerStats>;
  team: {
    totalSegments: number;
    totalSpeakingTime: number;
    playerCount: number;
    totalDuration?: number;
    silencePercentage?: number;
  };
}

// ============================================================
// Pipeline Status
// ============================================================

export type PipelineStage =
  | 'idle'
  | 'parsing'
  | 'querying'
  | 'pairing'
  | 'splitting'
  | 'transcribing'
  | 'merging'
  | 'analyzing'
  | 'complete'
  | 'error';

/** Tracks the current state of pipeline execution for a session. */
export interface PipelineStatus {
  sessionId: string;
  stage: PipelineStage;
  currentStep: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  matchCount: number;
  segmentCount: number;
}
