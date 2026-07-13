// Builds the input for buildQueue() (the pure core, lib/matchmaking.ts)
// DIRECTLY ON THE CLIENT, from the session doc already available via
// onSnapshot. No separate API call — and the displayed order ALWAYS
// matches the server's real tier-1 gate.
//
// `SessionDoc` is imported as a TYPE ONLY (import type) — erased at
// build time, so firebase-admin (server-only) never lands in the
// client bundle.

import { buildQueue } from './matchmaking';
import { DEFAULT_CONFIG, type ClubPlayer, type Attendance, type PlayerId } from './types';
import type { SessionDoc } from './firestore';

export function computeQueue(session: SessionDoc, now: number) {
  // Firestore does NOT preserve field order across dot-path updates
  // (e.g. setPaused) — sort by id before building the Map so tier 3
  // (fixed-seed draw, rng=0) produces a STABLE order across renders,
  // instead of jumping around with whatever field order Firestore
  // happens to return.
  const ids = Object.keys(session.players).sort();

  const players = new Map<PlayerId, ClubPlayer>();
  for (const id of ids) {
    const p = session.players[id];
    players.set(id, { ...p, seedRank: 0, gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true });
  }

  const attendance = new Map<PlayerId, Attendance>();
  for (const id of ids) {
    const a = session.attendance[id];
    if (a) attendance.set(id, { playerId: id, ...a });
  }

  const busy = new Set<PlayerId>();
  for (const c of session.courts) {
    if (c.players) for (const id of c.players) busy.add(id);
  }

  // Fixed rng — this is only the DISPLAY queue, kept fixed so the order
  // doesn't flicker between renders on exact ties (start of session).
  return buildQueue({ now, players, attendance, pairStats: {}, config: DEFAULT_CONFIG, busy, rng: () => 0 });
}
