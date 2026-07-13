// ============================================================
// tests/firestore-uc5.test.ts — ONE integration test, real Firestore.
// Run: npx tsx tests/firestore-uc5.test.ts   (not part of `npm test`)
//
// WHY THIS ONE: everything else this session was verified by hand,
// once, against real Firestore, then thrown away. This is the one
// thing that stays — see USECASES.md PART 9, UC-5:
//
//   "the only thing in the app that can break in a way I can't see,
//    can't reproduce, and can't fix on Saturday morning."
//
// Two courts finish within seconds of each other and both suggestions
// overlap on the same person. assignCourt()'s whole reason for
// existing is that Firestore transactions make this impossible to get
// wrong — the losing transaction re-reads inside the same doc and
// sees the person already taken. This test proves that guarantee
// holds against the REAL database, not just by reading the code.
//
// NOT an emulator test — USECASES.md PART 7 asks for a Firestore
// emulator suite, but this project has no emulator wired up yet
// (firebase-tools isn't installed, and adding it needs a dependency
// decision + a Java runtime, both out of scope for this pass — ask
// before adding). This runs against the real project instead, using a
// throwaway session id that's created and deleted in the same run.
// tsx doesn't auto-load .env.local — load it before importing
// lib/firebase-admin (static imports get hoisted, so this has to be
// a dynamic import after the env is available).
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const CLUB_ID = 'default';
const TEST_SID = `_test-uc5-${Date.now()}`;

async function main() {
  loadEnvLocal();
  const { adminDb } = await import('../lib/firebase-admin');
  const { assignCourt, ConflictError } = await import('../lib/firestore');

  const playersSnap = await adminDb
    .collection(`clubs/${CLUB_ID}/players`)
    .where('active', '==', true)
    .limit(6)
    .get();
  if (playersSnap.size < 6) {
    throw new Error(`need >=6 active players in clubs/${CLUB_ID}/players to run this test, found ${playersSnap.size}`);
  }
  const [An, Binh, Cuong, Dung, Em, Phong] = playersSnap.docs.map(d => d.data() as {
    id: string; name: string; gender: 'M' | 'F'; div: 1 | 2;
  });

  const now = Date.now();
  const sessionPlayers: Record<string, unknown> = {};
  const attendance: Record<string, unknown> = {};
  for (const p of [An, Binh, Cuong, Dung, Em, Phong]) {
    sessionPlayers[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: 50, sigma: 8 };
    attendance[p.id] = { status: 'AVAILABLE', checkedInAt: now, leftAt: null, gamesToday: 0, freeAt: now };
  }

  await adminDb.doc(`sessions/${TEST_SID}`).set({
    id: TEST_SID, clubId: CLUB_ID, date: TEST_SID, courtCount: 2, targetHeadcount: 6,
    mode: 'RECORD', status: 'LIVE',
    players: sessionPlayers, attendance,
    courts: [
      { idx: 0, gameId: null, players: null, teamA: null, teamB: null, startedAt: null },
      { idx: 1, gameId: null, players: null, teamA: null, teamB: null, startedAt: null },
    ],
    startedAt: now, endedAt: null,
  });

  try {
    console.log('\n■ UC-5 — two courts finish within seconds, suggestions overlap on An & Binh');

    // 20:14:03 court 1 finishes → client A picks [An, Binh, Cuong, Dung]
    // 20:14:05 court 2 finishes → client B picks [An, Binh, Em, Phong]
    const settled = await Promise.allSettled([
      assignCourt(adminDb, TEST_SID, {
        courtIdx: 0,
        four: [An.id, Binh.id, Cuong.id, Dung.id],
        teamA: [An.id, Binh.id], teamB: [Cuong.id, Dung.id],
        predictedProbA: null, accepted: true, assignedByApp: false, actor: 'client-A',
      }),
      assignCourt(adminDb, TEST_SID, {
        courtIdx: 1,
        four: [An.id, Binh.id, Em.id, Phong.id],
        teamA: [An.id, Binh.id], teamB: [Em.id, Phong.id],
        predictedProbA: null, accepted: true, assignedByApp: false, actor: 'client-B',
      }),
    ]);

    const fulfilled = settled.filter(r => r.status === 'fulfilled');
    const rejected = settled.filter(r => r.status === 'rejected');
    check('exactly one fulfilled', fulfilled.length === 1, `→ ${fulfilled.length}`);
    check('exactly one rejected', rejected.length === 1, `→ ${rejected.length}`);
    if (rejected.length === 1) {
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      check('the rejection is a ConflictError (not some other failure)', reason instanceof ConflictError, `→ ${reason}`);
    }

    const doc = (await adminDb.doc(`sessions/${TEST_SID}`).get()).data() as {
      courts: Array<{ idx: number; players: string[] | null; gameId: string | null }>;
      attendance: Record<string, { status: string }>;
    };

    const playingCourts = doc.courts.filter(c => c.gameId !== null);
    check('exactly one court actually has a game on it', playingCourts.length === 1, `→ ${playingCourts.length}`);

    const anCourts = doc.courts.filter(c => c.players?.includes(An.id)).length;
    const binhCourts = doc.courts.filter(c => c.players?.includes(Binh.id)).length;
    check('An is on exactly one court, not two', anCourts === 1, `→ ${anCourts}`);
    check('Binh is on exactly one court, not two', binhCourts === 1, `→ ${binhCourts}`);
    check('An is PLAYING (not stuck AVAILABLE from the losing transaction)', doc.attendance[An.id].status === 'PLAYING');
    check('Binh is PLAYING', doc.attendance[Binh.id].status === 'PLAYING');

    // The losing four (whichever court didn't win) must have been left
    // untouched — still AVAILABLE, never locked by the transaction that
    // threw before writing.
    const loserFour = playingCourts[0]?.idx === 0 ? [Em.id, Phong.id] : [Cuong.id, Dung.id];
    const loserStillAvailable = loserFour.every(id => doc.attendance[id].status === 'AVAILABLE');
    check("the losing court's other two players are untouched (still AVAILABLE)", loserStillAvailable);
  } finally {
    for (const sub of ['games', 'audit']) {
      const subSnap = await adminDb.collection(`sessions/${TEST_SID}/${sub}`).get();
      for (const d of subSnap.docs) await d.ref.delete();
    }
    await adminDb.doc(`sessions/${TEST_SID}`).delete();
  }

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${pass} pass · ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('FAILED —', err instanceof Error ? err.message : err);
  process.exit(1);
});
