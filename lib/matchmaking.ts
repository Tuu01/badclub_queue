// ============================================================
// matchmaking.ts — Matchmaking engine
//
// TWO-TIER DESIGN. This is the whole secret:
//
//   TIER 1 — GATE (the bouncer)      → who gets into the waiting room? → FAIR
//   TIER 2 — PICK (the matchmaker)   → within the room, who gets picked? → MIX PEOPLE UP
//   TIER 3 — ALARM                   → is anyone being forgotten?
//
// WHY SPLIT IT INTO TWO?
//
//   If one mechanism did both jobs — e.g. "take the 4 people who've
//   waited longest" — then four people would go onto a court together
//   → come off together → their wait clocks reset at the same moment
//   → they go back ONTO a court together. Forever.
//
//   You'd build a machine to break up cliques, and it would create
//   cliques more perfect than natural ones.
//
//   Simulation: pure FIFO   → 2.44 different partners/session, 9.3 repeated pairs.
//               Two tiers   → 3.58 different partners (almost a new partner every game), 0 repeats.
//               And the number of games per person DOESN'T change. Nothing lost.
//
// CORE PRINCIPLE:
//   DON'T USE ONE NUMBER TO ANSWER TWO QUESTIONS.
//   One is a constraint. The other is a goal.
// ============================================================

import type {
  ClubPlayer, PlayerId, Attendance, PairStats,
  MatchmakingConfig, Suggestion,
} from './types';
import { pairKey } from './types';
import { teamRating, winProbability, canShowPrediction } from './rating';

const MS_PER_MIN = 60_000;

export interface MatchmakingInput {
  now: number;
  players: Map<PlayerId, ClubPlayer>;
  attendance: Map<PlayerId, Attendance>;
  pairStats: PairStats;
  config: MatchmakingConfig;
  /** Who's on a DIFFERENT court right now (can't be assigned to this game). */
  busy: Set<PlayerId>;
  /** Wildcard: this person REQUESTS to play with that person. Soft constraint, high priority. */
  wildcards?: Array<[PlayerId, PlayerId]>;
  /** Allows injecting an RNG for testability (defaults to Math.random). */
  rng?: () => number;
}

// ------------------------------------------------------------
// TIER 1 — GATE
// ------------------------------------------------------------

/**
 * Sorts across three tiers. A lower tier ONLY runs when the tier
 * above it ties.
 *
 *   1. GAMES played (fewest → goes first)
 *      ← this is the thing PEOPLE ARGUE ABOUT. Nobody counts minutes.
 *        (Simulation: gate by games played → game-count spread of 1.54.
 *                     gate by wait time → 1.61. Admins guess right.)
 *
 *   2. WAIT TIME (longest → goes first)
 *      ← only to break ties between people with the SAME game count
 *
 *   3. RANDOM DRAW
 *      ← when both tiers above tie. Happens when 4 people just came
 *        off a court at the same moment (wait = 0 for all of them
 *        identically), and at the START of a session (everyone at
 *        0 games, 0 minutes).
 *
 *        Simulation says tier 3 doesn't affect outcomes (tier 2, the
 *        picker, is already smart enough to compensate). But it still
 *        uses randomness because: (a) it's free, (b) it's insurance
 *        in case someone later lowers wRepeatPartner, (c) breaking
 *        ties by name would always put "An" ahead of "Vu", and
 *        someone would notice.
 */
export function buildQueue(
  input: MatchmakingInput,
): Array<{ id: PlayerId; games: number; waitMs: number }> {
  const { now, attendance, busy, rng = Math.random } = input;

  const pool: Array<{ id: PlayerId; games: number; waitMs: number; r: number }> = [];

  for (const [id, a] of attendance) {
    if (a.status !== 'AVAILABLE') continue;   // excludes PLAYING, PAUSED, LEFT
    if (busy.has(id)) continue;
    pool.push({
      id,
      games: a.gamesToday,
      waitMs: now - a.freeAt,
      r: rng(),
    });
  }

  pool.sort((x, y) =>
    x.games - y.games          // tier 1
    || y.waitMs - x.waitMs     // tier 2
    || x.r - y.r               // tier 3
  );

  return pool.map(({ id, games, waitMs }) => ({ id, games, waitMs }));
}

// ------------------------------------------------------------
// TIER 2 + 3 — PICK, with the ALARM
// ------------------------------------------------------------

/** Three ways to split 4 people into 2 teams. Only three — no more. */
function splits(four: PlayerId[]): Array<[[PlayerId, PlayerId], [PlayerId, PlayerId]]> {
  const [a, b, c, d] = four;
  return [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
}

/** Every k-element combination. */
function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  const n = arr.length;
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map(i => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * NORMALIZED BY CO-ATTENDANCE — not a raw count.
 *
 *   Minh attended 15/16 sessions, never partnered with Tuan → 0/15 = a BIG gap
 *   Lan  attended  2/16 sessions, never partnered with Tuan → 0/2  = says nothing yet
 *
 * A raw count sees both as = 0 and treats them the same → it goes
 * worrying about Lan when Minh is the real gap.
 *
 * One division. Worth 2.7% of coverage.
 *
 * NO DECAY. "An and Binh have played together" — that fact does NOT expire.
 * (Simulation: 0.9/week decay made coverage DROP from 78.8% to 76.9%.)
 */
function repetition(stats: PairStats, a: PlayerId, b: PlayerId, kind: 'partnered' | 'opposed'): number {
  const s = stats[pairKey(a, b)];
  if (!s) return 0;
  return s[kind] / Math.max(s.coPresent, 1);
}

export function suggestMatch(input: MatchmakingInput): Suggestion | null {
  const { now, players, attendance, pairStats, config, rng = Math.random } = input;

  const queue = buildQueue(input);
  if (queue.length < 4) return null;

  // ---- WINDOW ----
  const window = queue.slice(0, Math.min(config.windowSize, queue.length));

  // ---- ALARM: whoever has waited too long → MUST be in this game ----
  const starveMs = config.starvationMinutes * MS_PER_MIN;
  const forced = queue.filter(q => q.waitMs > starveMs).slice(0, 2).map(q => q.id);

  // Whoever is "starving" must be included in the window, even if they
  // didn't make the top 8.
  const candidateIds = new Set(window.map(w => w.id));
  for (const f of forced) candidateIds.add(f);
  const candidates = [...candidateIds];

  const waitOf = new Map(queue.map(q => [q.id, q.waitMs]));

  // ---- WILDCARD: requested pair ----
  const wildSet = new Set(
    (input.wildcards ?? []).map(([a, b]) => pairKey(a, b)),
  );

  // ---- EXHAUSTIVE SEARCH. C(8,4) × 3 = 210 options. 0.4ms. ----
  // No need for simulated annealing. No need for a heuristic.
  // This is the rare case where the correct answer is the dumbest
  // approach: try everything, and you're GUARANTEED to find the
  // absolute optimum.
  type Scored = {
    four: PlayerId[]; teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId];
    cost: number; rp: number; ro: number; imb: number; waitSum: number; probA: number;
  };
  const scored: Scored[] = [];

  for (const four of combinations(candidates, 4)) {
    // The ALARM is a HARD constraint: if someone is starving, every
    // option that doesn't include them is thrown out outright.
    if (forced.length && !forced.every(f => four.includes(f))) {
      if (!four.includes(forced[0])) continue;
    }

    const four4 = four as [PlayerId, PlayerId, PlayerId, PlayerId];
    const ps = four4.map(id => players.get(id)!);
    if (ps.some(p => !p)) continue;

    const waitSum = four4.reduce((s, id) => s + (waitOf.get(id) ?? 0), 0) / MS_PER_MIN;
    const maxGames = Math.max(...four4.map(id => attendance.get(id)!.gamesToday));

    for (const [tA, tB] of splits(four4)) {
      // Keep matches in proper badminton categories. This depends on the SPLIT,
      // not just the four: {M,M,F,F} makes Mixed (1+1 | 1+1) OR the lopsided
      // 2M-vs-2W depending on how you divide it. Count women per team and
      // penalise the gap — MD/WD/XD all score 0, a woman-vs-all-men team scores
      // 1×, 2W-vs-2M scores 2×. Replaces the old anti-women's-doubles bias:
      // with ~1/3 of the club women, WD is now a normal match, not a hazard.
      const wA = (players.get(tA[0])!.gender === 'F' ? 1 : 0)
               + (players.get(tA[1])!.gender === 'F' ? 1 : 0);
      const wB = (players.get(tB[0])!.gender === 'F' ? 1 : 0)
               + (players.get(tB[1])!.gender === 'F' ? 1 : 0);

      const rp = repetition(pairStats, tA[0], tA[1], 'partnered')
               + repetition(pairStats, tB[0], tB[1], 'partnered');

      let ro = 0;
      for (const x of tA) for (const y of tB) ro += repetition(pairStats, x, y, 'opposed');

      const ra = teamRating(players.get(tA[0])!, players.get(tA[1])!);
      const rb = teamRating(players.get(tB[0])!, players.get(tB[1])!);
      const probA = winProbability(ra, rb);

      // BALANCE IS THE PRIMARY OBJECTIVE (owner decision — the club wants
      // even matches, not one-way games). It's ALWAYS on now, not gated on
      // convergence: once the admin has ranked players, the seed rating is
      // a real skill signal so P(win) is meaningful immediately. When
      // players are still unranked/bunched, P(win) ≈ 0.5 so this term
      // naturally does nothing — no harm. Mixing (rp/ro) is now secondary,
      // breaking ties among similarly-balanced splits. See wBalance in
      // DEFAULT_CONFIG for the weight that makes balance lead.
      const imb = Math.abs(probA - 0.5);

      // Wildcard: if this pair was requested → a large bonus
      const wild = (wildSet.has(pairKey(tA[0], tA[1])) ? 1 : 0)
                 + (wildSet.has(pairKey(tB[0], tB[1])) ? 1 : 0);

      const cost =
          config.wRepeatPartner  * rp
        + config.wRepeatOpponent * ro
        + config.wBalance        * imb
        - config.wWait           * waitSum
        + 2 * maxGames
        + config.wGenderMismatch * Math.abs(wA - wB)
        - 200 * wild;

      scored.push({ four: four4, teamA: tA, teamB: tB, cost, rp, ro, imb, waitSum, probA });
    }
  }

  if (!scored.length) return null;

  // ---- PICK RANDOMLY AMONG THE TOP-N ----
  // Prevents "the queue locking in": if we always took the #1 option,
  // options with identical cost (very common at the start of a
  // session, when everything is 0) would always return the FIRST
  // option found — and combinations() iterates in a fixed order. The
  // result: whoever is first in the list always gets picked, week
  // after week.
  scored.sort((a, b) => a.cost - b.cost);
  const top = scored.slice(0, Math.max(1, config.topN));
  const pick = top[Math.floor(rng() * top.length)];

  const ps = pick.four.map(id => players.get(id)!);

  return {
    four: pick.four as [PlayerId, PlayerId, PlayerId, PlayerId],
    teamA: pick.teamA,
    teamB: pick.teamB,
    predictedProbA: pick.probA,
    reason: explain(pick, players, pairStats, waitOf, forced, canShowPrediction(ps)),
    breakdown: {
      cost: pick.cost,
      repeatPartner: pick.rp,
      repeatOpponent: pick.ro,
      imbalance: pick.imb,
      waitSum: pick.waitSum,
      forced,
    },
  };
}

// ------------------------------------------------------------
// THE REASON SENTENCE — the single most important feature of the whole app
// ------------------------------------------------------------

/**
 * Without this sentence, the app is a DICTATOR.
 * With it, the app is a REFEREE.
 *
 * People argue with a referee. But people ACCEPT a referee.
 *
 * The app only runs 1 hour/week — it doesn't have time to "gradually
 * earn trust". It has to convince people on the very first game.
 *
 * Half a day of code. The highest (value / effort) ratio in the project.
 */
function explain(
  pick: { four: PlayerId[]; teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId]; probA: number },
  players: Map<PlayerId, ClubPlayer>,
  stats: PairStats,
  waitOf: Map<PlayerId, number>,
  forced: PlayerId[],
  showPrediction: boolean,
): string {
  const name = (id: PlayerId) => players.get(id)?.name ?? id;
  const parts: string[] = [];

  // 1. Which pair is new?
  for (const t of [pick.teamA, pick.teamB]) {
    const s = stats[pairKey(t[0], t[1])];
    if (!s || s.partnered === 0) {
      parts.push(`${name(t[0])} & ${name(t[1])} have never partnered.`);
    }
  }

  // 2. Who's starving? (mention this first — it explains a "strange" decision)
  if (forced.length) {
    const f = forced[0];
    const mins = Math.round((waitOf.get(f) ?? 0) / MS_PER_MIN);
    parts.unshift(`${name(f)} has waited ${mins} min — absolute priority.`);
  } else {
    // 3. Who among the 4 has waited longest?
    let longest = pick.four[0];
    for (const id of pick.four) {
      if ((waitOf.get(id) ?? 0) > (waitOf.get(longest) ?? 0)) longest = id;
    }
    const mins = Math.round((waitOf.get(longest) ?? 0) / MS_PER_MIN);
    if (mins >= 5) parts.push(`${name(longest)} has waited longest (${mins} min).`);
  }

  // 4. Prediction — ONLY once rating has converged.
  // A "62–38" prediction based on 3 games is a LIE, and it will fail
  // publicly in front of 22 people. You only lose that trust once.
  if (showPrediction) {
    const a = Math.round(pick.probA * 100);
    parts.push(`Predicted ${a}–${100 - a}.`);
  }

  return parts.join(' ') || 'Balances games played and wait time.';
}
