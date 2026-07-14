// ============================================================
// wipe-club.ts — DELETE the entire club: every session (+ its games
// and audit subcollections and the ratingSnapshot field), every
// player, pairStats, and the private ratings doc.
//
// WHY THIS IS A COMMITTED SCRIPT, NOT A CONSOLE CLICK:
//   In three months, when a number looks odd, "did anyone ever wipe
//   this?" must be answerable. A committed script with printed counts
//   answers it. A Firebase-console click leaves no trace. Keep this
//   file in git — do not delete it after use.
//
// SAFETY: does nothing without --confirm. Prints exactly what it
//   deleted, with counts, so the output is the audit record.
//
//   Run:  npx tsx scripts/wipe-club.ts --confirm
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLUB_ID } from '../lib/constants';

// tsx doesn't auto-load .env.local like Next.js — load it BEFORE the
// dynamic import of firebase-admin (static imports hoist above this).
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function deleteQueryDocs(ref: FirebaseFirestore.Query, db: FirebaseFirestore.Firestore): Promise<number> {
  const snap = await ref.get();
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}

async function main() {
  const confirmed = process.argv.includes('--confirm');
  loadEnvLocal();
  const { adminDb: db } = await import('../lib/firebase-admin');

  console.log(`\nWIPE clubs/${CLUB_ID}  (project: ${process.env.FIREBASE_PROJECT_ID})`);
  console.log(confirmed ? 'MODE: --confirm present → DELETING\n' : 'MODE: DRY RUN (pass --confirm to actually delete)\n');

  // ---- sessions + every subcollection (games, audit, …) ----
  const sessionsSnap = await db.collection('sessions').get();
  let totalGames = 0, totalSubOther = 0;
  const subCounts: Record<string, number> = {};
  for (const sdoc of sessionsSnap.docs) {
    const subs = await sdoc.ref.listCollections();
    for (const sub of subs) {
      const count = confirmed
        ? await deleteQueryDocs(sub, db)
        : (await sub.get()).size;
      subCounts[sub.id] = (subCounts[sub.id] ?? 0) + count;
      if (sub.id === 'games') totalGames += count; else totalSubOther += count;
    }
  }
  const sessionCount = confirmed
    ? await deleteQueryDocs(db.collection('sessions'), db)
    : sessionsSnap.size;

  // ---- players ----
  const playerCount = confirmed
    ? await deleteQueryDocs(db.collection(`clubs/${CLUB_ID}/players`), db)
    : (await db.collection(`clubs/${CLUB_ID}/players`).get()).size;

  // ---- pairStats + ratings (single docs) ----
  const pairStatsRef = db.doc(`clubs/${CLUB_ID}/meta/pairStats`);
  const ratingsRef = db.doc(`clubs/${CLUB_ID}/private/ratings`);
  const pairStatsExisted = (await pairStatsRef.get()).exists;
  const ratingsExisted = (await ratingsRef.get()).exists;
  if (confirmed) {
    if (pairStatsExisted) await pairStatsRef.delete();
    if (ratingsExisted) await ratingsRef.delete();
  }

  // ---- report ----
  console.log('DELETED (counts):');
  console.log(`  sessions:            ${sessionCount}`);
  console.log(`  ├─ games:            ${totalGames}`);
  for (const [k, v] of Object.entries(subCounts)) {
    if (k === 'games') continue;
    console.log(`  ├─ ${k}:${' '.repeat(Math.max(1, 18 - k.length))}${v}`);
  }
  console.log(`  players:             ${playerCount}`);
  console.log(`  meta/pairStats:      ${pairStatsExisted ? (confirmed ? 'deleted' : 'exists') : 'absent'}`);
  console.log(`  private/ratings:     ${ratingsExisted ? (confirmed ? 'deleted' : 'exists') : 'absent'}`);
  console.log(confirmed ? '\nWIPE COMPLETE.' : '\nDRY RUN — nothing deleted. Re-run with --confirm.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
