// ============================================================
// tournament.test.ts — import + on-read views, on the in-memory mock.
// The load-bearing assertion is STRUCTURAL SEPARATION: importing a whole
// tournament (players + teams + games) must leave every club rating at
// SEED and pairStats EMPTY. Tournaments measure glory, not skill.
// Run:  npx tsx tests/tournament.test.ts
// ============================================================

import { createMemDb } from '../lib/repo-mem';
import { importTournament, getTournamentView, getPlayerTrophies } from '../lib/tournament';
import { seedMu, SIGMA_INIT } from '../lib/rating';
import type { TournamentImportInput } from '../lib/tournament';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const CID = 'default';

const input: TournamentImportInput = {
  players: [
    { name: 'A', div: 1, gender: 'M', bio: 'raw bío' },
    { name: 'B', div: 1, gender: 'F' },
    { name: 'C', div: 2, gender: 'M' },
    { name: 'D', div: 2, gender: 'F' },
  ],
  tournament: {
    name: 'Test Cup 2026', date: '2026-01-01', venue: 'Hall', courtCount: 2,
    teams: [{ id: 't1', players: ['A', 'B'] }, { id: 't2', players: ['C', 'D'] }],
  },
  games: [
    { teamA: 'Team 1', teamB: 'Team 2', pairA: ['A', 'B'], pairB: ['C', 'D'], winner: 'A', scoreLoser: 15 },
    { teamA: 'Team 1', teamB: 'Team 2', pairA: ['A', 'B'], pairB: ['C', 'D'], winner: 'A', scoreLoser: 19 },
    { teamA: 'Team 1', teamB: 'Team 2', pairA: ['A', 'B'], pairB: ['C', 'D'], winner: 'B', scoreLoser: 20, anomaly: 'winner scored 20' },
  ],
};

async function ratingsOf(db: ReturnType<typeof createMemDb>) {
  return ((await db.doc(`clubs/${CID}/private/ratings`).get()).data() as { ratings: Record<string, { mu: number; sigma: number }> } | undefined)?.ratings ?? {};
}
async function clubPlayers(db: ReturnType<typeof createMemDb>) {
  return (await db.collection(`clubs/${CID}/players`).get()).docs.map(d => d.data() as { id: string; name: string; div: 1 | 2; seedRank: number; gamesTotal: number; bio?: string });
}

async function main() {
  const db = createMemDb();

  console.log('\n■ dry run writes nothing');
  const dry = await importTournament(db, CID, input, { dryRun: true });
  check('preview: 4 players to create', dry.playersToCreate.length === 4);
  check('preview: no unknown names', dry.unknownNames.length === 0);
  check('preview: 1 tournament, 3 games', dry.teamCount === 2 && dry.gameCount === 3);
  check('dry run wrote=false', dry.wrote === false);
  check('dry run created NO tournament doc', !(await db.doc(`tournaments/${dry.tournamentId}`).get()).exists);
  check('dry run created NO players', (await clubPlayers(db)).length === 0);

  console.log('\n■ real import');
  const res = await importTournament(db, CID, input, { dryRun: false });
  check('wrote=true', res.wrote === true);
  const players = await clubPlayers(db);
  check('created 4 players', players.length === 4);
  check('bio stored as-is', players.find(p => p.name === 'A')?.bio === 'raw bío');
  const tv = await getTournamentView(db, res.tournamentId);
  check('tournament view exists', tv !== null);
  check('3 games stored', tv!.games.length === 3);
  check('imported flag set', tv!.tournament.imported === true && tv!.tournament.teamsFinalized === true);
  check('anomaly note preserved', tv!.games.some(g => g.note?.includes('20')));
  check('game maps team names → ids', tv!.games[0].teamA === 't1' && tv!.games[0].teamB === 't2');

  console.log('\n■ ⛔ STRUCTURAL SEPARATION — skill untouched');
  const ratings = await ratingsOf(db);
  const byName = new Map(players.map(p => [p.name, p]));
  const seedOk = players.every(p => {
    const divSize = players.filter(q => q.div === p.div).length;
    return eq(ratings[p.id].mu, seedMu(p.div, p.seedRank, divSize)) && eq(ratings[p.id].sigma, SIGMA_INIT);
  });
  check('every rating still at SEED (mu = seedMu, σ = 8)', seedOk);
  check('every gamesTotal still 0', players.every(p => p.gamesTotal === 0));
  check('pairStats doc NEVER created by a tournament', !(await db.doc(`clubs/${CID}/meta/pairStats`).get()).exists);

  console.log('\n■ on-read winrate + champion');
  check('team records: t1 2-1, t2 1-2',
    tv!.teamRecords.find(r => r.teamId === 't1')?.wins === 2 &&
    tv!.teamRecords.find(r => r.teamId === 't2')?.wins === 1);
  check('champion = t1 (most wins)', tv!.championTeamId === 't1');
  const aId = byName.get('A')!.id;
  const aRec = tv!.playerRecords.find(r => r.playerId === aId)!;
  check('player A record 2-1', aRec.wins === 2 && aRec.losses === 1);
  const trophies = await getPlayerTrophies(db, aId);
  check('A has a champion trophy line', trophies.length === 1 && trophies[0].champion === true);
  const cId = byName.get('C')!.id;
  check('C (losing team) has a NON-champion line', (await getPlayerTrophies(db, cId))[0].champion === false);

  console.log('\n■ idempotency (name+date) — re-run must not duplicate');
  const again = await importTournament(db, CID, input, { dryRun: false });
  check('same tournament id', again.tournamentId === res.tournamentId && again.alreadyExists === true);
  check('still 4 players (no dup)', (await clubPlayers(db)).length === 4);
  check('still 3 games (no dup)', (await getTournamentView(db, res.tournamentId))!.games.length === 3);

  console.log('\n■ unknown name → HARD STOP');
  const bad: TournamentImportInput = {
    ...input,
    games: [...input.games, { teamA: 'Team 1', teamB: 'Team 2', pairA: ['A', 'Zzz'], pairB: ['C', 'D'], winner: 'A', scoreLoser: 1 }],
  };
  const badRes = await importTournament(db, CID, bad, { dryRun: false });
  check('unknown "Zzz" reported', badRes.unknownNames.includes('Zzz'));
  check('nothing written on unknown (wrote=false)', badRes.wrote === false);

  console.log(`\n${'─'.repeat(50)}\n  ${pass} pass · ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
