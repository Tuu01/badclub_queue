// ============================================================
// firestore.ts — Data layer (stands in for Postgres)
//
// WHY FIRESTORE FITS THIS APP:
//
//   The entire session state (22 people, 3 courts, the queue) fits in
//   ONE ~5KB document. Firestore's limit is 1MB — plenty of headroom.
//
//   Consequence: a transaction on ONE doc is ATOMIC by definition.
//   No SELECT ... FOR UPDATE. No need to reason about isolation levels.
//   "Two phones both grab An and Binh" — IMPOSSIBLE, because both
//   read-and-write the same doc, and Firestore auto-retries the loser.
//
//   THE DANGER ZONE IN THE ARCHITECTURE DISAPPEARS.
//
// THE COST:
//   No JOIN, no aggregation. Six months from now, wanting to compute
//   coverage / Brier score means downloading everything and computing
//   it in JS. At ~940 games/year, that's a 3-second script. Not a
//   problem — just a script.
//
// NOTE: lib/matchmaking.ts and lib/rating.ts DO NOT CHANGE A SINGLE LINE.
//   The pure core knows nothing about the database. That's exactly why
//   it was designed this way.
// ============================================================

import type {
  ClubPlayer, PlayerId, Attendance, PairStats, Game,
  MatchmakingConfig, Suggestion,
} from './types';
import { pairKey, DEFAULT_CONFIG } from './types';
import { suggestMatch } from './matchmaking';
import { updateRatings, seedMu, SIGMA_INIT, isConverged } from './rating';
import { computeSkillBand, type SkillBand } from './skill-band';

import {
  getFirestore, Timestamp, type Transaction, type Firestore,
} from 'firebase-admin/firestore';

// ============================================================
// DATA STRUCTURE
// ============================================================
//
//   clubs/{clubId}
//     players/{playerId}          ← 55 docs. Changes every few months.
//     meta/pairStats              ← ONE doc. Map of ~1485 pairs (~120KB).
//
//   sessions/{sessionId}          ← ONE doc. The ENTIRE live state.
//     games/{gameId}              ← append-only, for later analysis
//     audit/{logId}               ← append-only, for Undo
//
// KEY TRICK:
//   Embed a COPY of {id,name,gender,div,mu,sigma} for the ~22 people
//   right inside sessions/{sid}. That way a transaction touches only
//   TWO docs: session + pairStats. No need to read 22 player docs
//   every time a match is arranged.
//
//   This is deliberate denormalization. Don't "fix" it.
// ============================================================

/** Trimmed-down copy of a player, embedded in the session doc. */
export interface SessionPlayer {
  id: PlayerId;
  name: string;
  gender: 'M' | 'F';
  div: 1 | 2;
  mu: number;
  sigma: number;
}

/** Document sessions/{sid} — the ENTIRE live state. ~5KB. */
export interface SessionDoc {
  id: string;         // the PLAY date ("2026-07-18"), not the date it was created
  clubId: string;
  date: string;        // same as id — kept for readability at call sites
  courtCount: number;
  targetHeadcount: number;
  mode: 'OFF' | 'RECORD' | 'ASSIGN';

  /**
   * DRAFT → roster set (via /admin/session/new), nobody checked in yet.
   * LIVE  → someone tapped "Start session" on /. This is what / renders.
   * DONE  → no UI transition to this yet (out of scope for this pass —
   *         a LIVE session with no "end session" action stays LIVE
   *         forever until something explicitly moves it along).
   */
  status: 'DRAFT' | 'LIVE' | 'DONE';

  /** Copy of the ~22 people. Deliberately denormalized. */
  players: Record<PlayerId, SessionPlayer>;

  /** Who's where. Admin check-in writes all ~22 people in ONE write. */
  attendance: Record<PlayerId, {
    status: 'AVAILABLE' | 'PLAYING' | 'PAUSED' | 'LEFT';
    checkedInAt: number;
    leftAt: number | null;
    gamesToday: number;
    freeAt: number;       // wait = now - freeAt
  }>;

  courts: Array<{
    idx: number;
    gameId: string | null;    // null = empty
    players: PlayerId[] | null;
    teamA: [PlayerId, PlayerId] | null;
    teamB: [PlayerId, PlayerId] | null;
    startedAt: number | null;
  }>;

  startedAt: number;
  endedAt: number | null;

  /**
   * Written once, at endSession(). LEADERBOARD.md Phase 1 — the ONE
   * irreversible decision on that page: without a per-session
   * snapshot, there is no way to ever recover what a player's rating
   * was last month, so an Improvement board can never be built,
   * however far in the future that gets approved. Collected starting
   * now on purpose; not displayed anywhere yet — see LEADERBOARD.md's
   * STATUS note. Guests are excluded (single-use ids, never meant to
   * persist — LEADERBOARD.md: "guests never appear").
   */
  ratingSnapshot?: {
    at: number;
    ratings: Array<{ id: PlayerId; mu: number; sigma: number; gamesTotal: number }>;
  };

  /**
   * Accumulated by recordResult() — pairKey() strings ("a|b", sorted)
   * for pairs whose FIRST-EVER partnering happened in this session
   * (partnered was 0 the moment before the bump). Feeds F-2's
   * "first-time pairs" line; nothing else reads it. Guests excluded.
   * See recordResult()'s notePartnerIfFirst.
   *
   * STRINGS, not [PlayerId, PlayerId] tuples — Firestore rejects
   * arrays-of-arrays ("Nested arrays are not allowed"). Learned this
   * the hard way; don't change the shape back.
   */
  firstTimePairs?: string[];
}

/** Document clubs/{cid}/meta/pairStats. NO DECAY. Remembered forever. */
export interface PairStatsDoc {
  /** key: "playerA|playerB" (sorted) */
  pairs: PairStats;
  updatedAt: number;
}

// ============================================================
// TRANSACTION 1 — CHECK-IN (admin, one write)
// ============================================================

/**
 * Admin taps 22 names → ONE write.
 *
 * This is why admin-driven check-in beats self check-in: 22 people
 * tapping themselves = 22 writes to the same doc within 30 seconds
 * → contention → retries. Admin taps once = 1 write. Nothing to contend.
 *
 * IMPORTANT: freeAt = checkedInAt, NOT session.startedAt.
 * Whoever checks in early plays first. Fair, and it self-resolves ties
 * at the start of the session.
 *
 * MUST also denormalize into session.players for anyone not already
 * there (e.g. checked in via /checkin's "+ Add someone not on the
 * list", which is NOT necessarily the same set /admin/session/new
 * finalized). Skipping this used to leave an attendance entry with no
 * matching players entry — invisible in RECORD mode's picker (sourced
 * from session.players), and in ASSIGN mode, once that person waited
 * long enough to be `forced`, every four-combination either contained
 * them (players.get(id)! on undefined → crash) or didn't (rejected by
 * the forced constraint) — suggestMatch() returned null for the WHOLE
 * session, forever. Silent, session-wide, and the button that triggers
 * it is already live in the UI. See USECASES.md UC-17.
 */
export async function checkInBatch(
  db: Firestore,
  sessionId: string,
  clubId: string,
  playerIds: PlayerId[],
  now = Date.now(),
): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);
  const playersRef = db.collection(`clubs/${clubId}/players`);

  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;

    const missingIds = playerIds.filter(id => !s.players[id]);
    let players = s.players;
    if (missingIds.length > 0) {
      const [ratingsSnap, playerSnaps] = await Promise.all([
        tx.get(ratingsRef),
        Promise.all(missingIds.map(id => tx.get(playersRef.doc(id)))),
      ]);
      const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
      players = { ...s.players };
      for (const pSnap of playerSnaps) {
        if (!pSnap.exists) continue;
        const p = pSnap.data() as PublicPlayerDoc;
        const r = ratings[p.id] ?? { mu: 50, sigma: SIGMA_INIT };
        players[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: r.mu, sigma: r.sigma };
      }
    }

    const attendance = { ...s.attendance };
    for (const id of playerIds) {
      if (attendance[id]) continue;          // already checked in → skip (idempotent)
      attendance[id] = {
        status: 'AVAILABLE',
        checkedInAt: now,
        leftAt: null,
        gamesToday: 0,
        freeAt: now,                          // ← the wait clock starts HERE
      };
    }
    tx.update(sRef, { players, attendance });
  });
}

// ============================================================
// TRANSACTION 2 — RECORD RESULT (idempotent)
// ============================================================

/**
 * Three people all tap "Team A won" on court 2 → ALL THREE succeed.
 * Nobody sees an error. Nobody knows they were second.
 *
 * Idempotency key = gameId, checked via endedAt (NOT winner — see
 * below). If the game already ended → skip, return the state.
 *
 * Why this is mandatory: user taps, network is slow, nothing appears,
 * they tap again. Without idempotency → TWO games get recorded →
 * rating corrupted, game counts wrong.
 *
 * This is also why optimistic updates in the UI are safe.
 *
 * winner: null — UC-7. "Is the court free?" is urgent (the queue is a
 * lie until it's known); "who won?" is not (only ratings need it, and
 * ratings can wait). So a null winner still frees the court and
 * updates attendance (gamesToday, freeAt) — that's real, it happened —
 * but SKIPS rating/pairStats entirely, since there's nothing to
 * compute without a winner. Because idempotency keys off endedAt, a
 * later call with a real winner for the SAME gameId is a no-op, same
 * as any other duplicate tap — this pass does not support backfilling
 * a winner after the fact (that's the 25-min "is it done?" prompt,
 * UC-7b, deferred).
 */
export async function recordResult(
  db: Firestore,
  sessionId: string,
  clubId: string,
  args: {
    gameId: string;
    courtIdx: number;
    winner: 'A' | 'B' | null;
    scoreLoser?: number;
    actor: string;
  },
  now = Date.now(),
): Promise<{ alreadyRecorded: boolean; auditLogId: string | null }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const gRef = db.doc(`sessions/${sessionId}/games/${args.gameId}`);
  const pRef = db.doc(`clubs/${clubId}/meta/pairStats`);
  const rRef = db.doc(`clubs/${clubId}/private/ratings`);
  const aRef = db.collection(`sessions/${sessionId}/audit`).doc();

  return db.runTransaction(async (tx: Transaction) => {
    // --- READ EVERYTHING FIRST (Firestore requires: all reads before any write) ---
    const [sSnap, gSnap, pSnap, rSnap] = await Promise.all([
      tx.get(sRef), tx.get(gRef), tx.get(pRef), tx.get(rRef),
    ]);
    const s = sSnap.data() as SessionDoc;
    const g = gSnap.data() as Game | undefined;

    if (!g) throw new Error('game not found');

    // --- IDEMPOTENT --- endedAt, not winner, is "is this game done" —
    // a game can end with winner still null.
    if (g.endedAt !== null || g.status === 'VOID') {
      // Only the first tap gets an auditLogId (for Undo) — subsequent
      // duplicate taps don't need one, since only the MOST RECENT
      // action can be undone.
      return { alreadyRecorded: true, auditLogId: null };       // ← not an error. Return 200.
    }

    const [a1, a2] = g.teamA;
    const [b1, b2] = g.teamB;
    const four = [a1, a2, b1, b2];

    if (args.winner === null) {
      // Free the court, credit the game to the queue's fairness data —
      // no rating change, so nothing to snapshot and nothing to undo.
      const attendance = { ...s.attendance };
      for (const id of four) {
        attendance[id] = {
          ...attendance[id],
          status: 'AVAILABLE',
          gamesToday: attendance[id].gamesToday + 1,
          freeAt: now,
        };
      }
      const courts = s.courts.map(c =>
        c.idx === args.courtIdx
          ? { ...c, gameId: null, players: null, teamA: null, teamB: null, startedAt: null }
          : c);

      tx.update(gRef, { winner: null, scoreLoser: null, endedAt: now });
      tx.update(sRef, { attendance, courts });
      return { alreadyRecorded: false, auditLogId: null };
    }

    const stats = (pSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};
    const clubRatings = (rSnap.data() as RatingsDoc | undefined)?.ratings ?? {};

    // clubs/{cid}/players/{id} only exists for the 55 members — NOT
    // for drop-in guests (see addGuest). Permanent gamesTotal/
    // lastPlayedAt only apply to members.
    const memberIds = four.filter(id => !id.startsWith('guest-'));
    const memberRefs = memberIds.map(id => db.doc(`clubs/${clubId}/players/${id}`));
    const memberSnaps = await Promise.all(memberRefs.map(r => tx.get(r)));

    // --- SNAPSHOT FOR UNDO ---
    // TrueSkill HAS NO INVERSE FUNCTION. You can't derive the old mu
    // from the new one. Must snapshot. 4 people → a few hundred bytes. Cheap.
    const before = {
      ratings: four.map(id => ({
        id, mu: s.players[id].mu, sigma: s.players[id].sigma,
      })),
      attendance: four.map(id => ({
        id,
        gamesToday: s.attendance[id].gamesToday,
        freeAt: s.attendance[id].freeAt,
        status: s.attendance[id].status,
      })),
      pairs: [
        pairKey(a1, a2), pairKey(b1, b2),
        pairKey(a1, b1), pairKey(a1, b2), pairKey(a2, b1), pairKey(a2, b2),
      ].map(k => ({ key: k, ...(stats[k] ?? { partnered: 0, opposed: 0, coPresent: 0 }) })),
      members: memberIds.map((id, i) => {
        const p = memberSnaps[i].data() as PublicPlayerDoc | undefined;
        return { id, gamesTotal: p?.gamesTotal ?? 0, lastPlayedAt: p?.lastPlayedAt ?? null };
      }),
    };

    // --- RATING (pure core) ---
    const asClub = (id: PlayerId): ClubPlayer => ({
      ...s.players[id], seedRank: 0, gamesTotal: 0,
      lastPlayedAt: null, isGuest: false, active: true,
    });
    const updates = updateRatings(
      [asClub(a1), asClub(a2)],
      [asClub(b1), asClub(b2)],
      args.winner,
    );

    const players = { ...s.players };
    for (const u of updates) {
      players[u.playerId] = { ...players[u.playerId], mu: u.mu, sigma: u.sigma };
      // Sync PERMANENTLY to clubs/{cid}/private/ratings — otherwise the
      // rating only lives in today's session doc and disappears once
      // the next session is created from the old ratings. Guests are
      // NOT saved — their id is single-use.
      if (!u.playerId.startsWith('guest-')) {
        clubRatings[u.playerId] = { mu: u.mu, sigma: u.sigma };
      }
    }

    // --- PAIR STATS (NO DECAY) ---
    const bump = (k: string, f: 'partnered' | 'opposed') => {
      const cur = stats[k] ?? { partnered: 0, opposed: 0, coPresent: 0 };
      stats[k] = { ...cur, [f]: cur[f] + 1 };
    };
    // F-2's "first-time pairs" line needs to know exactly which
    // partnerings are brand new — the moment BEFORE bump() is the only
    // place that's known for certain (partnered is a running total with
    // no per-session breakdown). Guests excluded — see addGuest(),
    // "guests never appear on any board" extends to this summary too.
    const firstTimePairs = (s.firstTimePairs ?? []).slice();
    const notePartnerIfFirst = (x: PlayerId, y: PlayerId) => {
      if (x.startsWith('guest-') || y.startsWith('guest-')) return;
      const k = pairKey(x, y);
      if ((stats[k]?.partnered ?? 0) > 0) return;
      if (firstTimePairs.includes(k)) return; // dedupe
      firstTimePairs.push(k);
    };
    notePartnerIfFirst(a1, a2);
    notePartnerIfFirst(b1, b2);
    bump(pairKey(a1, a2), 'partnered');
    bump(pairKey(b1, b2), 'partnered');
    for (const x of [a1, a2]) for (const y of [b1, b2]) bump(pairKey(x, y), 'opposed');

    // --- ATTENDANCE: 4 people return to the queue ---
    const attendance = { ...s.attendance };
    for (const id of four) {
      attendance[id] = {
        ...attendance[id],
        status: 'AVAILABLE',
        gamesToday: attendance[id].gamesToday + 1,
        freeAt: now,                            // ← wait clock resets
      };
    }

    // --- FREE THE COURT ---
    const courts = s.courts.map(c =>
      c.idx === args.courtIdx
        ? { ...c, gameId: null, players: null, teamA: null, teamB: null, startedAt: null }
        : c);

    // --- WRITE ---
    tx.update(gRef, {
      winner: args.winner,
      scoreLoser: args.scoreLoser ?? null,
      scoreWinner: null, // attached later via setGameScore() — see UC-21
      endedAt: now,
    });
    tx.update(sRef, { players, attendance, courts, firstTimePairs });
    tx.set(pRef, { pairs: stats, updatedAt: now });
    tx.set(rRef, { ratings: clubRatings, updatedAt: now });
    for (let i = 0; i < memberIds.length; i++) {
      if (!memberSnaps[i].exists) continue;
      const cur = before.members[i];
      tx.update(memberRefs[i], { gamesTotal: cur.gamesTotal + 1, lastPlayedAt: now });
    }
    tx.set(aRef, {
      at: now, actor: args.actor, action: 'RESULT',
      payload: {
        gameId: args.gameId, courtIdx: args.courtIdx, winner: args.winner,
        scoreLoser: args.scoreLoser ?? null, actor: args.actor, before,
      },
    });

    return { alreadyRecorded: false, auditLogId: aRef.id };
  });
}

// ============================================================
// UC-21 — the score field, attached AFTER the winner is already
// recorded (see the undo bar in app/page.tsx). Deliberately a SECOND,
// separate write: nothing here may touch rating/pairStats/attendance —
// those were already applied the instant the winner was tapped.
// Nothing reads scoreLoser today. Collected anyway, same reasoning as
// the rating snapshot: it's the one thing you can't go back and get
// later if you don't start collecting it from session one.
// ============================================================

/**
 * Idempotent by construction: only ever patches ONE field. If the
 * game has no winner yet (freed via "not sure who won," or doesn't
 * exist), this is a silent no-op — there's nothing to attach a score
 * to, and the UI that calls this can only ever appear after a real
 * winner was recorded, so this is a defensive guard, not a real path.
 */
/**
 * scoreWinner is deliberately NOT part of the `Game` type in lib/types.ts
 * (protected — see CLAUDE.md) — same as scoreLoser, it's descriptive data
 * the pure core (rating.ts/matchmaking.ts) never reads, so it's stored
 * here in the "dirty shell" without touching that interface.
 */
export async function setGameScore(
  db: Firestore,
  sessionId: string,
  gameId: string,
  scores: { scoreWinner: number; scoreLoser: number },
): Promise<{ ok: true }> {
  const gRef = db.doc(`sessions/${sessionId}/games/${gameId}`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(gRef);
    const g = snap.data() as Game | undefined;
    if (!g || g.winner === null) return;
    tx.update(gRef, { scoreWinner: scores.scoreWinner, scoreLoser: scores.scoreLoser });
  });
  return { ok: true };
}

/**
 * PLAYER-tier — no code required (view-only, same as the live courts).
 * Player names aren't resolved here: the client already has
 * `session.players` from its own live session doc, and re-fetching
 * this on every game means a fresh session's history is never stale.
 * `scoreWinner` is read as an untyped extension for the same reason
 * `setGameScore` writes it that way — see the note above.
 */
export interface GameHistoryEntry {
  id: string;
  courtIndex: number;
  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];
  winner: 'A' | 'B' | null;
  scoreWinner: number | null;
  scoreLoser: number | null;
  endedAt: number | null;
}

export async function getGameHistory(db: Firestore, sessionId: string): Promise<GameHistoryEntry[]> {
  const gamesSnap = await db.collection(`sessions/${sessionId}/games`).get();
  return gamesSnap.docs
    .map(d => d.data() as Game & { scoreWinner: number | null })
    .filter(g => g.status === 'OK' && g.winner !== null)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .map(g => ({
      id: g.id,
      courtIndex: g.courtIndex,
      teamA: g.teamA,
      teamB: g.teamB,
      winner: g.winner,
      scoreWinner: g.scoreWinner ?? null,
      scoreLoser: g.scoreLoser,
      endedAt: g.endedAt,
    }));
}

// ============================================================
// TRANSACTION 3 — ASSIGN PLAYERS TO A COURT
//
// THIS IS THE ONLY PLACE THAT CAN BREAK IN A WAY THAT'S HARD TO FIX.
// ============================================================

/**
 * The client PROPOSES 4 people. The server APPROVES.
 *
 * Why does the client send the 4 people up instead of letting the
 * server pick?
 *   Because the user can tap "Swap" and pick their own. The server
 *   receives the list, but ALWAYS re-validates it inside the transaction.
 *
 * Why can't the client lock them itself?
 *   20:14:03  court 1 finishes → client A picks "An, Binh, Cuong, Dung"
 *   20:14:05  court 2 finishes → client B picks "An, Binh, Em, Phong"
 *                                             ↑↑ An and Binh grabbed TWICE
 *
 * With Firestore, a transaction on one doc is atomic. Client B rereads
 * and sees An is already PLAYING → throws CONFLICT → client refetches,
 * computes a new suggestion. The user sees NO error — this is normal.
 */
export class ConflictError extends Error {
  constructor(public taken: PlayerId[]) {
    super(`already taken: ${taken.join(', ')}`);
  }
}

export async function assignCourt(
  db: Firestore,
  sessionId: string,
  args: {
    courtIdx: number;
    four: [PlayerId, PlayerId, PlayerId, PlayerId];
    teamA: [PlayerId, PlayerId];
    teamB: [PlayerId, PlayerId];
    predictedProbA: number | null;
    /** false = the user tapped "Swap". THE PROJECT'S MOST IMPORTANT METRIC. */
    accepted: boolean;
    suggested?: PlayerId[];
    reason?: string;
    assignedByApp: boolean;
    actor: string;
  },
  now = Date.now(),
): Promise<{ gameId: string }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const gRef = db.collection(`sessions/${sessionId}/games`).doc();
  const lRef = db.collection(`sessions/${sessionId}/audit`).doc();

  return db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;

    // --- RE-CHECK. This is the entire reason this transaction exists. ---
    const taken = args.four.filter(id => s.attendance[id]?.status !== 'AVAILABLE');
    if (taken.length) throw new ConflictError(taken);

    const court = s.courts.find(c => c.idx === args.courtIdx);
    if (court?.gameId) throw new ConflictError([]);   // court already has a game

    // --- LOCK THE 4 ---
    const attendance = { ...s.attendance };
    for (const id of args.four) {
      attendance[id] = { ...attendance[id], status: 'PLAYING' };
    }

    const courts = s.courts.map(c =>
      c.idx === args.courtIdx
        ? { ...c, gameId: gRef.id, players: args.four,
            teamA: args.teamA, teamB: args.teamB, startedAt: now }
        : c);

    tx.set(gRef, {
      id: gRef.id, sessionId, courtIndex: args.courtIdx,
      teamA: args.teamA, teamB: args.teamB,
      winner: null,
      scoreLoser: null,
      predictedProbA: args.predictedProbA,
      assignedByApp: args.assignedByApp,
      startedAt: now, endedAt: null, status: 'OK',
    } satisfies Game);

    tx.update(sRef, { attendance, courts });

    // --- SUGGESTION LOG: the algorithm's REAL score ---
    //   < 30% swapped  → the algorithm is fine
    //   > 60% swapped  → something's wrong, and this log will show where
    if (args.assignedByApp || args.suggested) {
      tx.set(lRef, {
        at: now, actor: args.actor, action: 'ASSIGN',
        payload: {
          courtIdx: args.courtIdx,
          suggested: args.suggested ?? args.four,
          actual: args.four,
          accepted: args.accepted,
          reason: args.reason ?? null,
        },
      });
    }

    return { gameId: gRef.id };
  });
}

// ============================================================
// TRANSACTION 3b — SWAP A PLAYER ON A COURT THAT'S ALREADY IN PLAY
//
// See USECASES.md UC-1. "An, Binh, Cuong, Dung" assigned to a court —
// Dung ties his shoelace, Em steps in, nobody taps anything. pairStats
// then permanently records a partnership/opposition that never
// happened, and nobody ever notices. This is the fix.
// ============================================================

/**
 * SAME-SLOT replacement. Does NOT rebalance teams.
 *
 * The app RECORDS reality — it does not COMMAND reality once a match
 * has started. Dung was on team B, slot 2 → Em takes team B, slot 2.
 * If the four on court want to switch sides, that's two swaps, not
 * one rebalance: the screen must always match the people actually
 * standing on the court, or pairStats records a pairing that never
 * happened — the exact bug this function exists to prevent.
 *
 * gameId and startedAt are UNCHANGED — it's still the same match.
 *
 * IMPORTANT: recordResult() reads teamA/teamB from the GAME document
 * (sessions/{sid}/games/{gameId}), NOT from session.courts[idx] — the
 * two are separate denormalized copies written once at assignCourt()
 * time. If this function only patched the court copy, recordResult()
 * would keep crediting the swapped-OUT player forever. Both copies
 * must be written in the same transaction.
 */
export class SwapError extends Error {}

export async function swapPlayerOnCourt(
  db: Firestore,
  sessionId: string,
  args: { courtIdx: number; outId: PlayerId; inId: PlayerId; actor: string },
  now = Date.now(),
): Promise<{ gameId: string }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const lRef = db.collection(`sessions/${sessionId}/audit`).doc();

  return db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;

    const court = s.courts.find(c => c.idx === args.courtIdx);
    if (!court || !court.gameId || !court.players || !court.teamA || !court.teamB) {
      throw new SwapError('court is not in play');
    }
    if (!court.players.includes(args.outId)) {
      throw new SwapError('outId is not on this court');
    }
    if (court.players.includes(args.inId)) {
      throw new SwapError('inId is already on this court');
    }

    // --- RE-VALIDATE. Same principle as assignCourt(): the client
    // proposes, the server re-checks inside the transaction. inId
    // going PLAYING/LEFT between the client's read and this commit is
    // a genuine race (someone else just grabbed them) → ConflictError,
    // not a validation error, so the client silently re-offers a list.
    const inStatus = s.attendance[args.inId]?.status;
    if (inStatus !== 'AVAILABLE' && inStatus !== 'PAUSED') {
      throw new ConflictError([args.inId]);
    }

    const gRef = db.doc(`sessions/${sessionId}/games/${court.gameId}`);
    const gSnap = await tx.get(gRef);
    const g = gSnap.data() as Game | undefined;
    if (!g || g.winner !== null) {
      // recordResult() must have landed between the client's read and
      // this commit — the court is no longer actually in play.
      throw new SwapError('this match was just recorded — nothing to swap');
    }

    // --- BEFORE snapshot — not for undo (a swap can't be meaningfully
    // undone once points may have been scored on the new configuration),
    // but so "the app says I played that match and I definitely didn't"
    // has an answer.
    const before = {
      courtPlayers: court.players,
      teamA: court.teamA,
      teamB: court.teamB,
      outAttendance: { id: args.outId, ...s.attendance[args.outId] },
      inAttendance: { id: args.inId, ...s.attendance[args.inId] },
    };

    const swapId = (id: PlayerId) => (id === args.outId ? args.inId : id);
    const players = court.players.map(swapId) as PlayerId[];
    const teamA = court.teamA.map(swapId) as [PlayerId, PlayerId];
    const teamB = court.teamB.map(swapId) as [PlayerId, PlayerId];

    const courts = s.courts.map(c =>
      c.idx === args.courtIdx ? { ...c, players, teamA, teamB } : c);   // gameId/startedAt UNCHANGED

    const attendance = { ...s.attendance };
    attendance[args.outId] = {
      ...attendance[args.outId],
      status: 'AVAILABLE',
      freeAt: now,   // he left NOW, not when the match started. gamesToday untouched — he didn't play.
    };
    attendance[args.inId] = {
      ...attendance[args.inId],
      status: 'PLAYING',
      // freeAt/gamesToday untouched here — gamesToday only increments
      // at recordResult(), for whoever is actually on the court then.
    };

    tx.update(sRef, { attendance, courts });
    tx.update(gRef, { teamA, teamB });   // the copy recordResult() actually reads
    tx.set(lRef, {
      at: now, actor: args.actor, action: 'SWAP',
      payload: { courtIdx: args.courtIdx, outId: args.outId, inId: args.inId, before },
    });

    return { gameId: court.gameId };
  });
}

// ============================================================
// READ — build input for the pure core
// ============================================================

/**
 * Converts a SessionDoc → parameters for suggestMatch().
 *
 * Note: this function does NOT call Date.now() and does NOT call
 * Math.random(). They're passed in. That's why lib/ is testable
 * without mocks.
 */
export function buildMatchmakingInput(
  s: SessionDoc,
  pairs: PairStats,
  now: number,
  config: MatchmakingConfig = DEFAULT_CONFIG,
) {
  const players = new Map<PlayerId, ClubPlayer>();
  for (const [id, p] of Object.entries(s.players)) {
    players.set(id, {
      ...p, seedRank: 0, gamesTotal: 0,
      lastPlayedAt: null, isGuest: false, active: true,
    });
  }

  const attendance = new Map<PlayerId, Attendance>();
  for (const [id, a] of Object.entries(s.attendance)) {
    // Defensive: an attendance entry with no matching players entry
    // must never reach suggestMatch() — see checkInBatch() above
    // (UC-17). If this ever fires, checkInBatch's denormalization has
    // a gap somewhere else; better to silently drop the one entry
    // than kill suggestions for the whole session.
    if (!s.players[id]) continue;
    attendance.set(id, { playerId: id, ...a });
  }

  // Who's on a DIFFERENT court right now
  const busy = new Set<PlayerId>();
  for (const c of s.courts) {
    if (c.players) for (const id of c.players) busy.add(id);
  }

  return { now, players, attendance, pairStats: pairs, config, busy };
}

/** Suggestion for one court. LOCKS NOBODY — display only. */
export async function getSuggestion(
  db: Firestore,
  sessionId: string,
  clubId: string,
  now = Date.now(),
): Promise<Suggestion | null> {
  const [sSnap, pSnap] = await Promise.all([
    db.doc(`sessions/${sessionId}`).get(),
    db.doc(`clubs/${clubId}/meta/pairStats`).get(),
  ]);
  const s = sSnap.data() as SessionDoc;
  const pairs = (pSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};

  return suggestMatch(buildMatchmakingInput(s, pairs, now));
}

// ============================================================
// CO-ATTENDANCE — runs ONCE when the session roster is finalized
// ============================================================

/**
 * Updates co_present for EVERY pair in the roster.
 *
 * This is the DENOMINATOR of the normalization:
 *
 *   Minh attended 15/16 sessions, never partnered with Tuan → 0/15 = a BIG gap
 *   Lan  attended  2/16 sessions, never partnered with Tuan → 0/2  = says nothing yet
 *
 * A raw count sees both as = 0 and treats them the same. Wrong.
 *
 * Runs ONCE when the session starts, not every game.
 * C(22,2) = 231 pairs. One write.
 */
export async function bumpCoAttendance(
  db: Firestore,
  clubId: string,
  presentIds: PlayerId[],
  now = Date.now(),
): Promise<void> {
  const ref = db.doc(`clubs/${clubId}/meta/pairStats`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(ref);
    const stats = (snap.data() as PairStatsDoc | undefined)?.pairs ?? {};

    const ids = [...presentIds].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = pairKey(ids[i], ids[j]);
        const cur = stats[k] ?? { partnered: 0, opposed: 0, coPresent: 0 };
        stats[k] = { ...cur, coPresent: cur.coPresent + 1 };
      }
    }
    tx.set(ref, { pairs: stats, updatedAt: now });
  });
}

// ============================================================
// PLAYERS — CRUD + seed ranking
//
// SPLIT DOCS per firestore.rules:
//   clubs/{cid}/players/{pid}   ← open read (to show names). NO mu/sigma.
//   clubs/{cid}/private/ratings ← server only. { [playerId]: {mu, sigma} }
//
// Hiding rating for 3 months means hiding it from the client — so
// rating must not live in a doc the client reads directly.
// ============================================================

export interface PublicPlayerDoc {
  id: PlayerId;
  name: string;
  gender: 'M' | 'F';
  div: 1 | 2;
  seedRank: number;
  gamesTotal: number;
  lastPlayedAt: number | null;
  isGuest: boolean;
  active: boolean;
}

/** clubs/{cid}/private/ratings — one doc, a map of every player. */
export interface RatingsDoc {
  ratings: Record<PlayerId, { mu: number; sigma: number }>;
  updatedAt: number;
}

/**
 * Adds a new player. seedRank = bottom of that division's table
 * (among active players). Admin drags to reorder afterward (see
 * reorderDivision).
 */
export async function createPlayer(
  db: Firestore,
  clubId: string,
  args: { name: string; gender: 'M' | 'F'; div: 1 | 2 },
  now = Date.now(),
): Promise<PublicPlayerDoc> {
  const playersRef = db.collection(`clubs/${clubId}/players`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);
  const ref = playersRef.doc();

  return db.runTransaction(async (tx: Transaction) => {
    const [divSnap, ratingsSnap] = await Promise.all([
      tx.get(playersRef.where('div', '==', args.div).where('active', '==', true)),
      tx.get(ratingsRef),
    ]);

    const divSize = divSnap.size + 1;
    const seedRank = divSize;
    const player: PublicPlayerDoc = {
      id: ref.id, name: args.name, gender: args.gender, div: args.div,
      seedRank, gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true,
    };

    const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
    ratings[ref.id] = { mu: seedMu(args.div, seedRank, divSize), sigma: SIGMA_INIT };

    tx.set(ref, player);
    tx.set(ratingsRef, { ratings, updatedAt: now });
    return player;
  });
}

/** Edit name / gender / active. Does NOT edit div or seedRank here — use reorderDivision. */
export async function updatePlayer(
  db: Firestore,
  clubId: string,
  playerId: PlayerId,
  patch: Partial<Pick<PublicPlayerDoc, 'name' | 'gender' | 'active'>>,
): Promise<void> {
  await db.doc(`clubs/${clubId}/players/${playerId}`).update(patch);
}

/**
 * Drag-and-drop reorder WITHIN a division → writes back seedRank +
 * recomputes mu via seedMu(). Does NOT touch sigma — sigma reflects
 * games actually played, not a rank the admin assigned.
 */
export async function reorderDivision(
  db: Firestore,
  clubId: string,
  div: 1 | 2,
  orderedIds: PlayerId[],
  now = Date.now(),
): Promise<void> {
  const playersRef = db.collection(`clubs/${clubId}/players`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);

  await db.runTransaction(async (tx: Transaction) => {
    const [playerSnaps, ratingsSnap] = await Promise.all([
      Promise.all(orderedIds.map(id => tx.get(playersRef.doc(id)))),
      tx.get(ratingsRef),
    ]);

    const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};

    orderedIds.forEach((id, i) => {
      if (!playerSnaps[i].exists) throw new Error(`player not found: ${id}`);
      const seedRank = i + 1;
      tx.update(playersRef.doc(id), { seedRank });
      const cur = ratings[id] ?? { mu: 0, sigma: SIGMA_INIT };
      ratings[id] = { mu: seedMu(div, seedRank, orderedIds.length), sigma: cur.sigma };
    });

    tx.set(ratingsRef, { ratings, updatedAt: now });
  });
}

// ============================================================
// SESSION LIFECYCLE — DRAFT (created ahead of time, roster set) →
// LIVE (someone tapped "Start session") → DONE (no UI path yet).
//
// A session's id is the PLAY date, chosen explicitly by the admin in
// /admin/session/new — never inferred from the clock. See lib/
// session-id.ts: there is no more "todaySessionId()".
// ============================================================

/**
 * Creates sessions/{sessionId} fresh, with copies of
 * {name,gender,div,mu,sigma} for the selected people (denormalized —
 * see the top of this file).
 *
 * REFUSES if a session already exists at that id, in ANY status.
 *
 * Used to merge into an existing doc (any status) — that was wrong:
 * "create a new session" for a date that happens to collide with an
 * old DONE/LIVE/legacy session silently wrote into dead data and
 * never revived its status, so the result was invisible to
 * getActiveSession() (which only ever looks at LIVE/DRAFT) — a POST
 * that returns 200 and does something, but nothing anyone can see.
 * The date IS the document id, so a real collision is exactly the
 * "wrong date" mistake this should surface, not swallow. Editing an
 * EXISTING DRAFT on purpose goes through setDraftRoster()/the
 * /admin/session/new "edit" flow instead — that's the only case where
 * writing into an existing doc is intended.
 */
export class SessionExistsError extends Error {
  constructor(public sessionId: string) { super(`a session already exists for ${sessionId}`); }
}

export async function ensureSessionAndPlayers(
  db: Firestore,
  clubId: string,
  args: { sessionId: string; courtCount: number; playerIds: PlayerId[] },
  now = Date.now(),
): Promise<{ created: true }> {
  const sRef = db.doc(`sessions/${args.sessionId}`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);
  const playersRef = db.collection(`clubs/${clubId}/players`);

  return db.runTransaction(async (tx: Transaction) => {
    const [sSnap, ratingsSnap, playerSnaps] = await Promise.all([
      tx.get(sRef),
      tx.get(ratingsRef),
      Promise.all(args.playerIds.map(id => tx.get(playersRef.doc(id)))),
    ]);

    if (sSnap.exists) throw new SessionExistsError(args.sessionId);

    const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
    const players: Record<PlayerId, SessionPlayer> = {};
    for (const snap of playerSnaps) {
      if (!snap.exists) continue;
      const p = snap.data() as PublicPlayerDoc;
      const r = ratings[p.id] ?? { mu: 50, sigma: SIGMA_INIT };
      players[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: r.mu, sigma: r.sigma };
    }

    const doc: SessionDoc = {
      id: args.sessionId, clubId, date: args.sessionId,
      courtCount: args.courtCount, targetHeadcount: args.playerIds.length,
      mode: 'OFF', status: 'DRAFT', players, attendance: {},
      courts: Array.from({ length: args.courtCount }, (_, i) => ({
        idx: i, gameId: null, players: null, teamA: null, teamB: null, startedAt: null,
      })),
      startedAt: now, endedAt: null,
    };
    tx.set(sRef, doc);
    return { created: true };
  });
}

/**
 * /admin/session/new flow: FINALIZES the session roster (courts +
 * ~22 people, for an admin-chosen play date) as a DRAFT — checks
 * NOBODY in and does not go live. This is the real moment the roster
 * is "finalized" (see the bumpCoAttendance comment in this file), so
 * co-attendance is bumped here, not deferred to /checkin.
 */
export async function createSessionRoster(
  db: Firestore,
  clubId: string,
  args: { sessionId: string; courtCount: number; playerIds: PlayerId[] },
  now = Date.now(),
): Promise<{ created: true }> {
  const result = await ensureSessionAndPlayers(db, clubId, args, now);
  await bumpCoAttendance(db, clubId, args.playerIds, now);
  return result;
}

/**
 * / flow: admin taps "Start session" on a DRAFT → LIVE. This is the
 * only place a session becomes the one / renders (see
 * lib/use-active-session.ts). Does not touch attendance — checking
 * people in is a separate, later action.
 */
/**
 * Refuses if any OTHER session is already LIVE. Hit this for real
 * three times in one afternoon of testing — Firestore's LIVE query
 * has no ordering, so with two LIVE sessions, whichever phone loads
 * `/` first gets an arbitrary one, silently. Better to block the
 * SECOND "Start session" outright than let that happen to a real
 * 22-person session. See AlreadyLiveError and
 * lib/use-active-session.ts (which additionally refuses to silently
 * pick one if this check is ever bypassed, e.g. by two admins tapping
 * "Start session" on two different DRAFTs in the same instant).
 */
export class AlreadyLiveError extends Error {
  constructor(public liveSessionId: string, public liveDate: string) {
    super(`a session is already live (${liveDate})`);
  }
}

export async function startSession(db: Firestore, sessionId: string): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const liveQuery = db.collection('sessions').where('status', '==', 'LIVE');

  await db.runTransaction(async (tx: Transaction) => {
    const [sSnap, liveSnap] = await Promise.all([tx.get(sRef), tx.get(liveQuery)]);
    if (!sSnap.exists) throw new Error('session not found');

    const other = liveSnap.docs.find(d => d.id !== sessionId);
    if (other) {
      const otherData = other.data() as SessionDoc;
      throw new AlreadyLiveError(other.id, otherData.date);
    }

    tx.update(sRef, { status: 'LIVE' });
  });
}

export class NotLiveError extends Error {
  constructor() { super('only a LIVE session can be ended'); }
}

/**
 * Admin-initiated end, from /admin/sessions — deliberately separate
 * from UC-12's automatic staleness check (useActiveSession() already
 * skips a LIVE session dated before today; that's the thing that
 * actually protects against "the session never ends," not this
 * button — see the comment in lib/use-active-session.ts). This is for
 * an admin who wants to close out TODAY's session early, on purpose.
 *
 * Does NOT touch in-progress courts/games — any court still showing a
 * gameId when this runs stays exactly as it is, inside a session that
 * / and /admin no longer surface. The caller is expected to check
 * (and warn) before calling this; see the confirm text in
 * app/admin/sessions/page.tsx.
 *
 * Also writes the LEADERBOARD.md Phase 1 rating snapshot — every
 * present member's end-of-session mu/sigma/gamesTotal. Data
 * collection only; nothing reads this field yet.
 */
export async function endSession(db: Firestore, clubId: string, sessionId: string, now = Date.now()): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);

  await db.runTransaction(async (tx: Transaction) => {
    const sSnap = await tx.get(sRef);
    const s = sSnap.data() as SessionDoc | undefined;
    if (!s || s.status !== 'LIVE') throw new NotLiveError();

    const presentIds = Object.keys(s.attendance).filter(id => !id.startsWith('guest-'));
    const memberRefs = presentIds.map(id => db.doc(`clubs/${clubId}/players/${id}`));
    const memberSnaps = await Promise.all(memberRefs.map(r => tx.get(r)));

    const ratings: NonNullable<SessionDoc['ratingSnapshot']>['ratings'] = [];
    presentIds.forEach((id, i) => {
      const memberSnap = memberSnaps[i];
      const sp = s.players[id];
      if (!memberSnap.exists || !sp) return;
      const gamesTotal = (memberSnap.data() as PublicPlayerDoc).gamesTotal;
      ratings.push({ id, mu: sp.mu, sigma: sp.sigma, gamesTotal });
    });

    tx.update(sRef, {
      status: 'DONE',
      endedAt: now,
      ratingSnapshot: { at: now, ratings },
    });
  });
}

// ============================================================
// EDITING A DRAFT — wrong date, wrong headcount, wrong court count.
// Cheap to fix ONLY before check-in: a DRAFT has no attendance and no
// games, so there is nothing derived to protect (contrast with UC-2 in
// USECASES.md — LIVE-with-games is a different, harder problem with
// no rebuildClubState() yet. This does NOT touch that case at all.)
// ============================================================

export class NotDraftError extends Error {
  constructor() { super('only a DRAFT session (no check-in yet) can be edited or deleted'); }
}

/**
 * Replaces the roster and court count of a DRAFT in place — REPLACE,
 * not merge (unlike ensureSessionAndPlayers, which is add-only because
 * it also has to be safe to call on a LIVE session mid-game). Safe
 * here specifically because a DRAFT has no attendance/mu-sigma-in-
 * progress to lose.
 *
 * Does NOT re-run bumpCoAttendance — that's tied to the roster being
 * finalized for the first time (see createSessionRoster). Editing a
 * DRAFT before it's ever gone LIVE isn't a second real session.
 */
export async function setDraftRoster(
  db: Firestore,
  clubId: string,
  sessionId: string,
  args: { courtCount: number; playerIds: PlayerId[] },
): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);
  const playersRef = db.collection(`clubs/${clubId}/players`);

  await db.runTransaction(async (tx: Transaction) => {
    const [sSnap, ratingsSnap, playerSnaps] = await Promise.all([
      tx.get(sRef),
      tx.get(ratingsRef),
      Promise.all(args.playerIds.map(id => tx.get(playersRef.doc(id)))),
    ]);
    const s = sSnap.data() as SessionDoc | undefined;
    if (!s || s.status !== 'DRAFT') throw new NotDraftError();

    const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
    const players: Record<PlayerId, SessionPlayer> = {};
    for (const snap of playerSnaps) {
      if (!snap.exists) continue;
      const p = snap.data() as PublicPlayerDoc;
      const r = ratings[p.id] ?? { mu: 50, sigma: SIGMA_INIT };
      players[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: r.mu, sigma: r.sigma };
    }

    const courts = Array.from({ length: args.courtCount }, (_, i) => ({
      idx: i, gameId: null, players: null, teamA: null, teamB: null, startedAt: null,
    }));

    tx.update(sRef, {
      players, courts,
      courtCount: args.courtCount,
      targetHeadcount: args.playerIds.length,
    });
  });
}

/**
 * Hard delete — ONLY for a DRAFT. Refuses on LIVE/DONE, same
 * reasoning as setDraftRoster. This is how a wrong PLAY DATE gets
 * fixed: the date is the document id, so there's no "rename" — delete
 * the wrong one, create a fresh one at the correct date.
 */
export async function deleteDraftSession(db: Firestore, sessionId: string): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc | undefined;
    if (!s || s.status !== 'DRAFT') throw new NotDraftError();
    tx.delete(sRef);
  });
}

/**
 * Hard delete for ANY status (DRAFT/LIVE/DONE) — ADMIN-tier, "not
 * undoable" per CLAUDE.md ROLES. Unlike deleteDraftSession this also
 * removes the games/audit subcollections (a DRAFT never has any, but
 * a LIVE/DONE session does — Firestore doesn't cascade-delete them).
 *
 * Deliberately does NOT touch clubs/{cid}/players or
 * clubs/{cid}/private/ratings: any games already recorded here already
 * updated those permanently. Deleting the session removes the record
 * of the games, not their effect on ratings — reverting that would
 * need the same rebuildClubState() this codebase doesn't have yet
 * (see the DRAFT-only note above). That's a real, accepted consequence
 * of "not undoable," not a bug.
 */
export async function deleteSession(db: Firestore, sessionId: string): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const [gamesSnap, auditSnap] = await Promise.all([
    db.collection(`sessions/${sessionId}/games`).get(),
    db.collection(`sessions/${sessionId}/audit`).get(),
  ]);
  const batch = db.batch();
  for (const d of gamesSnap.docs) batch.delete(d.ref);
  for (const d of auditSnap.docs) batch.delete(d.ref);
  batch.delete(sRef);
  await batch.commit();
}

// ============================================================
// MODE — OFF / RECORD / ASSIGN, changeable any time mid-session
// ============================================================

export async function setMode(
  db: Firestore,
  sessionId: string,
  mode: 'OFF' | 'RECORD' | 'ASSIGN',
): Promise<void> {
  await db.doc(`sessions/${sessionId}`).update({ mode });
}

// ============================================================
// PAUSE — AVAILABLE ↔ PAUSED, only via an explicit tap (see ARCHITECTURE.md §5).
//
// ONLY changes status. Does NOT touch freeAt — pausing shouldn't lose
// the queue position already accrued (a 5-minute bathroom break
// shouldn't send you to the back of the line).
// ============================================================

export async function setPaused(
  db: Firestore,
  sessionId: string,
  playerId: PlayerId,
  paused: boolean,
): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;
    const cur = s.attendance[playerId];
    if (!cur || (cur.status !== 'AVAILABLE' && cur.status !== 'PAUSED')) return; // PLAYING/LEFT → skip
    tx.update(sRef, { [`attendance.${playerId}.status`]: paused ? 'PAUSED' : 'AVAILABLE' });
  });
}

// ============================================================
// LEFT — gone home. See USECASES.md UC-13.
//
// One-directional by design (no "un-leave" in this pass — matches
// the trigger: "it's 11:20, he's going home"). gamesToday is
// PRESERVED, not reset — that data is still true, he really did play
// those games tonight. Only settable from AVAILABLE/PAUSED, same as
// setPaused — you can't vanish out from under an in-progress match;
// swap them out first (see swapPlayerOnCourt), then mark LEFT.
// ============================================================

export async function setLeft(
  db: Firestore,
  sessionId: string,
  playerId: PlayerId,
  now = Date.now(),
): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;
    const cur = s.attendance[playerId];
    if (!cur || (cur.status !== 'AVAILABLE' && cur.status !== 'PAUSED')) return; // PLAYING/LEFT → skip
    tx.update(sRef, {
      [`attendance.${playerId}.status`]: 'LEFT',
      [`attendance.${playerId}.leftAt`]: now,
    });
  });
}

// ============================================================
// DROP-IN GUESTS — added directly to the session, WITHOUT creating a
// doc in clubs/{cid}/players (guests aren't part of the fixed 55-person roster).
//
// Initial sigma is LARGER than a member's (15 vs 8) — this is the
// mechanism that self-protects member ratings when playing with a
// guest (see lib/rating.ts, updateRatings: the change scales with
// sigma², no extra code needed).
// ============================================================

const GUEST_SIGMA = 15;
const GUEST_MU = 50;

export async function addGuest(
  db: Firestore,
  sessionId: string,
  args: { name: string; gender: 'M' | 'F' },
  now = Date.now(),
): Promise<{ id: PlayerId }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const id = `guest-${db.collection('_ids').doc().id}`;

  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;

    const players = {
      ...s.players,
      [id]: { id, name: args.name, gender: args.gender, div: 1 as const, mu: GUEST_MU, sigma: GUEST_SIGMA },
    };
    const attendance = {
      ...s.attendance,
      [id]: { status: 'AVAILABLE' as const, checkedInAt: now, leftAt: null, gamesToday: 0, freeAt: now },
    };

    tx.update(sRef, { players, attendance });
  });

  return { id };
}

// ============================================================
// UNDO — only within 60 seconds, only the MOST RECENT action.
// Currently only supports undoing RESULT (Step 2). Undoing ASSIGN
// will be added when ASSIGN mode is built (Step 5) — the assign
// payload doesn't currently snapshot "before" since assign itself
// doesn't change rating/pairStats.
// ============================================================

export async function undoResult(
  db: Firestore,
  sessionId: string,
  clubId: string,
  auditLogId: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const aRef = db.doc(`sessions/${sessionId}/audit/${auditLogId}`);
  const pRef = db.doc(`clubs/${clubId}/meta/pairStats`);
  const rRef = db.doc(`clubs/${clubId}/private/ratings`);

  return db.runTransaction(async (tx: Transaction) => {
    const [aSnap, sSnap, pSnap, rSnap] = await Promise.all([
      tx.get(aRef), tx.get(sRef), tx.get(pRef), tx.get(rRef),
    ]);
    const audit = aSnap.data();
    if (!audit) return { ok: false, error: 'log not found' };
    if (audit.action !== 'RESULT') return { ok: false, error: 'only a game result can be undone' };
    if (audit.undoneAt) return { ok: false, error: 'already undone' };
    if (now - audit.at > 60_000) return { ok: false, error: 'more than 60 seconds ago — can no longer be undone' };

    const { gameId, courtIdx, before } = audit.payload as {
      gameId: string; courtIdx: number;
      before: {
        ratings: Array<{ id: PlayerId; mu: number; sigma: number }>;
        attendance: Array<{ id: PlayerId; gamesToday: number; freeAt: number; status: string }>;
        pairs: Array<{ key: string; partnered: number; opposed: number; coPresent: number }>;
        members: Array<{ id: PlayerId; gamesTotal: number; lastPlayedAt: number | null }>;
      };
    };

    const gRef = db.doc(`sessions/${sessionId}/games/${gameId}`);
    const memberRefs = before.members.map(m => db.doc(`clubs/${clubId}/players/${m.id}`));
    const [gSnap, ...memberSnaps] = await Promise.all([tx.get(gRef), ...memberRefs.map(r => tx.get(r))]);
    const g = gSnap.data() as Game | undefined;
    if (!g) return { ok: false, error: 'game not found' };

    const s = sSnap.data() as SessionDoc;
    const players = { ...s.players };
    const clubRatings = (rSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
    for (const r of before.ratings) {
      players[r.id] = { ...players[r.id], mu: r.mu, sigma: r.sigma };
      if (!r.id.startsWith('guest-')) clubRatings[r.id] = { mu: r.mu, sigma: r.sigma };
    }

    const attendance = { ...s.attendance };
    for (const a of before.attendance) {
      attendance[a.id] = {
        ...attendance[a.id],
        gamesToday: a.gamesToday, freeAt: a.freeAt,
        status: a.status as SessionDoc['attendance'][string]['status'],
      };
    }

    const stats = (pSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};
    for (const pr of before.pairs) stats[pr.key] = { partnered: pr.partnered, opposed: pr.opposed, coPresent: pr.coPresent };

    // The court was freed by recordResult() — restore the game that
    // was actually in progress using data from the game doc itself
    // (teamA/teamB/startedAt haven't changed).
    //
    // KNOWN GAP, not fixed (deferred — see USECASES.md UC-2 STATUS
    // note, same family of risk): this unconditionally overwrites
    // courts[courtIdx], with no check that the court is still empty.
    // If a NEW game gets assigned to this same court inside the 60s
    // undo window — plausible, ASSIGN mode refills empty courts fast —
    // and THEN someone undoes the OLD result, this silently clobbers
    // the new game's court slot back to the old one. The new game's 4
    // players stay PLAYING with no court pointing at their gameId:
    // stuck, can't record a result, can't be reassigned. Same shape as
    // the silent six (no error, nobody notices) but requires two
    // independent actions within 60s of each other, so it's lower
    // probability. Fix would be: re-check court.gameId is still null
    // before restoring, and refuse (return ok:false) if it's been
    // reassigned. Not built — not worth the hours before the trial.
    const courts = s.courts.map(c =>
      c.idx === courtIdx
        ? { ...c, gameId: g.id, players: [...g.teamA, ...g.teamB], teamA: g.teamA, teamB: g.teamB, startedAt: g.startedAt }
        : c);

    tx.update(sRef, { players, attendance, courts });
    tx.set(pRef, { pairs: stats, updatedAt: now });
    tx.set(rRef, { ratings: clubRatings, updatedAt: now });
    for (let i = 0; i < before.members.length; i++) {
      if (!memberSnaps[i].exists) continue;
      const m = before.members[i];
      tx.update(memberRefs[i], { gamesTotal: m.gamesTotal, lastPlayedAt: m.lastPlayedAt });
    }
    // scoreLoser is part of the match, not a separate note — UC-21. If a
    // score was saved (a SECOND write, after the winner) and then Undo
    // is tapped, it must go with the rest of the result, not survive as
    // an orphaned number attached to a game with no winner.
    tx.update(gRef, { winner: null, endedAt: null, scoreLoser: null, scoreWinner: null });
    tx.update(aRef, { undoneAt: now });

    return { ok: true };
  });
}

// ============================================================
// LEADERBOARD — read-only aggregation for /board + /me (#5)
//
// Mixing needs pairStats, Skill needs sigma — both live in server-only
// docs (clubs/{cid}/meta/*, clubs/{cid}/private/*, see firestore.rules:
// "allow read, write: if false"). The client can never read either
// directly, so this is computed here and exposed through GET
// /api/board. mu is NEVER returned: only sigma (an uncertainty number,
// not a rating), gamesTotal, and a COARSE skill band derived from mu
// server-side (Beginner/Intermediate/Advanced — a bucket, not the
// number). The raw mu never leaves this function. See LEADERBOARD.md §5
// (and its provisional-band decision note) and lib/skill-band.ts.
// ============================================================

/** "Attended N of the last M sessions" — M caps at this many, or fewer
 * if the club hasn't played that many yet. */
const ATTENDANCE_WINDOW = 16;

export interface BoardMember {
  id: PlayerId;
  name: string;
  mixing: { partners: number; possible: number; neverPartneredWith: string[] };
  attendance: { attended: number; ofLast: number; streak: number };
  skill: {
    gamesTotal: number;
    sigma: number;
    converged: boolean;
    // Coarse band derived from mu server-side — the number itself is
    // never sent. null = not enough signal yet (< 3 games / no rating).
    band: SkillBand | null;
    provisional: boolean;
    settling: boolean;
    adjacentBand: SkillBand | null;
  };
}

export interface BoardData {
  members: BoardMember[];
  groupSkillReady: number;
  totalActiveMembers: number;
  snapshotsCount: number;
  totalSessions: number;
}

export async function getBoardData(db: Firestore, clubId: string): Promise<BoardData> {
  const [playersSnap, ratingsSnap, pairsSnap, sessionsSnap] = await Promise.all([
    db.collection(`clubs/${clubId}/players`).get(),
    db.doc(`clubs/${clubId}/private/ratings`).get(),
    db.doc(`clubs/${clubId}/meta/pairStats`).get(),
    db.collection('sessions').get(),
  ]);

  // Guests are never written to clubs/{cid}/players (see addGuest —
  // they only ever live inside a session doc), so they're already
  // excluded here. "Guests never appear on any board."
  const members = playersSnap.docs
    .map(d => d.data() as PublicPlayerDoc)
    .filter(p => p.active && !p.isGuest);

  const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
  const pairs = (pairsSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};

  // DRAFT sessions haven't happened yet — don't count toward attendance.
  // Date-string ids ("2026-07-18") sort chronologically as plain strings.
  const sessions = sessionsSnap.docs
    .map(d => d.data() as SessionDoc)
    .filter(s => s.status !== 'DRAFT')
    .sort((a, b) => a.id.localeCompare(b.id));

  const totalSessions = sessions.length;
  const snapshotsCount = sessions.filter(s => !!s.ratingSnapshot).length;
  const ofLast = Math.min(ATTENDANCE_WINDOW, totalSessions);
  const windowSessions = sessions.slice(totalSessions - ofLast);

  const boardMembers: BoardMember[] = members.map(p => {
    const attended = windowSessions.filter(s => !!s.attendance[p.id]).length;

    let streak = 0;
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (sessions[i].attendance[p.id]) streak++;
      else break;
    }

    // Denominator is coPresent (been at a planned session together),
    // NOT every other member — otherwise a newcomer looks terrible for
    // no reason. See LEADERBOARD.md §1 / the Mixing tab data note.
    let partners = 0;
    let possible = 0;
    const neverPartneredWith: string[] = [];
    for (const other of members) {
      if (other.id === p.id) continue;
      const stat = pairs[pairKey(p.id, other.id)];
      if (!stat || stat.coPresent === 0) continue;
      possible++;
      if (stat.partnered > 0) partners++;
      else neverPartneredWith.push(other.name);
    }

    // mu is read here ONLY to derive the coarse band — it is never put
    // in the returned object. null when the player has no rating doc
    // yet (0 games), which computeSkillBand treats as "no band".
    const mu = ratings[p.id]?.mu ?? null;
    const sigma = ratings[p.id]?.sigma ?? SIGMA_INIT;
    const converged = isConverged({ sigma, gamesTotal: p.gamesTotal } as ClubPlayer);
    const b = computeSkillBand(mu, sigma, p.gamesTotal);

    return {
      id: p.id,
      name: p.name,
      mixing: { partners, possible, neverPartneredWith },
      attendance: { attended, ofLast, streak },
      skill: {
        gamesTotal: p.gamesTotal,
        sigma,
        converged,
        band: b.band,
        provisional: b.provisional,
        settling: b.settling,
        adjacentBand: b.adjacentBand,
      },
    };
  });

  return {
    members: boardMembers,
    groupSkillReady: boardMembers.filter(m => m.skill.converged).length,
    totalActiveMembers: boardMembers.length,
    snapshotsCount,
    totalSessions,
  };
}

// ============================================================
// F-2 — post-session summary, pasted into the group chat
//
// The app sleeps six days a week; this message is the only thing
// reminding the group it exists. Mixing leads (the project's actual
// goal), no rating/score (six months out, see LEADERBOARD.md §5),
// and /board is the only discovery path for the boards built above —
// there is deliberately no link to either from `/`. See USECASES.md F-2.
// ============================================================

export interface SessionSummary {
  date: string;
  presentCount: number;
  matchCount: number;
  /** null when nobody present has any all-time partners yet (early weeks) — omit the line, don't crown a 0. */
  mostMixed: { name: string; partners: number } | null;
  /** null only if literally nobody present attended tonight, which can't happen — kept Nullable for symmetry with mostMixed. */
  longestStreak: { name: string; streak: number } | null;
  /** "A–B" formatted. Empty → the UI drops the line entirely, per the spec. */
  firstTimePairNames: string[];
}

export async function getSessionSummary(db: Firestore, clubId: string, sessionId: string): Promise<SessionSummary> {
  const sSnap = await db.doc(`sessions/${sessionId}`).get();
  const s = sSnap.data() as SessionDoc | undefined;
  if (!s) throw new Error(`session not found: ${sessionId}`);

  const gamesSnap = await db.collection(`sessions/${sessionId}/games`).get();
  const matchCount = gamesSnap.docs
    .map(d => d.data() as Game)
    .filter(g => g.status === 'OK' && g.endedAt !== null).length;

  const presentCount = Object.keys(s.attendance).length;

  // Reuses getBoardData() rather than recomputing mixing/streak from
  // scratch — same numbers /board shows, one source of truth.
  const board = await getBoardData(db, clubId);
  const attendeeIds = new Set(Object.keys(s.attendance));
  const candidates = board.members.filter(m => attendeeIds.has(m.id));

  let mostMixed: SessionSummary['mostMixed'] = null;
  for (const m of candidates) {
    if (m.mixing.partners > 0 && (!mostMixed || m.mixing.partners > mostMixed.partners)) {
      mostMixed = { name: m.name, partners: m.mixing.partners };
    }
  }

  let longestStreak: SessionSummary['longestStreak'] = null;
  for (const m of candidates) {
    if (m.attendance.streak > 0 && (!longestStreak || m.attendance.streak > longestStreak.streak)) {
      longestStreak = { name: m.name, streak: m.attendance.streak };
    }
  }

  const firstTimePairNames = (s.firstTimePairs ?? []).map(k => {
    const [a, b] = k.split('|');
    const nameA = s.players[a]?.name ?? a;
    const nameB = s.players[b]?.name ?? b;
    return `${nameA}–${nameB}`;
  });

  return { date: s.date, presentCount, matchCount, mostMixed, longestStreak, firstTimePairNames };
}
