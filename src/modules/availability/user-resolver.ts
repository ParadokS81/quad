import { getDb } from '../standin/firestore.js';
import { type ResolvedUser } from './types.js';

interface CacheEntry {
    user: ResolvedUser;
    expiry: number;  // Date.now() + TTL
}

const cache = new Map<string, CacheEntry>();  // key: `${discordUserId}:${teamId}`
const TTL = 60 * 60 * 1000;  // 1 hour

/**
 * Resolve a Discord user to their Firebase identity + team membership.
 * Returns null if user not found or not on this team.
 */
export async function resolveUser(discordUserId: string, teamId: string): Promise<ResolvedUser | null> {
    const key = `${discordUserId}:${teamId}`;
    const cached = cache.get(key);
    if (cached && cached.expiry > Date.now()) return cached.user;

    const db = getDb();
    const snap = await db.collection('users')
        .where('discordUserId', '==', discordUserId)
        .limit(1)
        .get();

    if (snap.empty) return null;

    const doc = snap.docs[0];
    const data = doc.data();

    // Verify team membership
    if (!data.teams?.[teamId]) return null;

    const user: ResolvedUser = {
        uid: doc.id,
        displayName: data.displayName || 'Unknown',
        initials: data.initials || (data.displayName || '??').slice(0, 2).toUpperCase(),
    };

    cache.set(key, { user, expiry: Date.now() + TTL });
    return user;
}

/** Clear cache (useful for testing) */
export function clearCache(): void {
    cache.clear();
}
