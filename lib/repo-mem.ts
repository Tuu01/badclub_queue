// ============================================================
// repo-mem.ts — a zero-I/O in-memory Db. Same interface as the real
// Firestore, so lib/firestore.ts's functions run against it UNCHANGED.
//
// Faithful to the semantics the code relies on:
//   - update() shallow-merges top-level fields and THROWS if the doc is
//     missing (matches Firestore NOT_FOUND).
//   - runTransaction() BUFFERS writes and flushes them only if the
//     callback resolves; if it throws (e.g. ConflictError), nothing
//     persists — matching real transaction rollback.
//   - get()/set() deep-copy, so callers can't alias stored data.
//
// NOT faithful (by design, documented): optimistic-concurrency retry.
// A single-threaded mock cannot race two transactions on one doc — the
// one thing only real Firestore can prove. tests/firestore-uc5.test.ts
// stays on the real client for exactly that. See repo.ts.
// ============================================================

import type {
  Db, DocRef, DocSnap, QuerySnap, Query, CollectionRef, WriteBatch, Tx, DocumentData, WhereOp,
} from './repo';

type Store = Map<string, DocumentData>;
const clone = (d: DocumentData): DocumentData => structuredClone(d);

function parentIsCollection(docPath: string, collectionPath: string): boolean {
  if (!docPath.startsWith(collectionPath + '/')) return false;
  const rest = docPath.slice(collectionPath.length + 1);
  return !rest.includes('/'); // direct child only, not a nested subcollection
}

function matches(data: DocumentData, filters: Filter[]): boolean {
  return filters.every(f => {
    const v = data[f.field];
    switch (f.op) {
      case '==': return v === f.value;
      case '!=': return v !== f.value;
      case '<': return (v as number) < (f.value as number);
      case '<=': return (v as number) <= (f.value as number);
      case '>': return (v as number) > (f.value as number);
      case '>=': return (v as number) >= (f.value as number);
    }
  });
}

interface Filter { field: string; op: WhereOp; value: unknown; }

// A pending write applied to either the live store (batch/commit) or a
// transaction's buffer.
type WriteOp =
  | { kind: 'set'; path: string; data: DocumentData }
  | { kind: 'update'; path: string; data: DocumentData }
  | { kind: 'delete'; path: string };

function applyWrite(store: Store, op: WriteOp): void {
  if (op.kind === 'set') { store.set(op.path, clone(op.data)); return; }
  if (op.kind === 'delete') { store.delete(op.path); return; }
  // update — shallow top-level merge, THROW if missing (Firestore NOT_FOUND)
  const cur = store.get(op.path);
  if (!cur) throw new Error(`update on missing doc: ${op.path}`);
  store.set(op.path, { ...cur, ...clone(op.data) });
}

function snapOf(store: Store, ref: MemDocRef): DocSnap {
  const data = store.get(ref.path);
  return {
    id: ref.id,
    exists: data !== undefined,
    ref,
    data: () => (data === undefined ? undefined : clone(data)),
  };
}

function querySnapOf(store: Store, collectionPath: string, filters: Filter[], mk: (p: string) => MemDocRef): QuerySnap {
  const docs: DocSnap[] = [];
  for (const [path, data] of store) {
    if (!parentIsCollection(path, collectionPath)) continue;
    if (!matches(data, filters)) continue;
    docs.push(snapOf(store, mk(path)));
  }
  return { docs, size: docs.length, empty: docs.length === 0 };
}

class MemDocRef implements DocRef {
  constructor(private store: Store, public path: string, private sink: (op: WriteOp) => void) {}
  get id(): string { return this.path.slice(this.path.lastIndexOf('/') + 1); }
  async get(): Promise<DocSnap> { return snapOf(this.store, this); }
  async set(data: DocumentData): Promise<unknown> { this.sink({ kind: 'set', path: this.path, data }); return; }
  async update(data: DocumentData): Promise<unknown> { this.sink({ kind: 'update', path: this.path, data }); return; }
  async delete(): Promise<unknown> { this.sink({ kind: 'delete', path: this.path }); return; }
}

class MemQuery implements Query {
  constructor(protected store: Store, protected collectionPath: string, protected filters: Filter[],
              protected sink: (op: WriteOp) => void) {}
  where(field: string, op: WhereOp, value: unknown): Query {
    return new MemQuery(this.store, this.collectionPath, [...this.filters, { field, op, value }], this.sink);
  }
  async get(): Promise<QuerySnap> {
    return querySnapOf(this.store, this.collectionPath, this.filters,
      p => new MemDocRef(this.store, p, this.sink));
  }
}

class MemCollectionRef extends MemQuery implements CollectionRef {
  private counter = { n: 0 };
  constructor(store: Store, path: string, sink: (op: WriteOp) => void, counter: { n: number }) {
    super(store, path, [], sink);
    this.counter = counter;
  }
  doc(id?: string): DocRef {
    const realId = id ?? `auto_${String(++this.counter.n).padStart(8, '0')}`;
    return new MemDocRef(this.store, `${this.collectionPath}/${realId}`, this.sink);
  }
}

class MemBatch implements WriteBatch {
  private ops: WriteOp[] = [];
  constructor(private store: Store) {}
  set(ref: DocRef, data: DocumentData): WriteBatch { this.ops.push({ kind: 'set', path: (ref as MemDocRef).path, data }); return this; }
  update(ref: DocRef, data: DocumentData): WriteBatch { this.ops.push({ kind: 'update', path: (ref as MemDocRef).path, data }); return this; }
  delete(ref: DocRef): WriteBatch { this.ops.push({ kind: 'delete', path: (ref as MemDocRef).path }); return this; }
  async commit(): Promise<unknown> { for (const op of this.ops) applyWrite(this.store, op); this.ops = []; return; }
}

class MemTx implements Tx {
  private buffer: WriteOp[] = [];
  constructor(private store: Store) {}
  get(ref: DocRef): Promise<DocSnap>;
  get(query: Query): Promise<QuerySnap>;
  async get(arg: DocRef | Query): Promise<DocSnap | QuerySnap> {
    if (arg instanceof MemDocRef) return snapOf(this.store, arg);
    return (arg as MemQuery).get(); // reads see committed state (pre-flush)
  }
  set(ref: DocRef, data: DocumentData): Tx { this.buffer.push({ kind: 'set', path: (ref as MemDocRef).path, data }); return this; }
  update(ref: DocRef, data: DocumentData): Tx { this.buffer.push({ kind: 'update', path: (ref as MemDocRef).path, data }); return this; }
  delete(ref: DocRef): Tx { this.buffer.push({ kind: 'delete', path: (ref as MemDocRef).path }); return this; }
  flush(): void { for (const op of this.buffer) applyWrite(this.store, op); this.buffer = []; }
}

class MemDb implements Db {
  private store: Store = new Map();
  private counter = { n: 0 };
  private sink = (op: WriteOp) => applyWrite(this.store, op); // bare ref writes apply immediately
  doc(path: string): DocRef { return new MemDocRef(this.store, path, this.sink); }
  collection(path: string): CollectionRef { return new MemCollectionRef(this.store, path, this.sink, this.counter); }
  batch(): WriteBatch { return new MemBatch(this.store); }
  async runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = new MemTx(this.store);
    const result = await fn(tx); // if fn throws, buffer is discarded → rollback
    tx.flush();
    return result;
  }
}

export function createMemDb(): Db {
  return new MemDb();
}
