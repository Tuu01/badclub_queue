// ============================================================
// types.ts — The single source of truth for data shapes
// ============================================================

export type PlayerId = string;

// ---------- CLUB (changes every few months) ----------

export interface ClubPlayer {
  id: PlayerId;
  name: string;
  gender: 'M' | 'F';
  div: 1 | 2;

  /** Rank assigned by the admin WITHIN the div (1 = strongest). Used to seed rating. */
  seedRank: number;

  /** TrueSkill. Hidden from the player for at least 3 months. */
  mu: number;
  sigma: number;

  /** Total games played (across all sessions). Used to know whether rating has converged. */
  gamesTotal: number;

  /** The last session this person attended. Used to sort "who's been away longest". */
  lastPlayedAt: number | null; // epoch ms

  isGuest: boolean;
  active: boolean;
}

// ---------- PAIR HISTORY (across sessions, NO decay) ----------

export interface PairStats {
  /** key: pairKey(a, b) */
  [key: string]: {
    partnered: number;   // number of times PARTNERED
    opposed: number;     // number of times faced as opponents
    coPresent: number;   // number of sessions BOTH present  ← the normalization denominator
  };
}

/** Pair key, always sorted so (a,b) and (b,a) are the same. */
export function pairKey(a: PlayerId, b: PlayerId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------- SESSION ----------

export type AttendanceStatus =
  | 'AVAILABLE'   // present, ready to be assigned
  | 'PLAYING'     // currently on a court
  | 'PAUSED'      // present but temporarily not assignable (bathroom, break)
  | 'LEFT';       // gone home

export interface Attendance {
  playerId: PlayerId;
  status: AttendanceStatus;

  checkedInAt: number;    // epoch ms — IMPORTANT: this is the initial wait marker
  leftAt: number | null;

  /** Games played TONIGHT. Includes games logged in RECORD mode. */
  gamesToday: number;

  /**
   * The moment they last left a court (or checkedInAt if they haven't
   * played a game yet). waitTime = now - freeAt
   */
  freeAt: number;
}

// ---------- GAME ----------

export interface Game {
  id: string;
  sessionId: string;
  courtIndex: number;

  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];

  /** null = result not recorded yet (allowed — must not block assigning the next game) */
  winner: 'A' | 'B' | null;

  /** The LOSING team's score (0-29). Optional. Stored from day one even though unused so far. */
  scoreLoser: number | null;

  /** The app's prediction at assignment time. For measuring calibration later. */
  predictedProbA: number | null;

  /** Whether the app assigned this game itself, or a human split it. */
  assignedByApp: boolean;

  startedAt: number;
  endedAt: number | null;
  status: 'OK' | 'VOID';
}

// ---------- ALGORITHM CONFIG ----------

export interface MatchmakingConfig {
  /** Window: how many people to take from the front of the sorted queue. */
  windowSize: number;

  wRepeatPartner: number;
  wRepeatOpponent: number;
  wBalance: number;
  wWait: number;

  /** Waiting more than this many MINUTES → MUST be included in the next game. */
  starvationMinutes: number;

  /**
   * Keep matches in proper badminton categories. Penalty PER UNIT of gender
   * imbalance between the two teams: |womenA − womenB|. So Men's (2M v 2M),
   * Women's (2W v 2W) and Mixed (1M+1W v 1M+1W) all score 0; a team-with-a-woman
   * vs an all-men team scores 1×; 2W-vs-2M scores 2×. Soft, not a hard gate:
   * a starving player can still be force-included in a mismatched four.
   */
  wGenderMismatch: number;

  /** Only use W_BALANCE when all 4 people have sigma below this threshold. */
  balanceSigmaThreshold: number;

  /** Pick randomly among the top-N best options (prevents the queue from locking in). */
  topN: number;
}

export const DEFAULT_CONFIG: MatchmakingConfig = {
  windowSize: 8,
  wRepeatPartner: 48,
  wRepeatOpponent: 12,
  // BALANCE-FIRST (owner decision — even matches, not one-way games).
  // Balance is now always on (see matchmaking.ts) and weighted to LEAD
  // mixing: at 300, an uneven split is penalised more than a repeated
  // pairing, so the app picks the fairest four+split and uses mixing only
  // to break ties among similarly-even options. Was 36 (and gated off
  // until convergence) when mixing was the priority.
  wBalance: 300,
  wWait: 0.30,
  starvationMinutes: 25,
  wGenderMismatch: 150, // per unit of |womenA − womenB|; confirmed by sim sweep
  balanceSigmaThreshold: 6.0, // legacy/unused — balance no longer gated on sigma
  topN: 3,
};

// ---------- SUGGESTION RESULT ----------

export interface Suggestion {
  four: [PlayerId, PlayerId, PlayerId, PlayerId];
  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];
  predictedProbA: number;

  /** The reason sentence shown on screen. The single most important feature. */
  reason: string;

  /** For debugging / tuning the weights. */
  breakdown: {
    cost: number;
    repeatPartner: number;
    repeatOpponent: number;
    imbalance: number;
    waitSum: number;
    forced: PlayerId[];
  };
}
