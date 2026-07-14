// ============================================================
// rebuild.test.ts — rebuildClubState round-trips, run against the
// IN-MEMORY mock (repo-mem). Zero I/O, no credentials, real club never
// touched. This is the durable form of the STEP 2 throwaway-club check.
//
// It exercises the REAL rebuildClubState (and the mock's transaction /
// query semantics) — proving the dual-mode repo actually runs the
// production logic. Run:  npx tsx tests/rebuild.test.ts
// ============================================================

import { createMemDb } from '../lib/repo-mem';
import { rebuildClubState } from '../lib/firestore';
import { seedMu, SIGMA_INIT } from '../lib/rating';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const CID = 'default';
const P = [
  { id: 'p1', name: 'P1', gender: 'M', div: 1, seedRank: 1 },
  { id: 'p2', name: 'P2', gender: 'M', div: 1, seedRank: 2 },
  { id: 'p3', name: 'P3', gender: 'M', div: 2, seedRank: 1 },
  { id: 'p4', name: 'P4', gender: 'M', div: 2, seedRank: 2 },
];
const divSize: Record<number, number> = { 1: 2, 2: 2 };
const seedOf = (p: typeof P[number]) => seedMu(p.div as 1 | 2, p.seedRank, divSize[p.div]);

async function main() {
  const db = createMemDb();

  // seed players via the Db interface (same calls the app makes)
  const sessionPlayers: Record<string, unknown> = {};
  for (const p of P) {
    await db.doc(`clubs/${CID}/players/${p.id}`).set({
      ...p, gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true,
    });
    sessionPlayers[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: seedOf(p), sigma: SIGMA_INIT };
  }

  const makeSession = (sid: string, startedAt: number, status = 'DONE') =>
    db.doc(`sessions/${sid}`).set({
      id: sid, clubId: CID, date: sid, courtCount: 1, targetHeadcount: 4,
      mode: 'RECORD', status, players: sessionPlayers, attendance: {},
      courts: [], startedAt, endedAt: startedAt + 1000, firstTimePairs: [],
    });
  const makeGame = (sid: string, gid: string, teamA: string[], teamB: string[], winner: 'A' | 'B', startedAt: number) =>
    db.doc(`sessions/${sid}/games/${gid}`).set({
      id: gid, sessionId: sid, courtIndex: 0, teamA, teamB, winner,
      scoreLoser: null, predictedProbA: null, assignedByApp: true,
      startedAt, endedAt: startedAt + 500, status: 'OK',
    });
  const setStatus = (sid: string, status: string) => db.doc(`sessions/${sid}`).update({ status });
  const nonEmpty = (pairs: Record<string, { partnered: number; opposed: number }>) =>
    Object.values(pairs).some(v => v.partnered > 0 || v.opposed > 0);

  console.log('\n■ TEST A — record 3 → VOID → rebuild == seed (in-memory)');
  await makeSession('s1', 1000);
  await makeGame('s1', 'g1', ['p1', 'p2'], ['p3', 'p4'], 'A', 1100);
  await makeGame('s1', 'g2', ['p1', 'p3'], ['p2', 'p4'], 'B', 1200);
  await makeGame('s1', 'g3', ['p1', 'p4'], ['p2', 'p3'], 'A', 1300);

  const withGames = await rebuildClubState(db, CID, { dryRun: false });
  check('replayed 3 games', withGames.replayedGames === 3, `→ ${withGames.replayedGames}`);
  check('ratings moved off seed', P.some(p => !eq(withGames.ratings[p.id].mu, seedOf(p))));
  check('pairStats non-empty after games', nonEmpty(withGames.pairs));

  await setStatus('s1', 'VOID');
  const voided = await rebuildClubState(db, CID, { dryRun: false });
  check('replayed 0 games after VOID', voided.replayedGames === 0, `→ ${voided.replayedGames}`);
  check('every mu/sigma byte-identical to seed',
    P.every(p => eq(voided.ratings[p.id].mu, seedOf(p)) && eq(voided.ratings[p.id].sigma, SIGMA_INIT)));
  check('gamesTotal all 0', P.every(p => (voided.gamesTotal[p.id] ?? 0) === 0));
  check('pairStats empty', !nonEmpty(voided.pairs));

  console.log('\n■ TEST B — VOID only 2nd session → session 1 survives intact');
  await setStatus('s1', 'DONE');
  await makeSession('s2', 2000);
  await makeGame('s2', 'g4', ['p1', 'p2'], ['p3', 'p4'], 'B', 2100);
  await makeGame('s2', 'g5', ['p2', 'p3'], ['p1', 'p4'], 'A', 2200);

  const both = await rebuildClubState(db, CID, { dryRun: false });
  check('replayed 5 games (3+2)', both.replayedGames === 5, `→ ${both.replayedGames}`);

  await setStatus('s2', 'VOID');
  const s1only = await rebuildClubState(db, CID, { dryRun: false });
  check('replayed 3 games (only session 1)', s1only.replayedGames === 3, `→ ${s1only.replayedGames}`);
  check("session 1's effects survive intact",
    P.every(p =>
      eq(s1only.ratings[p.id].mu, withGames.ratings[p.id].mu) &&
      eq(s1only.ratings[p.id].sigma, withGames.ratings[p.id].sigma) &&
      (s1only.gamesTotal[p.id] ?? 0) === (withGames.gamesTotal[p.id] ?? 0)));

  console.log(`\n${'─'.repeat(50)}\n  ${pass} pass · ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
