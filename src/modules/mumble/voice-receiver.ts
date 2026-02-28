/**
 * Mumble voice receiver — hooks into the MumbleSocket to capture raw Opus frames.
 *
 * The @tf2pickup-org/mumble-client library receives TCP-tunneled voice packets
 * (UDPTunnel, type=1) and only emits { source } — discarding the Opus data.
 * We monkey-patch MumbleSocket.decodeAudio to intercept the raw packet bytes
 * before they're discarded, then parse the Mumble legacy UDP voice packet format.
 *
 * Legacy Mumble UDP voice packet format (for Opus, target=0):
 *   Byte 0:  (codec_type << 5) | target
 *             Opus = type 4 → 0x80 for normal speech (target=0)
 *   Varint:  sender_session — session ID of the speaking user
 *   Varint:  sequence_number — monotonically increasing frame counter
 *   Varint:  opus_data_length (high bit = is_terminator flag)
 *   Bytes:   raw Opus frame (opus_data_length & 0x1FFF bytes)
 *
 * Only UDPTunnel type-1 packets are processed here. All other control
 * packets are handled by the library as normal.
 */

import type { Client as MumbleClient } from '@tf2pickup-org/mumble-client';
import { logger } from '../../core/logger.js';

/** Opus codec type in the Mumble legacy UDP packet header */
const OPUS_CODEC_TYPE = 4;

/** Max valid Opus packet size per RFC 6716 */
const MAX_OPUS_PACKET_SIZE = 1275;

/** Read Mumble varint from a buffer, returns value and number of bytes consumed. */
function readMumbleVarint(buf: Buffer, offset: number): { value: number; consumed: number } {
  if (offset >= buf.length) {
    throw new Error('Buffer too short for varint');
  }
  const b0 = buf[offset];

  if ((b0 & 0x80) === 0) {
    return { value: b0, consumed: 1 };
  }
  if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= buf.length) throw new Error('Varint too short (2-byte)');
    return { value: buf.readUInt16BE(offset) & 0x3fff, consumed: 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (offset + 2 >= buf.length) throw new Error('Varint too short (3-byte)');
    return { value: ((buf.readUInt16BE(offset) & 0x1fff) << 8) | buf[offset + 2], consumed: 3 };
  }
  if ((b0 & 0xf0) === 0xe0) {
    if (offset + 3 >= buf.length) throw new Error('Varint too short (4-byte)');
    return { value: buf.readUInt32BE(offset) & 0x1fffffff, consumed: 4 };
  }
  if ((b0 & 0xfc) === 0xf0) {
    if (offset + 4 >= buf.length) throw new Error('Varint too short (5-byte)');
    return { value: buf.readUInt32BE(offset + 1), consumed: 5 };
  }

  // Extended varints (9-byte, negated, bitwise-not) — not used in audio packets
  throw new Error(`Unsupported varint prefix: 0x${b0.toString(16)}`);
}

export interface VoicePacket {
  senderSession: number;
  opusData: Buffer;
  isTerminator: boolean;
}

export type VoicePacketHandler = (packet: VoicePacket) => void;

/**
 * Hooks into the MumbleClient's socket to intercept raw voice packets.
 *
 * Call attach() after the client is connected. Call detach() on shutdown.
 * The onVoicePacket callback is called for every valid Opus voice packet
 * sent to the normal speech target (target=0).
 */
export class VoiceReceiver {
  private onVoicePacket: VoicePacketHandler | null = null;
  private mumbleSocket: { decodeAudio: (packet: Buffer) => void } | null = null;
  private originalDecodeAudio: ((packet: Buffer) => void) | null = null;

  /**
   * Attach to the connected MumbleClient's socket.
   * Monkey-patches decodeAudio to also route voice packets to our handler.
   */
  attach(client: MumbleClient, handler: VoicePacketHandler): void {
    if (!client.isConnected()) {
      throw new Error('VoiceReceiver.attach() called before client connected');
    }

    this.onVoicePacket = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.mumbleSocket = (client.socket as any) as { decodeAudio: (packet: Buffer) => void };

    // Save original and replace with our intercepting version
    this.originalDecodeAudio = this.mumbleSocket.decodeAudio.bind(this.mumbleSocket);
    this.mumbleSocket.decodeAudio = (packet: Buffer) => {
      // Call the original (emits { source } to the audioPacket observable)
      this.originalDecodeAudio!(packet);
      // Parse and route to our voice handler
      this.parseVoicePacket(packet);
    };

    logger.info('VoiceReceiver attached to MumbleSocket');
  }

  /** Remove the monkey-patch and restore original decodeAudio. */
  detach(): void {
    if (this.mumbleSocket && this.originalDecodeAudio) {
      this.mumbleSocket.decodeAudio = this.originalDecodeAudio;
    }
    this.mumbleSocket = null;
    this.originalDecodeAudio = null;
    this.onVoicePacket = null;
    logger.info('VoiceReceiver detached from MumbleSocket');
  }

  /**
   * Parse a raw Mumble legacy UDP voice packet and route to the handler.
   *
   * Packet format (Opus, target=0):
   *   Byte 0:  0x80 = (4 << 5) | 0 = Opus codec, normal speech target
   *   Varint:  sender_session
   *   Varint:  sequence_number (consumed but not used)
   *   Varint:  opus_data_length | (is_terminator << 15) -- high bit = terminator
   *   Bytes:   raw Opus frame
   */
  private parseVoicePacket(packet: Buffer): void {
    if (!this.onVoicePacket || packet.length < 2) return;

    const byte0 = packet[0];
    const codecType = (byte0 >> 5) & 0x07;
    const target = byte0 & 0x1f;

    // Only handle Opus codec, normal speech (target=0)
    if (codecType !== OPUS_CODEC_TYPE || target !== 0) return;

    try {
      let offset = 1;

      // Read sender_session varint
      const sessionResult = readMumbleVarint(packet, offset);
      const senderSession = sessionResult.value;
      offset += sessionResult.consumed;

      // Read sequence_number varint (consume but ignore)
      const seqResult = readMumbleVarint(packet, offset);
      offset += seqResult.consumed;

      // Read opus_data_length varint (high bit = is_terminator)
      const lenResult = readMumbleVarint(packet, offset);
      offset += lenResult.consumed;

      const isTerminator = (lenResult.value & 0x2000) !== 0;
      const opusLength = lenResult.value & 0x1fff;

      if (opusLength === 0 || offset + opusLength > packet.length) return;
      if (opusLength > MAX_OPUS_PACKET_SIZE) return;

      const opusData = packet.slice(offset, offset + opusLength);

      this.onVoicePacket({ senderSession, opusData, isTerminator });
    } catch {
      // Malformed packet — ignore silently (may happen on reconnect)
    }
  }
}
