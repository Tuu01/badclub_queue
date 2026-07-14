// ============================================================
// tournament-live.test.ts — Phases 1-3 lifecycle on the in-memory mock:
// create → setup/finalize gate → schedule (+validation) → start clock →
// record (+auto-promote) → undo. Plus: the tournament path never writes
// club ratings/pairStats.
// Run:  npx tsx tests/tournament-live.test.ts
// ============================================================

import { createMemDb } from '../lib/repo-mem';
import {
  createTournament, saveTeams, finalizeTeams, endTournament, addSubstitution,
  scheduleGame, startClock, recordTournamentResult, undoTournamentResult,
  getTournamentView,
} from '../lib/tournament';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}
const CID = 'default';
const T = 1_000_000;

async function main() {
  const db = createMemDb();

  console.log('\n■ Phase 1 — create');
  const { tid, created } = await createTournament(db, { name: 'Autumn Cup', date: '2026-10-01', courtCount: 2 }, T);
  check('created DRAFT tournament', created === true);
  let v = (await getTournamentView(db, tid))!;
  check('status DRAFT, teams not finalized', v.tournament.status === 'DRAFT' && v.tournament.teamsFinalized === false);
  check('re-create is idempotent (created=false)', (await createTournament(db, { name: 'Autumn Cup', date: '2026-10-01', courtCount: 2 })).created === false);

  console.log('\n■ Phase 2 — setup + the gate');
  await saveTeams(db, tid, [
    { id: 't1', name: 'Team 1', playerIds: ['a1', 'a2'] },
    { id: 't2', name: 'Team 2', playerIds: ['b1', 'b2'] },
  ]);
  check('cannot schedule before finalize', await throws(() =>
    scheduleGame(db, tid, { round: 'RR', courtIdx: 0, teamA: 't1', teamB: 't2', pairA: ['a1', 'a2'], pairB: ['b1', 'b2'] })));
  await finalizeTeams(db, tid);
  v = (await getTournamentView(db, tid))!;
  check('finalize → LIVE + frozen', v.tournament.status === 'LIVE' && v.tournament.teamsFinalized === true);
  check('cannot redraw teams after finalize', await throws(() => saveTeams(db, tid, [])));

  console.log('\n■ Phase 3 — schedule + validation');
  check('validation: pair not on its team → throws', await throws(() =>
    scheduleGame(db, tid, { round: 'RR', courtIdx: 0, teamA: 't1', teamB: 't2', pairA: ['a1', 'b1'], pairB: ['b1', 'b2'] })));
  check('validation: same team twice → throws', await throws(() =>
    scheduleGame(db, tid, { round: 'RR', courtIdx: 0, teamA: 't1', teamB: 't1', pairA: ['a1', 'a2'], pairB: ['a1', 'a2'] })));

  const g1 = (await scheduleGame(db, tid, { round: 'RR', courtIdx: 0, teamA: 't1', teamB: 't2', pairA: ['a1', 'a2'], pairB: ['b1', 'b2'] })).gameId;
  const g2 = (await scheduleGame(db, tid, { round: 'RR', courtIdx: 0, teamA: 't1', teamB: 't2', pairA: ['a1', 'a2'], pairB: ['b1', 'b2'] })).gameId;
  const gameById = async (id: string) => (await getTournamentView(db, tid))!.games.find(g => g.id === id)!;
  check('first game on empty court → ONGOING (clock not started)', (await gameById(g1)).status === 'ONGOING' && (await gameById(g1)).startedAt === null);
  check('second game on busy court → SCHEDULED', (await gameById(g2)).status === 'SCHEDULED');

  console.log('\n■ start clock (the brake)');
  await startClock(db, tid, g1, T + 5000);
  check('start clock sets startedAt', (await gameById(g1)).startedAt === T + 5000);
  await startClock(db, tid, g1, T + 9999);
  check('start clock idempotent (no reset)', (await gameById(g1)).startedAt === T + 5000);

  console.log('\n■ record + AUTO-PROMOTE');
  const rec = await recordTournamentResult(db, tid, g1, { winner: 'A', scoreLoser: 17 }, T + 20000);
  check('g1 FINISHED with winner/score', (await gameById(g1)).status === 'FINISHED' && (await gameById(g1)).winner === 'A' && (await gameById(g1)).scoreLoser === 17);
  check('g2 auto-promoted to ONGOING, clock NOT started', (await gameById(g2)).status === 'ONGOING' && (await gameById(g2)).startedAt === null);
  check('record returned auditLogId + promotedGameId', !!rec.auditLogId && rec.promotedGameId === g2);
  check('record is idempotent', (await recordTournamentResult(db, tid, g1, { winner: 'B' }, T + 21000)).alreadyRecorded === true);

  console.log('\n■ undo (60s window)');
  const late = await undoTournamentResult(db, tid, rec.auditLogId!, T + 20000 + 61_000);
  check('undo after 60s refused', late.ok === false);
  const un = await undoTournamentResult(db, tid, rec.auditLogId!, T + 20000 + 5000);
  check('undo within 60s ok', un.ok === true);
  check('g1 restored to ONGOING', (await gameById(g1)).status === 'ONGOING' && (await gameById(g1)).winner === null);
  check('g2 demoted back to SCHEDULED', (await gameById(g2)).status === 'SCHEDULED');

  console.log('\n■ substitution — frozen team, logged swap');
  await addSubstitution(db, tid, 't1', { out: 'a2', in: 'a9' }, T + 30000);
  const t1 = (await getTournamentView(db, tid))!.tournament.teams.find(t => t.id === 't1')!;
  check('roster reflects the sub (a2 → a9)', t1.playerIds.includes('a9') && !t1.playerIds.includes('a2'));
  check('sub is logged', t1.substitutions?.length === 1 && t1.substitutions[0].out === 'a2' && t1.substitutions[0].in === 'a9');

  console.log('\n■ end tournament (LIVE → DONE)');
  await endTournament(db, tid);
  check('status DONE after end', (await getTournamentView(db, tid))!.tournament.status === 'DONE');
  await endTournament(db, tid);
  check('end is idempotent', (await getTournamentView(db, tid))!.tournament.status === 'DONE');

  console.log('\n■ ⛔ SEPARATION — no club skill written by any of this');
  check('no ratings doc created', !(await db.doc(`clubs/${CID}/private/ratings`).get()).exists);
  check('no pairStats doc created', !(await db.doc(`clubs/${CID}/meta/pairStats`).get()).exists);

  console.log(`\n${'─'.repeat(50)}\n  ${pass} pass · ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
