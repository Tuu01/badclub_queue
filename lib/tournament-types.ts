// ============================================================
// tournament-types.ts — the tournament data model.
//
// ⛔ PHYSICALLY SEPARATE FROM THE CLUB. Tournament data lives in the
// top-level `tournaments/{tid}` collection and its `games` subcollection
// — NOT under sessions/*. rebuildClubState() reads `sessions` only, so
// it is STRUCTURALLY IMPOSSIBLE for a tournament game to touch mu /
// sigma / gamesTotal / pairStats / coPresent. Same trick as guests
// (guests aren't in clubs/players, so the boards can't see them).
//
// Why tournaments are quarantined: fixed teams (can't separate Tuan from
// Lan), bracket selection (winners play winners — TrueSkill assumes
// near-random matching), unequal samples (a round-1 loser plays 1 game,
// a finalist 5). It is the dirtiest data we collect. Sessions measure
// SKILL; tournaments measure GLORY. Never mix them.
// ============================================================

import type { PlayerId } from './types';

export type TournamentId = string;
export type TeamId = string;

export interface TournamentTeam {
  id: TeamId;
  name: string;
  playerIds: PlayerId[];
  /** UC-1-style: the team stays FROZEN; a no-show is RECORDED here, not
   *  fixed by reopening the team. Logged, never destructive. */
  substitutions?: Array<{ out: PlayerId; in: PlayerId; at: number }>;
}

export interface TournamentDoc {
  id: TournamentId;
  name: string;
  date: string;            // "2026-07-04"
  venue?: string;
  courtCount: number;      // 1–6
  /** THE GATE. Until true, the setup screen is the only reachable screen. */
  teamsFinalized: boolean;
  teams: TournamentTeam[];
  status: 'DRAFT' | 'LIVE' | 'DONE';
  /** true for historical data brought in via /admin/tournament/import. */
  imported: boolean;
  createdAt: number;
}

export interface TournamentGame {
  id: string;
  /** free text — "QF", "SF", "F", "RR-1". The admin's call. */
  round: string;
  courtIdx: number | null;
  teamA: TeamId;
  teamB: TeamId;
  /** denormalized [a1, a2, b1, b2] so per-player winrate is one read. */
  playerIds: [PlayerId, PlayerId, PlayerId, PlayerId];
  winner: 'A' | 'B' | null;
  /** losing team's score. null allowed — old records are incomplete. */
  scoreLoser: number | null;
  startedAt: number | null;
  endedAt: number | null;
  status: 'SCHEDULED' | 'ONGOING' | 'FINISHED';
  /** free-text flag for data anomalies (e.g. "winner scored 20, <21"). */
  note?: string;
}
