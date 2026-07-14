// ============================================================
// db.ts — pick the Db implementation by env. TEST_MODE=1 → in-memory.
//
// This is the app-level switch. NOTE: it eagerly imports repo-fs (which
// boots firebase-admin), so it's for the running app (where credentials
// exist), not for offline unit tests. Verification tests should import
// `createMemDb` from repo-mem DIRECTLY — no env, no credentials, no I/O.
// See repo.ts.
// ============================================================

import type { Db } from './repo';
import { createMemDb } from './repo-mem';
import { fsDb } from './repo-fs';

export const db: Db = process.env.TEST_MODE === '1' ? createMemDb() : fsDb;
