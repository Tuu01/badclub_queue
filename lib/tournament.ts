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

import type { Db, DocumentData } from './repo';
import type { PlayerId } from './types';
import type { TournamentDoc, TournamentGame, TournamentTeam } from './tournament-types';
import { createPlayer, type PublicPlayerDoc } from './firestore';

// typed docs → the loose DocumentData that set()/update() accept.
const doc = (o: object): DocumentData => o as DocumentData;

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

export interface ChampionShowcase {
  tournamentId: string;
  tournamentName: string;
  date: string;
  teamName: string;
  memberIds: PlayerId[];
}

/** The champion of the most recent COMPLETED (DONE) tournament — for the
 *  glory showcase on /board. Computed on read; null if none finished. A
 *  LIVE tournament isn't "won" yet, so it's deliberately excluded. */
export async function getLatestChampion(db: Db): Promise<ChampionShowcase | null> {
  const done = (await listTournaments(db)).filter(t => t.status === 'DONE'); // newest first
  for (const t of done) {
    const games = (await db.collection(`tournaments/${t.id}/games`).get()).docs
      .map(d => d.data() as unknown as TournamentGame);
    const champId = championTeamId(t, games);
    if (!champId) continue;
    const team = t.teams.find(tm => tm.id === champId)!;
    return { tournamentId: t.id, tournamentName: t.name, date: t.date, teamName: team.name, memberIds: team.playerIds };
  }
  return null;
}

// ============================================================
// LIVE LIFECYCLE — Phases 1-3 (create → setup/finalize → run).
//
// REUSED from the session engine's spirit: idempotency guards, a 60s
// undo backed by an audit log. NOT reused: suggestMatch, buildQueue,
// mode, starvation — meaningless when teams are fixed and the bracket is
// on paper. And, as everywhere in this file, ZERO rating/pairStats.
// ============================================================

// ---------- PHASE 1 · CREATE ----------
export async function createTournament(
  db: Db, args: { name: string; date: string; venue?: string; courtCount: number }, now = Date.now(),
): Promise<{ tid: string; created: boolean }> {
  const tid = tournamentIdFor(args.name, args.date);
  const ref = db.doc(`tournaments/${tid}`);
  if ((await ref.get()).exists) return { tid, created: false };
  const t: TournamentDoc = {
    id: tid, name: norm(args.name), date: norm(args.date),
    ...(args.venue ? { venue: args.venue } : {}),
    courtCount: args.courtCount, teamsFinalized: false, teams: [],
    status: 'DRAFT', imported: false, createdAt: now,
  };
  await ref.set(doc(t));
  return { tid, created: true };
}

export async function listTournaments(db: Db): Promise<TournamentDoc[]> {
  return (await db.collection('tournaments').get()).docs
    .map(d => d.data() as unknown as TournamentDoc)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** ADMIN — delete a tournament and its games + audit subcollections
 *  (Firestore doesn't cascade). Same shape as deleteSession. Never
 *  touches the club — tournament data is separate. */
export async function deleteTournament(db: Db, tid: string): Promise<void> {
  const [games, audit] = await Promise.all([
    db.collection(`tournaments/${tid}/games`).get(),
    db.collection(`tournaments/${tid}/audit`).get(),
  ]);
  const batch = db.batch();
  for (const d of games.docs) batch.delete(d.ref);
  for (const d of audit.docs) batch.delete(d.ref);
  batch.delete(db.doc(`tournaments/${tid}`));
  await batch.commit();
}

// ---------- PHASE 2 · SETUP TEAMS (the gate) ----------
/** Data entry only — the admin draws on paper; the app just stores it.
 *  Refused once finalized (frozen). */
export async function saveTeams(db: Db, tid: string, teams: TournamentTeam[]): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = db.doc(`tournaments/${tid}`);
    const t = (await tx.get(ref)).data() as unknown as TournamentDoc | undefined;
    if (!t) throw new Error('tournament not found');
    if (t.teamsFinalized) throw new Error('teams are finalized — they cannot be redrawn');
    tx.update(ref, doc({ teams }));
  });
}

/** THE ONE-WAY GATE. teamsFinalized = true, status → LIVE. */
export async function finalizeTeams(db: Db, tid: string): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = db.doc(`tournaments/${tid}`);
    const t = (await tx.get(ref)).data() as unknown as TournamentDoc | undefined;
    if (!t) throw new Error('tournament not found');
    if (t.teamsFinalized) return; // idempotent
    if (t.teams.length < 2 || t.teams.some(tm => tm.playerIds.length < 2)) {
      throw new Error('need at least 2 teams of at least 2 players');
    }
    tx.update(ref, doc({ teamsFinalized: true, status: 'LIVE' }));
  });
}

/** LIVE → DONE. Crowns the champion (the winner is then computed on read)
 *  and makes it eligible for the /board showcase. Idempotent. */
export async function endTournament(db: Db, tid: string): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = db.doc(`tournaments/${tid}`);
    const t = (await tx.get(ref)).data() as unknown as TournamentDoc | undefined;
    if (!t) throw new Error('tournament not found');
    if (t.status === 'DONE') return; // idempotent
    tx.update(ref, doc({ status: 'DONE' }));
  });
}

/** A no-show, RECORDED not commanded (UC-1). Team stays frozen; the swap
 *  is logged AND the effective roster reflects who actually plays. */
export async function addSubstitution(
  db: Db, tid: string, teamId: string, sub: { out: PlayerId; in: PlayerId }, now = Date.now(),
): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = db.doc(`tournaments/${tid}`);
    const t = (await tx.get(ref)).data() as unknown as TournamentDoc | undefined;
    if (!t) throw new Error('tournament not found');
    if (!t.teamsFinalized) throw new Error('finalize teams before substituting');
    const teams = t.teams.map(tm => {
      if (tm.id !== teamId) return tm;
      if (!tm.playerIds.includes(sub.out)) throw new Error('the outgoing player is not on that team');
      return {
        ...tm,
        playerIds: tm.playerIds.map(id => (id === sub.out ? sub.in : id)),
        substitutions: [...(tm.substitutions ?? []), { out: sub.out, in: sub.in, at: now }],
      };
    });
    tx.update(ref, doc({ teams }));
  });
}

// ---------- PHASE 3 · RUN MATCHES ----------
/** earliest SCHEDULED game id on a court, or null if the court already
 *  has an ONGOING game. Deterministic (id order). */
function nextOnCourt(games: TournamentGame[], courtIdx: number | null): string | null {
  if (courtIdx == null) return null; // a game with no court can't auto-promote
  const onCourt = games.filter(g => g.courtIdx === courtIdx);
  if (onCourt.some(g => g.status === 'ONGOING')) return null;
  return onCourt.filter(g => g.status === 'SCHEDULED').sort((a, b) => a.id.localeCompare(b.id))[0]?.id ?? null;
}

/** Queue a match. Validation is the whole point: p1+p2 on teamA, p3+p4
 *  on teamB, and the teams differ. Lands ONGOING (clock not started) if
 *  the court is empty, else SCHEDULED behind the queue. */
export async function scheduleGame(
  db: Db, tid: string,
  args: { round: string; courtIdx: number; teamA: string; teamB: string; pairA: [PlayerId, PlayerId]; pairB: [PlayerId, PlayerId] },
): Promise<{ gameId: string }> {
  return db.runTransaction(async tx => {
    const t = (await tx.get(db.doc(`tournaments/${tid}`))).data() as unknown as TournamentDoc | undefined;
    if (!t) throw new Error('tournament not found');
    if (!t.teamsFinalized) throw new Error('finalize teams first');
    const teamA = t.teams.find(x => x.id === args.teamA);
    const teamB = t.teams.find(x => x.id === args.teamB);
    if (!teamA || !teamB) throw new Error('unknown team');
    if (teamA.id === teamB.id) throw new Error('a game needs two different teams');
    if (!args.pairA.every(p => teamA.playerIds.includes(p))) throw new Error('pairA are not both on team A');
    if (!args.pairB.every(p => teamB.playerIds.includes(p))) throw new Error('pairB are not both on team B');

    const gamesCol = db.collection(`tournaments/${tid}/games`);
    const games = (await tx.get(gamesCol)).docs.map(d => d.data() as unknown as TournamentGame);
    const courtBusy = games.some(g => g.courtIdx === args.courtIdx && (g.status === 'ONGOING' || g.status === 'SCHEDULED'));
    const gRef = gamesCol.doc();
    const game: TournamentGame = {
      id: gRef.id, round: args.round, courtIdx: args.courtIdx,
      teamA: args.teamA, teamB: args.teamB,
      playerIds: [args.pairA[0], args.pairA[1], args.pairB[0], args.pairB[1]],
      winner: null, scoreLoser: null, startedAt: null, endedAt: null,
      status: courtBusy ? 'SCHEDULED' : 'ONGOING', // empty court → on court, clock not started
    };
    tx.set(gRef, doc(game));
    return { gameId: gRef.id };
  });
}

/** The BRAKE: auto-promotion puts a match ON the court (ONGOING); a human
 *  taps this to start the clock, once the four people are actually there. */
export async function startClock(db: Db, tid: string, gid: string, now = Date.now()): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = db.doc(`tournaments/${tid}/games/${gid}`);
    const g = (await tx.get(ref)).data() as unknown as TournamentGame | undefined;
    if (!g) throw new Error('game not found');
    if (g.status !== 'ONGOING') throw new Error('game is not on court');
    if (g.startedAt != null) return; // idempotent
    tx.update(ref, doc({ startedAt: now }));
  });
}

/** Record the winner → FINISHED, then AUTO-PROMOTE the next scheduled game
 *  on that court to ONGOING (clock NOT started). Idempotent; audited for
 *  the 60s undo. NO rating, NO pairStats — this is the quarantine. */
export async function recordTournamentResult(
  db: Db, tid: string, gid: string,
  args: { winner: 'A' | 'B'; scoreLoser?: number | null; actor?: string }, now = Date.now(),
): Promise<{ alreadyRecorded: boolean; auditLogId: string | null; promotedGameId: string | null }> {
  return db.runTransaction(async tx => {
    const gRef = db.doc(`tournaments/${tid}/games/${gid}`);
    const gamesCol = db.collection(`tournaments/${tid}/games`);
    const gSnap = await tx.get(gRef);
    const g = gSnap.data() as unknown as TournamentGame | undefined;
    if (!g) throw new Error('game not found');
    if (g.status === 'FINISHED') return { alreadyRecorded: true, auditLogId: null, promotedGameId: null };

    const others = (await tx.get(gamesCol)).docs
      .map(d => d.data() as unknown as TournamentGame)
      .filter(x => x.id !== gid);
    const promotedGameId = nextOnCourt(others, g.courtIdx);

    const aRef = db.collection(`tournaments/${tid}/audit`).doc();
    tx.update(gRef, doc({ winner: args.winner, scoreLoser: args.scoreLoser ?? null, endedAt: now, status: 'FINISHED' }));
    if (promotedGameId) tx.update(db.doc(`tournaments/${tid}/games/${promotedGameId}`), doc({ status: 'ONGOING' }));
    tx.set(aRef, doc({
      gameId: gid,
      before: { winner: g.winner, scoreLoser: g.scoreLoser, endedAt: g.endedAt, status: g.status },
      promotedGameId: promotedGameId ?? null, at: now, actor: args.actor ?? null,
    }));
    return { alreadyRecorded: false, auditLogId: aRef.id, promotedGameId };
  });
}

/** Undo a just-recorded result within 60s: restore the game, and demote
 *  the auto-promoted next game back to SCHEDULED (only if not yet started). */
export async function undoTournamentResult(
  db: Db, tid: string, auditLogId: string, now = Date.now(), windowMs = 60_000,
): Promise<{ ok: boolean; error?: string }> {
  return db.runTransaction(async tx => {
    const aRef = db.doc(`tournaments/${tid}/audit/${auditLogId}`);
    const a = (await tx.get(aRef)).data() as
      | { gameId: string; before: Partial<TournamentGame>; promotedGameId: string | null; at: number } | undefined;
    if (!a) return { ok: false, error: 'nothing to undo' };
    if (now - a.at > windowMs) return { ok: false, error: 'more than 60 seconds ago — can no longer be undone' };

    const promoted = a.promotedGameId
      ? (await tx.get(db.doc(`tournaments/${tid}/games/${a.promotedGameId}`))).data() as unknown as TournamentGame | undefined
      : undefined;

    tx.update(db.doc(`tournaments/${tid}/games/${a.gameId}`), doc({
      winner: a.before.winner ?? null, scoreLoser: a.before.scoreLoser ?? null,
      endedAt: a.before.endedAt ?? null, status: a.before.status ?? 'ONGOING',
    }));
    if (a.promotedGameId && promoted && promoted.status === 'ONGOING' && promoted.startedAt == null) {
      tx.update(db.doc(`tournaments/${tid}/games/${a.promotedGameId}`), doc({ status: 'SCHEDULED' }));
    }
    tx.delete(aRef);
    return { ok: true };
  });
}
