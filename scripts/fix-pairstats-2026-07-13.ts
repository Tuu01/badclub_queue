// ============================================================
// scripts/fix-pairstats-2026-07-13.ts — one-off manual correction.
// Run: npx tsx scripts/fix-pairstats-2026-07-13.ts
//
// WHY:
//
// While verifying the UC-1 (swap-on-live-court) fix against real
// Firestore, the FIRST test run reproduced the exact bug it was
// designed to catch: swapPlayerOnCourt() patched session.courts[idx]
// but not the separate games/{gameId} document, which recordResult()
// actually reads. That run's recordResult() call therefore credited
// the swapped-OUT player (Test 1) instead of the swapped-IN player
// (Test 7) as Test 13's partner — and permanently wrote that false
// "partnered" fact into the real clubs/default/meta/pairStats doc.
// Test 1 and Test 13 never partnered. Test 7 did.
//
// coPresent on this pair is left untouched — that count is legitimate
// history from real earlier check-ins this session, unrelated to the
// bug.
//
// There is no rebuildClubState() to recompute this from the game
// log (see USECASES.md UC-2 — this is that gap, hit for real). So it
// is corrected by hand, once, here — committed rather than done at
// the console, so anyone auditing pairStats later can find exactly
// what was touched, when, and why (see the MANUAL_CORRECTION audit
// log entry this script writes).
//
// DO NOT re-run this script — it is dated and specific to this one
// incident. Decrementing an already-corrected counter a second time
// would itself be the same kind of silent corruption this fixes.
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Transaction } from 'firebase-admin/firestore';

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

// Test 1, Test 13 — the two real fixture players the bad recordResult()
// call actually touched.
const CONTAMINATED_PAIR: [string, string] = ['6pfer74BEinlqeXi7YQH', '6ldQ3hCjxdmlNpRrsxWe'];

async function main() {
  loadEnvLocal();
  const { adminDb } = await import('../lib/firebase-admin');
  const { pairKey } = await import('../lib/types');
  const { CLUB_ID } = await import('../lib/constants');

  const ref = adminDb.doc(`clubs/${CLUB_ID}/meta/pairStats`);
  const auditRef = adminDb.collection(`clubs/${CLUB_ID}/audit`).doc();
  const key = pairKey(CONTAMINATED_PAIR[0], CONTAMINATED_PAIR[1]);
  const now = Date.now();

  await adminDb.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(ref);
    const pairs = snap.data()?.pairs ?? {};
    const before = pairs[key];
    if (!before) {
      throw new Error(`no pairStats entry found for key ${key} — nothing to fix, stop and check by hand`);
    }
    if (before.partnered < 1) {
      throw new Error(`partnered is already ${before.partnered} for ${key} — decrementing would go negative, stop`);
    }

    const after = { ...before, partnered: before.partnered - 1 };
    console.log('key:   ', key);
    console.log('before:', JSON.stringify(before));
    console.log('after: ', JSON.stringify(after));

    tx.set(ref, { pairs: { ...pairs, [key]: after }, updatedAt: now });
    tx.set(auditRef, {
      at: now,
      actor: 'scripts/fix-pairstats-2026-07-13.ts',
      action: 'MANUAL_CORRECTION',
      payload: {
        target: `clubs/${CLUB_ID}/meta/pairStats`,
        pairKey: key,
        field: 'partnered',
        before: before.partnered,
        after: after.partnered,
        reason:
          'During development, a first (pre-fix) test run of swapPlayerOnCourt() ' +
          'reproduced a real bug: the swap updated session.courts[idx] but not the ' +
          'separate games/{gameId} document, which recordResult() actually reads. ' +
          'recordResult() therefore credited the swapped-OUT player (Test 1) instead ' +
          "of the swapped-IN player (Test 7) as Test 13's partner, permanently " +
          "writing a false 'partnered' fact into pairStats. coPresent on this pair " +
          'was left untouched — that count is legitimate history from real earlier ' +
          'check-ins, unrelated to this bug. There was no rebuildClubState() to ' +
          'recompute from the game log, so this was corrected by hand via this ' +
          'committed, dated script instead of a console edit. See USECASES.md UC-2 ' +
          'STATUS note.',
      },
    });
  });

  console.log('\nOK — wrote correction + audit log entry', auditRef.id);
}

main().catch(err => {
  console.error('FAILED —', err instanceof Error ? err.message : err);
  process.exit(1);
});
