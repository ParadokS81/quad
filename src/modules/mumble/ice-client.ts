/**
 * Murmur ICE client — TypeScript wrapper around the Python ICE sidecar.
 *
 * Spawns `scripts/mumble-ice.py` as a long-lived subprocess and communicates
 * with it via JSON lines on stdin/stdout. The Python sidecar handles the ZeroC
 * ICE protocol (zeroc-ice pip package + MumbleServer.ice slice).
 *
 * Why Python sidecar?
 *   The `ice` npm package (v3.7.x) is CJS-only in an ESM project and lacks TS
 *   types. The Python `zeroc-ice` library is the well-tested path for Murmur
 *   ICE integration (used by MuMo, Alliance Auth, etc.).
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../core/logger.js';

// Resolve path to the Python sidecar script, relative to this compiled file.
// In Docker: /app/dist/modules/mumble/ice-client.js → /app/scripts/mumble-ice.py
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(__filename, '..', '..', '..', '..');
const SIDECAR_PATH = join(PROJECT_ROOT, 'scripts', 'mumble-ice.py');

/** Murmur channel permission bit flags. */
export const PERM = {
  Write: 0x1,
  Traverse: 0x2,
  Enter: 0x4,
  Speak: 0x8,
  MuteDeafen: 0x10,
  Move: 0x20,
  MakeChannel: 0x40,
  LinkChannel: 0x80,
  Whisper: 0x100,
  TextMessage: 0x200,
  MakeTempChannel: 0x400,
  Kick: 0x10000,
  Ban: 0x20000,
  Register: 0x40000,
  SelfRegister: 0x80000,
} as const;

export interface ACLEntry {
  applyHere?: boolean;
  applySubs?: boolean;
  inherited?: boolean;
  /** Murmur user ID. Use -1 (and set `group`) for group-based entries. */
  userid?: number;
  group?: string;
  allow?: number;
  deny?: number;
}

interface IceRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface IceResponse {
  id?: string;
  result?: unknown;
  error?: string;
  ready?: boolean;
}

const READY_TIMEOUT_MS = 15_000;

export class IceClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private nextId = 1;
  private ready = false;

  /** Spawn the Python sidecar and wait until it signals ICE connected. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn('python3', [SIDECAR_PATH], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const rl = createInterface({ input: this.proc.stdout! });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        let resp: IceResponse;
        try {
          resp = JSON.parse(line) as IceResponse;
        } catch {
          return;
        }

        if (resp.ready) {
          this.ready = true;
          logger.info('Connected to Murmur ICE (Python sidecar ready)');
          resolve();
          return;
        }

        if (resp.id === undefined) return;
        const pending = this.pending.get(resp.id);
        if (!pending) return;

        this.pending.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(resp.error));
        } else {
          pending.resolve(resp.result);
        }
      });

      this.proc.stderr!.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          logger.error('[mumble-ice.py] ' + text);
        }
      });

      this.proc.on('exit', (code) => {
        if (!this.ready) {
          reject(new Error(`ICE sidecar exited (code=${code}) before signalling ready`));
        } else {
          logger.warn('Murmur ICE sidecar exited', { code });
        }
        this.ready = false;
        // Reject any pending calls
        for (const [, pending] of this.pending) {
          pending.reject(new Error('ICE sidecar exited'));
        }
        this.pending.clear();
        this.proc = null;
      });

      this.proc.on('error', (err) => {
        if (!this.ready) {
          reject(new Error(`ICE sidecar failed to start: ${err.message}`));
        }
        logger.error('ICE sidecar process error', { error: err.message });
      });

      // Timeout guard
      setTimeout(() => {
        if (!this.ready) {
          reject(new Error(`ICE sidecar ready timeout (${READY_TIMEOUT_MS}ms)`));
        }
      }, READY_TIMEOUT_MS);
    });
  }

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.proc || !this.ready) {
      return Promise.reject(new Error('ICE client not connected'));
    }

    const id = String(this.nextId++);

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });

      const req: IceRequest = { id, method, params };
      this.proc!.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  /**
   * Register a new Mumble user with a username and password.
   * Returns the Murmur user ID (integer, used in ACLs and cert pinning).
   */
  async registerUser(username: string, password: string): Promise<number> {
    return this.call<number>('registerUser', { username, password });
  }

  /** Remove a registered Mumble user. */
  async unregisterUser(userId: number): Promise<void> {
    await this.call('unregisterUser', { userId });
  }

  /** Update a registered user's username and/or password. */
  async updateRegistration(
    userId: number,
    updates: { username?: string; password?: string },
  ): Promise<void> {
    await this.call('updateRegistration', { userId, updates });
  }

  /**
   * List all registered users matching the filter string (empty = all).
   * Returns a Map of mumbleUserId → username.
   */
  async getRegisteredUsers(filter = ''): Promise<Map<number, string>> {
    const result = await this.call<Record<string, string>>('getRegisteredUsers', { filter });
    return new Map(Object.entries(result).map(([k, v]) => [Number(k), v]));
  }

  /**
   * Set the ACL for a channel.
   * @param channelId   Murmur channel ID
   * @param acls        List of ACL entries
   * @param inherit     Whether to inherit ACLs from parent channel
   */
  async setACL(channelId: number, acls: ACLEntry[], inherit = true): Promise<void> {
    await this.call('setACL', { channelId, acls, inherit });
  }

  /** Read the current ACL for a channel. */
  async getACL(channelId: number): Promise<{ acls: ACLEntry[]; inherit: boolean }> {
    return this.call('getACL', { channelId });
  }

  isConnected(): boolean {
    return this.ready;
  }

  async disconnect(): Promise<void> {
    this.ready = false;

    if (this.proc) {
      // Close stdin to signal the sidecar's command loop to exit cleanly
      this.proc.stdin?.end();

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc?.kill();
          resolve();
        }, 2000);

        this.proc!.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      this.proc = null;
    }

    for (const [, pending] of this.pending) {
      pending.reject(new Error('ICE client disconnected'));
    }
    this.pending.clear();
  }
}
