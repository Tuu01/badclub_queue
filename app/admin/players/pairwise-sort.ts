// ============================================================
// pairwise-sort.ts — binary-insertion-sort seed ranking.
//
// Replaces drag-and-drop (see Report 0 of the 2026-07-13 audit: native
// HTML5 drag events are mouse-only and never fire from touch input —
// dead on the one device this app is designed for). Humans are BAD at
// ordering 11 things and GOOD at choosing between two, and the seed
// only needs to land within ~±7 anyway — TrueSkill corrects the rest
// over six months of real games.
//
// log2(k) comparisons to insert the k-th player into an already-sorted
// list of (k-1) — about 4 comparisons each, ~25 total for 11 people.
//
// Pure, UI-framework-agnostic, co-located with the one page that uses
// it (NOT lib/ — this is UI-layer sequencing, not the pure core).
// ============================================================

export interface SortState {
  /** Strongest → weakest, confirmed so far. */
  sorted: string[];
  /** Not yet inserted. */
  remaining: string[];
  /** The player currently being binary-searched into `sorted`. */
  current: { id: string; lo: number; hi: number } | null;
  doneComparisons: number;
  /** Worst-case estimate, for the progress display — not exact once "skip" cuts a search short. */
  totalComparisons: number;
}

function estimateTotalComparisons(n: number): number {
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.ceil(Math.log2(k));
  return total;
}

export function startSort(ids: string[]): SortState {
  const [first, ...rest] = ids;
  return {
    sorted: first ? [first] : [],
    remaining: rest,
    current: null,
    doneComparisons: 0,
    totalComparisons: estimateTotalComparisons(ids.length),
  };
}

export function isDone(state: SortState): boolean {
  return state.remaining.length === 0 && state.current === null;
}

/** Pulls the next remaining player into `current` if there isn't one already. */
function ensureCurrent(state: SortState): SortState {
  if (state.current || state.remaining.length === 0) return state;
  const [next, ...rest] = state.remaining;
  return { ...state, remaining: rest, current: { id: next, lo: 0, hi: state.sorted.length } };
}

/** Inserts `current` into `sorted` at its resolved position. */
function placeCurrent(state: SortState): SortState {
  if (!state.current) return state;
  const { id, lo } = state.current;
  const sorted = [...state.sorted.slice(0, lo), id, ...state.sorted.slice(lo)];
  return { ...state, sorted, current: null };
}

/**
 * The pair to show the user right now, or null if there's nothing left
 * to compare (either the whole sort is done, or the in-flight
 * insertion's range has already collapsed and just needs placing —
 * callers should always run `answer()`'s auto-placement, so this
 * should be rare to see as null mid-sort).
 */
export function currentPair(stateIn: SortState, players: Map<string, string>): { a: string; b: string; aId: string; bId: string } | null {
  const state = ensureCurrent(stateIn);
  if (!state.current) return null;
  const { lo, hi } = state.current;
  if (lo >= hi) return null;
  const mid = Math.floor((lo + hi) / 2);
  const bId = state.sorted[mid];
  return { a: players.get(state.current.id) ?? state.current.id, b: players.get(bId) ?? bId, aId: state.current.id, bId };
}

/**
 * choice: 'a' = the player being inserted is stronger than the
 * midpoint, 'b' = the midpoint is stronger, 'skip' = can't tell —
 * treat as a tie and place right here. "Skip" never forces someone
 * through the rest of the binary search; it just ends this one
 * insertion early.
 */
export function answer(stateIn: SortState, choice: 'a' | 'b' | 'skip'): SortState {
  const state = ensureCurrent(stateIn);
  if (!state.current) return state;
  const { lo, hi } = state.current;
  const mid = Math.floor((lo + hi) / 2);

  const range =
    choice === 'skip' ? { lo: mid, hi: mid } :
    choice === 'a'    ? { lo, hi: mid } :
                        { lo: mid + 1, hi };

  let next: SortState = {
    ...state,
    current: { ...state.current, ...range },
    doneComparisons: state.doneComparisons + 1,
  };

  if (next.current && next.current.lo >= next.current.hi) {
    next = placeCurrent(next);
  }
  return ensureCurrent(next);
}
