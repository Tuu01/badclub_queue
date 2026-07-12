// ============================================================
// check-firebase.ts — kiểm tra kết nối: ghi một doc test, đọc lại, xoá.
// Chạy: npm run check:firebase
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// tsx không tự nạp .env.local như Next.js — nạp thủ công ở đây,
// TRƯỚC khi import lib/firebase-admin (import tĩnh bị hoist lên đầu
// module, nên phải dùng import động sau khi env đã có).
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

async function main() {
  loadEnvLocal();
  const { adminDb } = await import('../lib/firebase-admin');

  const ref = adminDb.collection('_connectivity_check').doc('ping');
  const now = Date.now();

  await ref.set({ at: now });
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.at !== now) {
    throw new Error('readback mismatch — wrote but could not read the same value back');
  }
  await ref.delete();

  console.log(`OK — wrote, read back, deleted (project: ${process.env.FIREBASE_PROJECT_ID})`);
}

main().catch(err => {
  console.error('FAILED —', err instanceof Error ? err.message : err);
  process.exit(1);
});
