// ============================================================
// repo.ts — the Db interface: the SMALL subset of Firestore that
// lib/firestore.ts actually uses.
//
// Two implementations satisfy it:
//   repo-fs.ts   — the real firebase-admin Firestore (unchanged prod path)
//   repo-mem.ts  — a zero-I/O in-memory store, for verification
//
// The 27 data-layer functions take `db: Db` and run UNCHANGED against
// either — so a verification test exercises the REAL business logic, not
// a re-implementation. That is the whole point: an in-memory *copy of
// the functions* could silently drift and give false confidence; a
// mock of the storage *primitive* cannot, because the code above it is
// identical in both modes.
//
// ⚠ The ONE thing the mock cannot reproduce is Firestore's optimistic-
// concurrency retry (two transactions racing the same doc). That is why
// tests/firestore-uc5.test.ts stays on real Firestore. Everything else
// is safe on the mock. See STEP 3.
// ============================================================

// Mirrors firebase-admin's DocumentData ({ [field: string]: any }) so the
// existing `snap.data() as SessionDoc` casts throughout firestore.ts keep
// working unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DocumentData = { [field: string]: any };
export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface DocSnap {
  readonly id: string;
  readonly exists: boolean;
  readonly ref: DocRef;
  data(): DocumentData | undefined;
}

export interface QuerySnap {
  readonly docs: DocSnap[];
  readonly size: number;
  readonly empty: boolean;
}

export interface Query {
  where(field: string, op: WhereOp, value: unknown): Query;
  get(): Promise<QuerySnap>;
}

export interface DocRef {
  readonly id: string;
  get(): Promise<DocSnap>;
  set(data: DocumentData): Promise<unknown>;
  update(data: DocumentData): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface CollectionRef extends Query {
  /** No arg → a new ref with an auto-generated id. */
  doc(id?: string): DocRef;
}

export interface WriteBatch {
  set(ref: DocRef, data: DocumentData): WriteBatch;
  update(ref: DocRef, data: DocumentData): WriteBatch;
  delete(ref: DocRef): WriteBatch;
  commit(): Promise<unknown>;
}

export interface Tx {
  get(ref: DocRef): Promise<DocSnap>;
  get(query: Query): Promise<QuerySnap>;
  set(ref: DocRef, data: DocumentData): Tx;
  update(ref: DocRef, data: DocumentData): Tx;
  delete(ref: DocRef): Tx;
}

export interface Db {
  doc(path: string): DocRef;
  collection(path: string): CollectionRef;
  batch(): WriteBatch;
  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
