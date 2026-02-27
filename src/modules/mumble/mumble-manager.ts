import { Client } from '@tf2pickup-org/mumble-client';
import type { Channel } from '@tf2pickup-org/mumble-client';
import { logger } from '../../core/logger.js';

const RECONNECT_DELAY_MS = 5000;
const TEAMS_CHANNEL_NAME = 'Teams';

export class MumbleManager {
  private client: Client | null = null;
  private connected = false;
  private isShuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  async connect(): Promise<void> {
    const host = process.env.MUMBLE_HOST;
    const port = parseInt(process.env.MUMBLE_PORT || '64738', 10);
    const username = process.env.MUMBLE_BOT_USERNAME || 'QuadBot';
    const password = process.env.MUMBLE_PASSWORD;

    if (!host) {
      throw new Error('MUMBLE_HOST env var is required');
    }

    this.isShuttingDown = false;

    this.client = new Client({
      host,
      port,
      username,
      password,
      rejectUnauthorized: false, // Mumble servers commonly use self-signed certs
      clientName: 'QuadBot',
    });

    this.client.on('connect', () => {
      this.connected = true;
      const channels = this.client!.channels.findAll(() => true)
        .map(c => c.name)
        .filter(Boolean);
      logger.info(`Connected to Mumble at ${host}:${port}`, {
        channels: channels.length > 0 ? channels.join(', ') : '(no channels)',
      });
    });

    this.client.on('disconnect', (payload) => {
      this.connected = false;
      logger.warn('Disconnected from Mumble', { reason: payload?.reason });
      if (!this.isShuttingDown) {
        this.reconnectTimer = setTimeout(() => this.reconnect(), RECONNECT_DELAY_MS);
      }
    });

    this.client.on('error', (error) => {
      logger.error('Mumble client error', { error: String(error) });
    });

    await this.client.connect();
  }

  private async reconnect(): Promise<void> {
    this.reconnectTimer = null;
    if (this.isShuttingDown || !this.client) return;

    logger.info('Attempting Mumble reconnect...');
    try {
      await this.client.connect();
    } catch (err) {
      logger.error('Mumble reconnect failed', { error: String(err) });
      this.reconnectTimer = setTimeout(() => this.reconnect(), RECONNECT_DELAY_MS);
    }
  }

  async createTeamChannel(teamTag: string, teamName: string): Promise<{
    channelId: number;
    channelName: string;
    channelPath: string;
  }> {
    if (!this.client?.isConnected()) {
      throw new Error('Mumble client not connected');
    }

    // Sanitize tag: strip non-alphanumeric chars, lowercase
    const channelName = teamTag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || teamTag;

    // Find or create the "Teams" parent channel
    const teamsChannel = await this.findOrCreateTeamsChannel();

    // Return existing channel if it already exists
    const existing = teamsChannel.subChannels.find(c => c.name === channelName);
    if (existing) {
      logger.info(`Mumble channel already exists: ${TEAMS_CHANNEL_NAME}/${channelName}`, {
        channelId: existing.id,
      });
      return {
        channelId: existing.id,
        channelName,
        channelPath: `${TEAMS_CHANNEL_NAME}/${channelName}`,
      };
    }

    // Create subchannel under Teams
    const channel = await teamsChannel.createSubChannel(channelName);
    logger.info(`Created Mumble channel: ${TEAMS_CHANNEL_NAME}/${channelName}`, {
      channelId: channel.id,
      teamName,
    });

    return {
      channelId: channel.id,
      channelName,
      channelPath: `${TEAMS_CHANNEL_NAME}/${channelName}`,
    };
  }

  async deleteTeamChannel(channelId: number): Promise<void> {
    if (!this.client?.isConnected()) {
      throw new Error('Mumble client not connected');
    }

    const channel = this.client.channels.byId(channelId);
    if (!channel) {
      logger.warn('Mumble channel not found for deletion', { channelId });
      return;
    }

    const name = channel.name;
    await channel.remove();
    logger.info('Deleted Mumble channel', { channelId, name });
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }

    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Return the underlying protocol client (needed by SessionMonitor for user events). */
  getClient(): Client | null {
    return this.client;
  }

  private async findOrCreateTeamsChannel(): Promise<Channel> {
    const client = this.client!;

    const existing = client.channels.byName(TEAMS_CHANNEL_NAME);
    if (existing) return existing;

    const root = client.channels.root;
    if (!root) {
      throw new Error('Mumble root channel not found');
    }

    logger.info(`Creating "${TEAMS_CHANNEL_NAME}" parent channel on Mumble`);
    return root.createSubChannel(TEAMS_CHANNEL_NAME);
  }
}
