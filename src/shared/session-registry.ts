/**
 * Shared in-memory registry of active recording sessions across Discord and Mumble.
 * Key naming: `discord:${guildId}` | `mumble:${channelId}`
 */

export type Platform = 'discord' | 'mumble';
export type SessionOrigin = 'manual' | 'auto';

export interface RegisteredSession {
  platform: Platform;
  origin: SessionOrigin;
  sessionId: string;
  channelId: string;   // Discord channel ID or Mumble channel ID (as string)
  guildId: string;     // Discord guild ID (for cross-platform lookup by team)
  teamId?: string;     // From botRegistration
  startTime: Date;
  suppressed?: boolean; // Set when manual stop on auto-started session
}

class SessionRegistry {
  private readonly sessions = new Map<string, RegisteredSession>();

  register(key: string, meta: RegisteredSession): void {
    this.sessions.set(key, meta);
  }

  unregister(key: string): void {
    this.sessions.delete(key);
  }

  get(key: string): RegisteredSession | undefined {
    return this.sessions.get(key);
  }

  getByGuildId(guildId: string): RegisteredSession[] {
    return [...this.sessions.values()].filter(s => s.guildId === guildId);
  }

  getByPlatform(platform: Platform): RegisteredSession[] {
    return [...this.sessions.values()].filter(s => s.platform === platform);
  }

  getAllSessions(): RegisteredSession[] {
    return [...this.sessions.values()];
  }

  suppress(key: string): void {
    const session = this.sessions.get(key);
    if (session) session.suppressed = true;
  }

  isSuppressed(key: string): boolean {
    return this.sessions.get(key)?.suppressed === true;
  }

  clearSuppression(key: string): void {
    const session = this.sessions.get(key);
    if (session) session.suppressed = false;
  }
}

export const sessionRegistry = new SessionRegistry();
