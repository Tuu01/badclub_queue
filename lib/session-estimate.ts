// ============================================================
// session-estimate.ts — estimate shown in /admin/session/new step 1.
//
// Assumption: a 120-minute session, ~20 minutes per game (PROMPT.md)
// → 6 games/court.
//
//   games/person   = (6 games/court × courts × 4 people/game) / total people
//                   = 24 × courts / people
//   % sitting out  = 1 − (actual playing time / time present)
//                   = 1 − 4 × courts / people
//
// Matches the example in PROMPT.md exactly: 3 courts, 22 people →
// 3.3 games/person, 45% sitting out.
// ============================================================

const SESSION_MINUTES = 120;
const GAME_MINUTES = 20;
const GAMES_PER_COURT = SESSION_MINUTES / GAME_MINUTES; // 6

export interface SessionEstimate {
  gamesPerPerson: number;
  sittingOutFraction: number;
  /** people present − courts×4. See FLOOR THRESHOLD warning in PROMPT.md. */
  pool: number;
  poolTooSmall: boolean;
}

export function estimateSession(courts: number, headcount: number): SessionEstimate | null {
  if (courts <= 0 || headcount <= 0) return null;
  const gamesPerPerson = (GAMES_PER_COURT * courts * 4) / headcount;
  const sittingOutFraction = 1 - (4 * courts) / headcount;
  const pool = headcount - courts * 4;
  return { gamesPerPerson, sittingOutFraction, pool, poolTooSmall: pool < 8 };
}

/** Minimum people present to stay above the floor threshold (courts×4 + 8). */
export function safeHeadcount(courts: number): number {
  return courts * 4 + 8;
}
