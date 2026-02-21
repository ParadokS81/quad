/**
 * Firestore listeners for the availability module.
 *
 * On startup, queries all active botRegistrations with a scheduleChannelId
 * and starts per-team listeners. Each team gets:
 * - An availability document listener (real-time, debounced re-render)
 * - A registration document listener (detects channel changes, teardown)
 * - A scheduled matches poll (every 5 minutes)
 *
 * On each render: weekly rollover check, team info refresh, canvas render,
 * and Discord message post/update.
 */

import { type Client } from 'discord.js';
import { type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import {
    type AvailabilityData, type TeamInfo, type RosterMember,
    type ScheduledMatchDisplay, type ActiveProposalDisplay,
} from './types.js';
import { getCurrentWeekId, getWeekDates } from './time.js';
import { renderGrid } from './renderer.js';
import {
    renderMatchCard, renderProposalCard,
    type MatchCardInput, type ProposalCardInput,
    COLOR_OFFICIAL, COLOR_PRACTICE,
} from './match-renderer.js';
import { buildMatchEmbed, buildProposalEmbed, formatScheduledDate } from './embed.js';
import { postOrRecoverMessage, updateMessage, updateCardMessage } from './message.js';
import { getTeamLogo, clearLogoCache } from './logo-cache.js';

// ── Per-team state ───────────────────────────────────────────────────────────

interface TeamState {
    teamId: string;
    channelId: string;
    messageId: string | null;
    weekId: string;
    availabilityUnsub: () => void;
    registrationUnsub: () => void;
    pollTimer: ReturnType<typeof setInterval> | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    lastAvailability: AvailabilityData | null;
    teamInfo: TeamInfo | null;
    scheduledMatches: ScheduledMatchDisplay[];
    activeProposals: ActiveProposalDisplay[];
    matchesMessageId: string | null;
    proposalsMessageId: string | null;
}

const activeTeams = new Map<string, TeamState>();
let firestoreDb: Firestore | null = null;
let botClient: Client | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start listeners for all active teams with a configured schedule channel.
 * Called from module onReady.
 */
export async function startAllListeners(db: Firestore, client: Client): Promise<void> {
    firestoreDb = db;
    botClient = client;

    const snap = await db.collection('botRegistrations')
        .where('status', '==', 'active')
        .get();

    for (const doc of snap.docs) {
        const data = doc.data();
        const teamId = doc.id;
        const channelId = data.scheduleChannelId as string | null;
        const messageId = data.scheduleMessageId as string | null;
        const matchesMessageId = data.matchesMessageId as string | null;
        const proposalsMessageId = data.proposalsMessageId as string | null;

        if (!channelId) continue;

        try {
            await startTeamListener(teamId, channelId, messageId, matchesMessageId, proposalsMessageId);
        } catch (err) {
            logger.error('Failed to start availability listener for team', {
                teamId, error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('Availability listeners started', { teamCount: activeTeams.size });
}

/**
 * Stop all listeners. Called from module onShutdown.
 */
export function stopAllListeners(): void {
    for (const teamId of [...activeTeams.keys()]) {
        teardownTeam(teamId);
    }
    clearLogoCache();
    firestoreDb = null;
    botClient = null;
    logger.info('All availability listeners stopped');
}

/**
 * Get cached availability data for a team (used by interaction handlers).
 * Returns null if team not tracked or no data yet.
 */
export function getTeamAvailability(teamId: string): AvailabilityData | null {
    return activeTeams.get(teamId)?.lastAvailability ?? null;
}

// ── Per-team lifecycle ───────────────────────────────────────────────────────

async function startTeamListener(
    teamId: string,
    channelId: string,
    storedMessageId: string | null,
    storedMatchesMessageId: string | null = null,
    storedProposalsMessageId: string | null = null,
): Promise<void> {
    if (!firestoreDb || !botClient) return;

    // Teardown existing listener if any
    if (activeTeams.has(teamId)) {
        teardownTeam(teamId);
    }

    const weekId = getCurrentWeekId();

    const state: TeamState = {
        teamId,
        channelId,
        messageId: storedMessageId,
        weekId,
        availabilityUnsub: () => {},
        registrationUnsub: () => {},
        pollTimer: null,
        debounceTimer: null,
        lastAvailability: null,
        teamInfo: null,
        scheduledMatches: [],
        activeProposals: [],
        matchesMessageId: storedMatchesMessageId ?? null,
        proposalsMessageId: storedProposalsMessageId ?? null,
    };

    activeTeams.set(teamId, state);

    // Fetch initial team info before first render
    state.teamInfo = await fetchTeamInfo(teamId);

    // Subscribe to availability changes
    state.availabilityUnsub = subscribeAvailability(teamId, weekId);

    // Subscribe to registration config changes
    state.registrationUnsub = subscribeRegistration(teamId);

    // Poll scheduled matches immediately + every 5 minutes
    await pollScheduledMatches(teamId);
    state.pollTimer = setInterval(() => {
        pollScheduledMatches(teamId).catch(err => {
            logger.warn('Scheduled matches poll failed', {
                teamId, error: err instanceof Error ? err.message : String(err),
            });
        });
    }, 5 * 60 * 1000);

    logger.info('Availability listener started for team', { teamId, channelId, weekId });
}

function teardownTeam(teamId: string): void {
    const state = activeTeams.get(teamId);
    if (!state) return;

    state.availabilityUnsub();
    state.registrationUnsub();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);

    activeTeams.delete(teamId);
    logger.info('Availability listener torn down', { teamId });
}

// ── Firestore subscriptions ─────────────────────────────────────────────────

function subscribeAvailability(teamId: string, weekId: string): () => void {
    if (!firestoreDb) return () => {};

    const docId = `${teamId}_${weekId}`;
    return firestoreDb.collection('availability').doc(docId)
        .onSnapshot(
            (snap) => {
                const state = activeTeams.get(teamId);
                if (!state) return;

                if (snap.exists) {
                    state.lastAvailability = snap.data() as AvailabilityData;
                } else {
                    state.lastAvailability = null;
                }
                scheduleRender(teamId);
            },
            (err) => {
                logger.error('Availability listener error', {
                    teamId, weekId, error: err instanceof Error ? err.message : String(err),
                });
            },
        );
}

function subscribeRegistration(teamId: string): () => void {
    if (!firestoreDb) return () => {};

    return firestoreDb.collection('botRegistrations').doc(teamId)
        .onSnapshot(
            (snap) => {
                if (!snap.exists) return;

                const data = snap.data()!;
                const currentState = activeTeams.get(teamId);
                if (!currentState) return;

                // Team disconnected or deactivated
                if (data.status === 'disconnecting' || data.status === 'inactive') {
                    teardownTeam(teamId);
                    return;
                }

                const newChannelId = data.scheduleChannelId as string | null;

                // Channel removed
                if (!newChannelId) {
                    teardownTeam(teamId);
                    return;
                }

                // Channel changed — restart with new channel
                if (newChannelId !== currentState.channelId) {
                    teardownTeam(teamId);
                    startTeamListener(teamId, newChannelId, null).catch(err => {
                        logger.error('Failed to restart listener after channel change', {
                            teamId, error: err instanceof Error ? err.message : String(err),
                        });
                    });
                }
            },
            (err) => {
                logger.error('Registration listener error', {
                    teamId, error: err instanceof Error ? err.message : String(err),
                });
            },
        );
}

// ── Debounced rendering ──────────────────────────────────────────────────────

function scheduleRender(teamId: string): void {
    const state = activeTeams.get(teamId);
    if (!state) return;

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
        renderAndUpdateMessage(teamId).catch(err => {
            logger.error('Render failed', {
                teamId, error: err instanceof Error ? err.message : String(err),
            });
        });
    }, 3000);
}

async function renderAndUpdateMessage(teamId: string): Promise<void> {
    const state = activeTeams.get(teamId);
    if (!state || !firestoreDb || !botClient) return;

    // Weekly rollover check
    const currentWeekId = getCurrentWeekId();
    if (currentWeekId !== state.weekId) {
        logger.info('Week rollover detected', { teamId, oldWeek: state.weekId, newWeek: currentWeekId });
        state.availabilityUnsub();
        state.weekId = currentWeekId;
        state.lastAvailability = null;
        state.availabilityUnsub = subscribeAvailability(teamId, currentWeekId);
        // New snapshot will trigger another render
        return;
    }

    // Refresh team info (team data changes rarely, but refresh each render to stay current)
    const freshTeamInfo = await fetchTeamInfo(teamId);
    if (freshTeamInfo) {
        state.teamInfo = freshTeamInfo;
    }

    if (!state.teamInfo) {
        logger.warn('No team info available, skipping render', { teamId });
        return;
    }

    const now = new Date();
    const weekDates = getWeekDates(state.weekId);

    // Render canvas grid
    let imageBuffer: Buffer;
    try {
        imageBuffer = await renderGrid({
            teamTag: state.teamInfo.teamTag,
            weekId: state.weekId,
            weekDates,
            slots: state.lastAvailability?.slots ?? {},
            unavailable: state.lastAvailability?.unavailable,
            roster: state.teamInfo.roster,
            scheduledMatches: state.scheduledMatches,
            now,
        });
    } catch (err) {
        logger.error('Failed to render schedule grid', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    // Post or update the grid message (image + dropdown only)
    try {
        if (state.messageId) {
            const result = await updateMessage(
                botClient, state.channelId, state.messageId, teamId, imageBuffer,
            );
            if (result === null) {
                const newId = await postOrRecoverMessage(
                    botClient, state.channelId, teamId, imageBuffer,
                );
                state.messageId = newId;
                // Grid was re-posted — old secondary messages are now above it, reset them
                state.matchesMessageId = null;
                state.proposalsMessageId = null;
                await firestoreDb!.collection('botRegistrations').doc(teamId).update({
                    matchesMessageId: null,
                    proposalsMessageId: null,
                });
            }
        } else {
            const newId = await postOrRecoverMessage(
                botClient, state.channelId, teamId, imageBuffer,
            );
            state.messageId = newId;
        }
    } catch (err) {
        logger.error('Failed to update schedule message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── Render and post match cards (message #2) ──
    // Each card gets its own embed with setImage for card↔link pairing.
    try {
        const matchCards: Array<{ buffer: Buffer; embed: import('discord.js').EmbedBuilder }> = [];
        if (state.scheduledMatches.length > 0 && state.teamInfo) {
            const ownLogo = await getTeamLogo(teamId, state.teamInfo.logoUrl);

            for (let i = 0; i < state.scheduledMatches.length; i++) {
                const match = state.scheduledMatches[i]!;
                const opponentLogo = await getTeamLogo(match.opponentId, match.opponentLogoUrl);
                const buffer = await renderMatchCard({
                    ownTag: state.teamInfo.teamTag,
                    ownLogo,
                    opponentName: match.opponentName,
                    opponentTag: match.opponentTag,
                    opponentLogo,
                    gameType: match.gameType,
                    scheduledDate: match.scheduledDate,
                });
                const colorInt = match.gameType === 'official'
                    ? parseInt(COLOR_OFFICIAL.slice(1), 16)
                    : parseInt(COLOR_PRACTICE.slice(1), 16);
                const embed = buildMatchEmbed(teamId, match, `card-${i}.png`, colorInt);
                matchCards.push({ buffer, embed });
            }
        }

        const newMatchesMsgId = await updateCardMessage(
            botClient, state.channelId, state.matchesMessageId, matchCards,
        );

        if (newMatchesMsgId !== state.matchesMessageId) {
            state.matchesMessageId = newMatchesMsgId;
            await firestoreDb.collection('botRegistrations').doc(teamId).update({
                matchesMessageId: newMatchesMsgId,
            });
        }
    } catch (err) {
        logger.error('Failed to update matches message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── Render and post proposal cards (message #3) ──
    try {
        const proposalCards: Array<{ buffer: Buffer; embed: import('discord.js').EmbedBuilder }> = [];
        if (state.activeProposals.length > 0) {
            for (let i = 0; i < state.activeProposals.length; i++) {
                const proposal = state.activeProposals[i]!;
                const opponentLogo = proposal.opponentLogoUrl
                    ? await getTeamLogo(proposal.opponentTag, proposal.opponentLogoUrl)
                    : null;
                const buffer = await renderProposalCard({
                    opponentName: proposal.opponentName,
                    opponentTag: proposal.opponentTag,
                    opponentLogo,
                    viableSlots: proposal.viableSlots,
                });
                const embed = buildProposalEmbed(teamId, proposal.opponentTag, `card-${i}.png`);
                proposalCards.push({ buffer, embed });
            }
        }

        const newProposalsMsgId = await updateCardMessage(
            botClient, state.channelId, state.proposalsMessageId, proposalCards,
        );

        if (newProposalsMsgId !== state.proposalsMessageId) {
            state.proposalsMessageId = newProposalsMsgId;
            await firestoreDb.collection('botRegistrations').doc(teamId).update({
                proposalsMessageId: newProposalsMsgId,
            });
        }
    } catch (err) {
        logger.error('Failed to update proposals message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetch team info: tag, name, and roster (displayName + initials per member).
 * Reads teams/{teamId} for metadata and users collection for roster.
 */
async function fetchTeamInfo(teamId: string): Promise<TeamInfo | null> {
    if (!firestoreDb) return null;

    try {
        const [teamDoc, usersSnap] = await Promise.all([
            firestoreDb.collection('teams').doc(teamId).get(),
            firestoreDb.collection('users').where(`teams.${teamId}`, '==', true).get(),
        ]);

        if (!teamDoc.exists) {
            logger.warn('Team document not found', { teamId });
            return null;
        }

        const data = teamDoc.data()!;
        const teamTag = String(data.teamTag ?? data.tag ?? '');
        const teamName = String(data.teamName ?? data.name ?? '');
        const logoUrl: string | null = data.activeLogo?.urls?.small ?? null;

        const roster: Record<string, RosterMember> = {};
        for (const userDoc of usersSnap.docs) {
            const userData = userDoc.data();
            const displayName = String(userData.displayName ?? 'Unknown');
            const initials = String(
                userData.initials ?? displayName.slice(0, 2).toUpperCase(),
            );
            roster[userDoc.id] = { displayName, initials };
        }

        return { teamId, teamTag, teamName, logoUrl, roster };
    } catch (err) {
        logger.error('Failed to fetch team info', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Poll scheduled matches and active proposals for a team.
 * Fetches enriched data including gameType, names, and opponent logo URLs.
 */
async function pollScheduledMatches(teamId: string): Promise<void> {
    const state = activeTeams.get(teamId);
    if (!state || !firestoreDb) return;

    try {
        // Scheduled matches for this team's current week
        const matchesSnap = await firestoreDb.collection('scheduledMatches')
            .where('blockedTeams', 'array-contains', teamId)
            .where('status', '==', 'upcoming')
            .where('weekId', '==', state.weekId)
            .get();

        const prevMatchCount = state.scheduledMatches.length;
        const prevProposalCount = state.activeProposals.length;

        // Collect opponent teamIds for logo fetching
        const opponentTeamIds = new Set<string>();

        // Build enriched match list
        const scheduledMatches: ScheduledMatchDisplay[] = [];
        for (const doc of matchesSnap.docs) {
            const data = doc.data();
            const isTeamA = data.teamAId === teamId;
            const opponentId = isTeamA ? String(data.teamBId ?? '') : String(data.teamAId ?? '');
            if (opponentId) opponentTeamIds.add(opponentId);

            if (data.slotId) {
                scheduledMatches.push({
                    slotId: String(data.slotId),
                    opponentTag: isTeamA ? String(data.teamBTag ?? '?') : String(data.teamATag ?? '?'),
                    opponentId,
                    opponentName: isTeamA ? String(data.teamBName ?? '') : String(data.teamAName ?? ''),
                    gameType: (data.gameType as 'official' | 'practice') ?? 'practice',
                    opponentLogoUrl: null, // filled below after logo fetch
                    scheduledDate: formatScheduledDate(String(data.slotId), state.weekId),
                });
            }
        }

        // Active proposals (Firestore doesn't support OR across fields, two queries)
        const [proposerSnap, opponentSnap] = await Promise.all([
            firestoreDb.collection('matchProposals')
                .where('proposerTeamId', '==', teamId)
                .where('status', '==', 'active')
                .get(),
            firestoreDb.collection('matchProposals')
                .where('opponentTeamId', '==', teamId)
                .where('status', '==', 'active')
                .get(),
        ]);

        const seenIds = new Set<string>();
        const activeProposals: ActiveProposalDisplay[] = [];

        for (const snap of [proposerSnap, opponentSnap]) {
            for (const doc of snap.docs) {
                if (seenIds.has(doc.id)) continue;
                seenIds.add(doc.id);

                const data = doc.data();
                const isProposer = data.proposerTeamId === teamId;
                const oppId = isProposer ? String(data.opponentTeamId ?? '') : String(data.proposerTeamId ?? '');
                if (oppId) opponentTeamIds.add(oppId);

                activeProposals.push({
                    opponentTag: isProposer
                        ? String(data.opponentTeamTag ?? '?')
                        : String(data.proposerTeamTag ?? '?'),
                    opponentName: isProposer
                        ? String(data.opponentTeamName ?? '')
                        : String(data.proposerTeamName ?? ''),
                    viableSlots: Array.isArray(data.confirmedSlots) ? data.confirmedSlots.length : 0,
                    opponentLogoUrl: null, // filled below
                });
            }
        }

        // Batch-fetch opponent team docs for logo URLs
        if (opponentTeamIds.size > 0) {
            const teamDocs = await Promise.all(
                [...opponentTeamIds].map(id => firestoreDb!.collection('teams').doc(id).get()),
            );
            const logoUrls = new Map<string, string | null>();
            for (const doc of teamDocs) {
                if (doc.exists) {
                    logoUrls.set(doc.id, doc.data()!.activeLogo?.urls?.small ?? null);
                }
            }

            // Fill logo URLs on matches
            for (const m of scheduledMatches) {
                m.opponentLogoUrl = logoUrls.get(m.opponentId) ?? null;
            }

            // Fill logo URLs on proposals (match by tag → id mapping)
            // We need to map opponent tags to their teamIds for proposals
            const tagToId = new Map<string, string>();
            for (const doc of matchesSnap.docs) {
                const d = doc.data();
                if (d.teamAId !== teamId) tagToId.set(String(d.teamATag ?? ''), String(d.teamAId));
                if (d.teamBId !== teamId) tagToId.set(String(d.teamBTag ?? ''), String(d.teamBId));
            }
            for (const snap of [proposerSnap, opponentSnap]) {
                for (const doc of snap.docs) {
                    const d = doc.data();
                    const isProposer = d.proposerTeamId === teamId;
                    const oppId = isProposer ? String(d.opponentTeamId ?? '') : String(d.proposerTeamId ?? '');
                    const oppTag = isProposer ? String(d.opponentTeamTag ?? '') : String(d.proposerTeamTag ?? '');
                    if (oppId) tagToId.set(oppTag, oppId);
                }
            }
            for (const p of activeProposals) {
                const oppId = tagToId.get(p.opponentTag);
                if (oppId) p.opponentLogoUrl = logoUrls.get(oppId) ?? null;
            }
        }

        // Sort matches chronologically
        const dayOrder: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
        scheduledMatches.sort((a, b) => {
            const [dayA, timeA = ''] = a.slotId.split('_');
            const [dayB, timeB = ''] = b.slotId.split('_');
            const dayCmp = (dayOrder[dayA] ?? 9) - (dayOrder[dayB] ?? 9);
            return dayCmp !== 0 ? dayCmp : timeA.localeCompare(timeB);
        });

        state.scheduledMatches = scheduledMatches;
        state.activeProposals = activeProposals;

        // Trigger re-render if matches or proposals changed
        if (scheduledMatches.length !== prevMatchCount || activeProposals.length !== prevProposalCount) {
            scheduleRender(teamId);
        }
    } catch (err) {
        logger.warn('Failed to poll scheduled matches/proposals', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }
}
