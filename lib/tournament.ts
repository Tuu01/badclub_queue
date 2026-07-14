// ============================================================
// tournament.ts — tournament writes + on-read views.
//
// ⛔ SEPARATION: everything here writes to `tournaments/{tid}` and its
// `games` subcollection. NOTHING here writes mu/sigma/gamesTotal/
// pairStats, and rebuildClubState() never reads `tournaments/*`. So a
// tournament cannot contaminate skill. See tournament-types.ts.
//
// Winrates are computed ON READ from the games — never denormalized,
// never recomputed on write. 33 games is instant; that's the point.
// ============================================================

import type { Db } from './repo';
import type { PlayerId } from './types';
import type { TournamentDoc, TournamentGame, TournamentTeam } from './tournament-types';
import { createPlayer, type PublicPlayerDoc } from './firestore';

// ---------- import input (the shape of vlong-clean.json) ----------
export interface ImportPlayer { name: string; vlongId?: string; div: 1 | 2; gender: 'M' | 'F'; bio?: string; }
export interface ImportTeam { id: string; name?: string; players: string[]; }
export interface ImportGame {
  teamA: string; teamB: string;               // team names ("Team 1") or ids ("t1")
  pairA: [string, string]; pairB: [string, string]; // player names
  winner: 'A' | 'B' | null; scoreLoser?: number | null;
  round?: string; note?: string; anomaly?: string;
}
export interface TournamentImportInput {
  players?: ImportPlayer[];
  tournament: { name: string; date: string; venue?: string; courtCount: number; teams: ImportTeam[]; };
  games: ImportGame[];
}

export interface ImportPreview {
  tournamentId: string;
  alreadyExists: boolean;
  playersToCreate: Array<{ name: string; div: 1 | 2; gender: 'M' | 'F' }>;
  playersMatched: string[];
  /** referenced in teams/games but not in the club NOR the file's players[] — STOP */
  unknownNames: string[];
  teamCount: number;
  gameCount: number;
  warnings: string[];
  wrote: boolean;
}

const norm = (s: string) => s.trim();
export function tournamentIdFor(name: string, date: string): string {
  const slug = norm(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug}-${norm(date)}`;
}

/**
 * Idempotent by (name, date): deterministic tournament id + deterministic
 * game ids, written with set(), so re-running overwrites the same docs
 * instead of duplicating. Players are matched by name (existing club
 * players are reused, never re-created).
 *
 * STOP-on-unknown: if any team/game name isn't in the club AND isn't in
 * the file's players[], nothing is written — the caller shows the list
 * and the admin decides. Never silently create or drop.
 */
export async function importTournament(
  db: Db,
  clubId: string,
  input: TournamentImportInput,
  opts: { dryRun: boolean },
  now = Date.now(),
): Promise<ImportPreview> {
  const warnings: string[] = [];
  const tid = tournamentIdFor(input.tournament.name, input.tournament.date);
  const alreadyExists = (await db.doc(`tournaments/${tid}`).get()).exists;

  // existing club players, by trimmed name
  const clubSnap = await db.collection(`clubs/${clubId}/players`).get();
  const nameToId = new Map<string, PlayerId>();
  for (const d of clubSnap.docs) {
    const p = d.data() as PublicPlayerDoc;
    nameToId.set(norm(p.name), p.id);
  }

  // file players: those not already in club → to create
  const filePlayers = input.players ?? [];
  const fileNames = new Set(filePlayers.map(p => norm(p.name)));
  const playersToCreate = filePlayers.filter(p => !nameToId.has(norm(p.name)));
  const playersMatched = filePlayers.filter(p => nameToId.has(norm(p.name))).map(p => p.name);

  // every name referenced by teams + games
  const referenced = new Set<string>();
  for (const t of input.tournament.teams) for (const n of t.players) referenced.add(norm(n));
  for (const g of input.games) for (const n of [...g.pairA, ...g.pairB]) referenced.add(norm(n));

  // unknown = referenced but neither in club nor in file players[]
  const unknownNames = [...referenced].filter(n => !nameToId.has(n) && !fileNames.has(n));

  const preview: ImportPreview = {
    tournamentId: tid, alreadyExists,
    playersToCreate: playersToCreate.map(p => ({ name: p.name, div: p.div, gender: p.gender })),
    playersMatched, unknownNames,
    teamCount: input.tournament.teams.length, gameCount: input.games.length,
    warnings, wrote: false,
  };

  // HARD STOP: unknown names, or dry run → return the preview, write nothing.
  if (unknownNames.length > 0) {
    warnings.push(`${unknownNames.length} name(s) not found in the club or the file — resolve before importing.`);
    return preview;
  }
  if (opts.dryRun) return preview;

  // ---- WRITE ----
  // 1. create the missing players (in file order → seedRank bottom-of-div,
  //    i.e. file order within a division; re-rank later). Reuse createPlayer.
  for (const p of playersToCreate) {
    const created = await createPlayer(db, clubId, { name: norm(p.name), gender: p.gender, div: p.div, bio: p.bio }, now);
    nameToId.set(norm(p.name), created.id);
  }

  const idOf = (name: string): PlayerId => {
    const id = nameToId.get(norm(name));
    if (!id) throw new Error(`unresolved player after create: ${name}`); // can't happen (unknown check above)
    return id;
  };

  // 2. teams — derive display name "Team {i+1}" if absent; map every alias → id
  const teams: TournamentTeam[] = input.tournament.teams.map((t, i) => ({
    id: t.id, name: t.name ?? `Team ${i + 1}`, playerIds: t.players.map(idOf),
  }));
  const teamAlias = new Map<string, string>();
  input.tournament.teams.forEach((t, i) => {
    teamAlias.set(norm(t.id), t.id);
    teamAlias.set(norm(t.name ?? `Team ${i + 1}`), t.id);
    teamAlias.set(`team ${i + 1}`, t.id);
  });
  const teamIdOf = (key: string): string => {
    const id = teamAlias.get(norm(key)) ?? teamAlias.get(norm(key).toLowerCase());
    if (!id) throw new Error(`unknown team ref: ${key}`);
    return id;
  };

  const tournamentDoc: TournamentDoc = {
    id: tid, name: norm(input.tournament.name), date: norm(input.tournament.date),
    ...(input.tournament.venue ? { venue: input.tournament.venue } : {}),
    courtCount: input.tournament.courtCount,
    teamsFinalized: true, teams, status: 'DONE', imported: true, createdAt: now,
  };

  const batch = db.batch();
  batch.set(db.doc(`tournaments/${tid}`), tournamentDoc as unknown as Record<string, unknown>);

  input.games.forEach((g, i) => {
    const gid = `g${String(i).padStart(3, '0')}`;
    const playerIds: [PlayerId, PlayerId, PlayerId, PlayerId] =
      [idOf(g.pairA[0]), idOf(g.pairA[1]), idOf(g.pairB[0]), idOf(g.pairB[1])];
    const game: TournamentGame = {
      id: gid, round: g.round ?? '',
      courtIdx: null,
      teamA: teamIdOf(g.teamA), teamB: teamIdOf(g.teamB),
      playerIds, winner: g.winner,
      scoreLoser: g.scoreLoser ?? null,
      startedAt: null, endedAt: null,
      status: g.winner == null ? 'SCHEDULED' : 'FINISHED',
      ...((g.note ?? g.anomaly) ? { note: g.note ?? g.anomaly } : {}),
    };
    batch.set(db.doc(`tournaments/${tid}/games/${gid}`), game as unknown as Record<string, unknown>);
  });
  await batch.commit();

  preview.wrote = true;
  return preview;
}

// ---------- ON-READ VIEWS (never denormalized) ----------

export interface PlayerRecord { playerId: PlayerId; wins: number; losses: number; }
export interface TeamRecord { teamId: string; wins: number; losses: number; }

export function winningPair(g: TournamentGame): [PlayerId, PlayerId] | null {
  if (g.winner == null) return null;
  return g.winner === 'A' ? [g.playerIds[0], g.playerIds[1]] : [g.playerIds[2], g.playerIds[3]];
}
export function losingPair(g: TournamentGame): [PlayerId, PlayerId] | null {
  if (g.winner == null) return null;
  return g.winner === 'A' ? [g.playerIds[2], g.playerIds[3]] : [g.playerIds[0], g.playerIds[1]];
}

export function computePlayerRecords(games: TournamentGame[]): Map<PlayerId, PlayerRecord> {
  const rec = new Map<PlayerId, PlayerRecord>();
  const bump = (id: PlayerId, w: boolean) => {
    const r = rec.get(id) ?? { playerId: id, wins: 0, losses: 0 };
    if (w) r.wins++; else r.losses++;
    rec.set(id, r);
  };
  for (const g of games) {
    const win = winningPair(g), lose = losingPair(g);
    if (!win || !lose) continue;
    win.forEach(id => bump(id, true));
    lose.forEach(id => bump(id, false));
  }
  return rec;
}

export function computeTeamRecords(t: TournamentDoc, games: TournamentGame[]): Map<string, TeamRecord> {
  const rec = new Map<string, TeamRecord>();
  for (const team of t.teams) rec.set(team.id, { teamId: team.id, wins: 0, losses: 0 });
  for (const g of games) {
    if (g.winner == null) continue;
    const winTeam = g.winner === 'A' ? g.teamA : g.teamB;
    const loseTeam = g.winner === 'A' ? g.teamB : g.teamA;
    const w = rec.get(winTeam); if (w) w.wins++;
    const l = rec.get(loseTeam); if (l) l.losses++;
  }
  return rec;
}

/** The champion team = most wins (ties → the earliest team in the list). */
export function championTeamId(t: TournamentDoc, games: TournamentGame[]): string | null {
  const recs = computeTeamRecords(t, games);
  let best: TeamRecord | null = null;
  for (const team of t.teams) {
    const r = recs.get(team.id)!;
    if (!best || r.wins > best.wins) best = r;
  }
  return best && best.wins > 0 ? best.teamId : null;
}

export interface TournamentView {
  tournament: TournamentDoc;
  games: TournamentGame[];
  teamRecords: TeamRecord[];
  playerRecords: PlayerRecord[];
  championTeamId: string | null;
}

export async function getTournamentView(db: Db, tid: string): Promise<TournamentView | null> {
  const tSnap = await db.doc(`tournaments/${tid}`).get();
  if (!tSnap.exists) return null;
  const tournament = tSnap.data() as unknown as TournamentDoc;
  const games = (await db.collection(`tournaments/${tid}/games`).get()).docs
    .map(d => d.data() as unknown as TournamentGame)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    tournament, games,
    teamRecords: t_recordsToArray(computeTeamRecords(tournament, games), tournament),
    playerRecords: [...computePlayerRecords(games).values()],
    championTeamId: championTeamId(tournament, games),
  };
}
function t_recordsToArray(m: Map<string, TeamRecord>, t: TournamentDoc): TeamRecord[] {
  return t.teams.map(team => m.get(team.id)!);
}

export interface TrophyLine {
  tournamentId: string; tournamentName: string; date: string;
  teamName: string; wins: number; losses: number; champion: boolean;
}

/** Every tournament a player took part in, newest first, with a champion flag. */
export async function getPlayerTrophies(db: Db, playerId: PlayerId): Promise<TrophyLine[]> {
  const tSnap = await db.collection('tournaments').get();
  const out: TrophyLine[] = [];
  for (const d of tSnap.docs) {
    const t = d.data() as unknown as TournamentDoc;
    const team = t.teams.find(tm => tm.playerIds.includes(playerId));
    if (!team) continue;
    const games = (await db.collection(`tournaments/${t.id}/games`).get()).docs
      .map(g => g.data() as unknown as TournamentGame);
    const rec = computeTeamRecords(t, games).get(team.id)!;
    const champ = championTeamId(t, games) === team.id;
    out.push({
      tournamentId: t.id, tournamentName: t.name, date: t.date,
      teamName: team.name, wins: rec.wins, losses: rec.losses, champion: champ,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}
