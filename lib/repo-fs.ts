// ============================================================
// repo-fs.ts — the REAL Firestore, as a Db. This is the production
// path; lib/firebase-admin.ts already builds the Admin SDK client.
// The `: Db` annotation below is a genuine compile-time guarantee: the
// real firebase-admin client is structurally assignable to Db with no
// cast, so nothing is faked in production and the interface can't drift
// from what Firestore actually provides.
// ============================================================

import { adminDb } from './firebase-admin';
import type { Db } from './repo';

export const fsDb: Db = adminDb;
