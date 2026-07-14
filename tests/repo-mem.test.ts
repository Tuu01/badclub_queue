// ============================================================
// repo-mem.test.ts — proves the in-memory Db is faithful to the
// Firestore semantics lib/firestore.ts relies on. The transaction
// commit/rollback cases matter most: they're what let heavy functions
// (recordResult, assignCourt) run truthfully on the mock.
// Run:  npx tsx tests/repo-mem.test.ts
// ============================================================

import { createMemDb } from '../lib/repo-mem';
import { setMode } from '../lib/firestore';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

async function main() {
  const db = createMemDb();

  console.log('\n■ document basics');
  await db.doc('c/a').set({ x: 1, y: 'hi' });
  let s = await db.doc('c/a').get();
  check('set + get', s.exists && s.data()!.x === 1 && s.data()!.y === 'hi');
  check('id from path', s.id === 'a');
  await db.doc('c/a').update({ x: 2 });
  s = await db.doc('c/a').get();
  check('update shallow-merges', s.data()!.x === 2 && s.data()!.y === 'hi');
  check('missing doc → exists false', !(await db.doc('c/nope').get()).exists);
  let threw = false;
  try { await db.doc('c/ghost').update({ z: 1 }); } catch { threw = true; }
  check('update on missing THROWS (Firestore NOT_FOUND)', threw);
  await db.doc('c/a').delete();
  check('delete', !(await db.doc('c/a').get()).exists);

  console.log('\n■ collections & queries');
  await db.doc('sessions/s1').set({ status: 'LIVE' });
  await db.doc('sessions/s2').set({ status: 'DONE' });
  await db.doc('sessions/s1/games/g1').set({ n: 1 }); // nested — must NOT appear under `sessions`
  const all = await db.collection('sessions').get();
  check('collection.get() returns direct children only', all.size === 2 && all.docs.every(d => d.id === 's1' || d.id === 's2'));
  const live = await db.collection('sessions').where('status', '==', 'LIVE').get();
  check('where() filters', live.size === 1 && live.docs[0].id === 's1');
  const auto = db.collection('sessions').doc();
  check('collection.doc() auto-id is unique & pathed', auto.id.startsWith('auto_') && auto.id.length > 5);

  console.log('\n■ batch');
  const b = db.batch();
  b.set(db.doc('c/b1'), { v: 1 });
  b.set(db.doc('c/b2'), { v: 2 });
  check('batch not applied before commit', !(await db.doc('c/b1').get()).exists);
  await b.commit();
  check('batch applied on commit', (await db.doc('c/b1').get()).exists && (await db.doc('c/b2').get()).exists);

  console.log('\n■ transactions — commit & ROLLBACK');
  await db.runTransaction(async tx => {
    tx.set(db.doc('c/t1'), { v: 10 });
    tx.update(db.doc('c/b1'), { v: 99 });
  });
  check('tx commit persists set', (await db.doc('c/t1').get()).data()!.v === 10);
  check('tx commit persists update', (await db.doc('c/b1').get()).data()!.v === 99);

  let rolledBack = false;
  try {
    await db.runTransaction(async tx => {
      tx.set(db.doc('c/t2'), { v: 1 });   // should NOT persist
      throw new Error('boom');
    });
  } catch { rolledBack = true; }
  check('throwing tx rejects', rolledBack);
  check('throwing tx wrote NOTHING (rollback)', !(await db.doc('c/t2').get()).exists);

  // tx reads see committed state
  const readVal = await db.runTransaction(async tx => (await tx.get(db.doc('c/t1'))).data()!.v);
  check('tx.get reads committed state', readVal === 10);

  console.log('\n■ a REAL transactional function on the mock (setMode)');
  await db.doc('sessions/live').set({ id: 'live', status: 'LIVE', mode: 'RECORD' });
  await setMode(db, 'live', 'ASSIGN');
  check('setMode committed through the mock tx', (await db.doc('sessions/live').get()).data()!.mode === 'ASSIGN');

  console.log(`\n${'─'.repeat(50)}\n  ${pass} pass · ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
