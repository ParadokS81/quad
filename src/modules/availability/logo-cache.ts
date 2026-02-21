/**
 * Team logo image cache for canvas rendering.
 *
 * Fetches team logos from Firebase Storage public URLs and caches
 * the loaded @napi-rs/canvas Image objects in memory with TTL.
 */

import { loadImage, type Image } from '@napi-rs/canvas';
import { logger } from '../../core/logger.js';

interface CacheEntry {
    image: Image | null;   // null = failed to load
    expiry: number;
}

const cache = new Map<string, CacheEntry>();
const SUCCESS_TTL = 30 * 60 * 1000;   // 30 minutes
const FAILURE_TTL = 5 * 60 * 1000;    // 5 minutes

/**
 * Get a team logo as a canvas-ready Image.
 * Returns null if no URL provided or fetch fails (with caching to avoid retry storms).
 */
export async function getTeamLogo(teamId: string, logoUrl: string | null): Promise<Image | null> {
    if (!logoUrl) return null;

    const cached = cache.get(teamId);
    if (cached && cached.expiry > Date.now()) return cached.image;

    try {
        const res = await fetch(logoUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const buffer = Buffer.from(await res.arrayBuffer());
        const img = await loadImage(buffer);
        cache.set(teamId, { image: img, expiry: Date.now() + SUCCESS_TTL });
        return img;
    } catch (err) {
        logger.warn('Failed to load team logo', {
            teamId,
            error: err instanceof Error ? err.message : String(err),
        });
        cache.set(teamId, { image: null, expiry: Date.now() + FAILURE_TTL });
        return null;
    }
}

/** Clear all cached logos. Called on shutdown. */
export function clearLogoCache(): void {
    cache.clear();
}
