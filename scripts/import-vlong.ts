// ============================================================
// import-vlong.ts — capture the historical Vlong Summer Cup 2026 from
// scripts/data/vlong-clean.json into Firestore. Committed as the audit
// record of how the club's first real data got in.
//
//   npx tsx scripts/import-vlong.ts            → dry-run preview
//   npx tsx scripts/import-vlong.ts --confirm  → write it
//
// Idempotent by (name, date): safe to run twice. After a write it
// re-reads and asserts STRUCTURAL SEPARATION — every rating still at
// seed, pairStats untouched — because a tournament must never move skill.
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLUB_ID } from '../lib/constants';

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

async function main() {
  const confirmed = process.argv.includes('--confirm');
  loadEnvLocal();
  const { adminDb: db } = await import('../lib/firebase-admin');
  const { importTournament } = await import('../lib/tournament');

  const input = JSON.parse(readFileSync(path.resolve(process.cwd(), 'scripts/data/vlong-clean.json'), 'utf8'));

  console.log(`\nIMPORT ${input.tournament.name} (${input.tournament.date}) → clubs/${CLUB_ID}`);
  console.log(confirmed ? 'MODE: --confirm → WRITING\n' : 'MODE: DRY RUN (pass --confirm to write)\n');

  const preview = await importTournament(db, CLUB_ID, input, { dryRun: !confirmed });
  console.log('tournamentId :', preview.tournamentId, preview.alreadyExists ? '(already exists — overwrite)' : '');
  console.log('teams        :', preview.teamCount);
  console.log('games        :', preview.gameCount);
  console.log('players create:', preview.playersToCreate.length, '| matched:', preview.playersMatched.length);
  if (preview.unknownNames.length) {
    console.log('UNKNOWN NAMES:', preview.unknownNames.join(', '));
    console.log('\nStopped — resolve unknown names first. Nothing written.');
    process.exit(1);
  }
  preview.warnings.forEach(w => console.log('warn:', w));
  console.log('wrote        :', preview.wrote);

  if (!confirmed) { console.log('\nDRY RUN — nothing written. Re-run with --confirm.'); process.exit(0); }

  // ---- VERIFY STRUCTURAL SEPARATION on the real DB ----
  const players = (await db.collection(`clubs/${CLUB_ID}/players`).get()).docs.map(d => d.data() as any).filter(p => !p.isGuest);
  const ratings = ((await db.doc(`clubs/${CLUB_ID}/private/ratings`).get()).data() as any)?.ratings ?? {};
  const { seedMu, SIGMA_INIT } = await import('../lib/rating');
  const sigmas = Object.values(ratings).map((r: any) => r.sigma);
  const sumGT = players.reduce((s, p) => s + (p.gamesTotal ?? 0), 0);
  const offSeed = players.filter(p => {
    const divSize = players.filter(q => q.div === p.div).length;
    return Math.abs(ratings[p.id].mu - seedMu(p.div, p.seedRank, divSize)) > 1e-9;
  });
  const pairStatsExists = (await db.doc(`clubs/${CLUB_ID}/meta/pairStats`).get()).exists;

  console.log('\n════ SEPARATION CHECK (skill must be untouched) ════');
  console.log(`players created      : ${players.length}`);
  console.log(`σ range              : ${Math.min(...sigmas as number[])}–${Math.max(...sigmas as number[])} (expect 8–8)`);
  console.log(`Σ gamesTotal         : ${sumGT} (expect 0)`);
  console.log(`players off seed mu  : ${offSeed.length} (expect 0)`);
  console.log(`pairStats doc exists : ${pairStatsExists} (expect false)`);
  const clean = sumGT === 0 && offSeed.length === 0 && !pairStatsExists && sigmas.every(s => s === SIGMA_INIT);
  console.log(clean ? '\n✓ IMPORTED. Skill untouched — tournament is quarantined.' : '\n✗ SEPARATION VIOLATED — investigate.');
  process.exit(clean ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
