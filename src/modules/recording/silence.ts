/**
 * Standard 3-byte silent Opus frame (0xF8, 0xFF, 0xFE).
 * Used by discord.js, discord.py, and every major Discord library.
 * Decodes to 20ms of silence at 48kHz. Mono-coded but works with stereo
 * OGG containers (decoder maps to both channels per RFC 6716).
 */
export const SILENT_OPUS_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

/** Duration of one Opus frame in milliseconds */
export const FRAME_DURATION_MS = 20;
