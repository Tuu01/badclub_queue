'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { usePlayers } from '@/lib/use-players';
import { writeFetch } from '@/lib/client-code';
import { startSort, answer, currentPair, isDone, type SortState } from './pairwise-sort';
import type { PublicPlayerDoc } from '@/lib/firestore';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../../shared-ui';
import { AdminGate } from '../admin-gate';

const DIVS: Array<1 | 2> = [1, 2];
const TAP = 'transition-transform duration-75 active:scale-[0.98]';

// Accent-insensitive so "cuong"/"duc" match "Cường"/"Đức".
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function savedKey(div: 1 | 2): string {
  return `rank-sort-div-${div}`;
}

/** Only resumes a saved sort if it still matches the CURRENT active
 * roster for that division exactly — otherwise a player added/removed
 * mid-sort would silently corrupt the in-progress state. */
function loadSaved(div: 1 | 2, validIds: Set<string>): SortState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(savedKey(div));
    if (!raw) return null;
    const state = JSON.parse(raw) as SortState;
    const allIds = [...state.sorted, ...state.remaining, ...(state.current ? [state.current.id] : [])];
    if (allIds.length !== validIds.size || allIds.some(id => !validIds.has(id))) return null;
    return state;
  } catch {
    return null;
  }
}

function saveProgress(div: 1 | 2, state: SortState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(savedKey(div), JSON.stringify(state));
}

function clearProgress(div: 1 | 2): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(savedKey(div));
}

function AdminPlayersPageInner() {
  const { players, loading } = usePlayers();
  const actor = useActor();
  const [form, setForm] = useState<{ name: string; gender: 'M' | 'F'; div: 1 | 2 }>({
    name: '', gender: 'M', div: 1,
  });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  // Optimistic local reorder (arrows or a finished comparison sort) — server confirms after.
  const [localOrder, setLocalOrder] = useState<Record<number, string[]> | null>(null);

  const [rankingDiv, setRankingDiv] = useState<1 | 2 | null>(null);
  const [sortState, setSortState] = useState<SortState | null>(null);

  const byDiv = useMemo(() => {
    const groups: Record<1 | 2, PublicPlayerDoc[]> = { 1: [], 2: [] };
    for (const p of players) {
      if (p.active) groups[p.div].push(p);
    }
    groups[1].sort((a, b) => a.seedRank - b.seedRank);
    groups[2].sort((a, b) => a.seedRank - b.seedRank);

    if (localOrder) {
      const byId = new Map(players.map(p => [p.id, p]));
      for (const div of DIVS) {
        const ids = localOrder[div];
        if (!ids) continue;
        const ordered = ids.map(id => byId.get(id)).filter((p): p is PublicPlayerDoc => !!p);
        if (ordered.length === groups[div].length) groups[div] = ordered;
      }
    }
    return groups;
  }, [players, localOrder]);

  const inactive = useMemo(() => players.filter(p => !p.active), [players]);

  const savedByDiv = useMemo(
    () => ({
      1: loadSaved(1, new Set(byDiv[1].map(p => p.id))),
      2: loadSaved(2, new Set(byDiv[2].map(p => p.id))),
    }),
    [byDiv],
  );

  async function addPlayer(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await writeFetch('/api/players', { method: 'POST', body: JSON.stringify(form) });
      if (res.ok) setForm({ name: '', gender: 'M', div: form.div });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(p: PublicPlayerDoc) {
    await writeFetch(`/api/players/${p.id}`, { method: 'PATCH', body: JSON.stringify({ active: !p.active }) });
  }

  function moveInDiv(div: 1 | 2, index: number, direction: -1 | 1) {
    const list = [...byDiv[div]];
    const otherIndex = index + direction;
    if (otherIndex < 0 || otherIndex >= list.length) return;
    [list[index], list[otherIndex]] = [list[otherIndex], list[index]];
    const orderedIds = list.map(p => p.id);
    setLocalOrder(prev => ({ ...(prev ?? {}), [div]: orderedIds }));
    writeFetch('/api/players/reorder', { method: 'POST', body: JSON.stringify({ div, orderedIds }) });
  }

  function beginRanking(div: 1 | 2) {
    const ids = byDiv[div].map(p => p.id);
    const saved = loadSaved(div, new Set(ids));
    setSortState(saved ?? startSort(ids));
    setRankingDiv(div);
  }

  function restartRanking(div: 1 | 2) {
    clearProgress(div);
    setSortState(startSort(byDiv[div].map(p => p.id)));
    setRankingDiv(div);
  }

  function cancelRanking() {
    setRankingDiv(null);
    setSortState(null);
  }

  async function finishRanking(div: 1 | 2, finalState: SortState) {
    clearProgress(div);
    setRankingDiv(null);
    setSortState(null);
    const orderedIds = finalState.sorted;
    setLocalOrder(prev => ({ ...(prev ?? {}), [div]: orderedIds }));
    await writeFetch('/api/players/reorder', { method: 'POST', body: JSON.stringify({ div, orderedIds }) });
  }

  function respond(choice: 'a' | 'b' | 'skip') {
    if (!sortState || rankingDiv === null) return;
    const next = answer(sortState, choice);
    if (isDone(next)) {
      finishRanking(rankingDiv, next);
    } else {
      setSortState(next);
      saveProgress(rankingDiv, next);
    }
  }

  const searchQ = normalizeName(query);
  const searching = searchQ.length > 0;
  const inactiveShown = searching ? inactive.filter(p => normalizeName(p.name).includes(searchQ)) : inactive;

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-8 bg-court-900 p-4 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/admin" className="text-[13px] text-line-400">← Back to admin</Link>
      </div>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Players</p>

      <form onSubmit={addPlayer} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-[13px] text-line-400">Name</label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="h-14 min-w-[10rem] rounded-xl border border-line-700 bg-transparent px-3 text-[16px] text-line-000"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] text-line-400">Gender</label>
          <select
            value={form.gender}
            onChange={e => setForm(f => ({ ...f, gender: e.target.value as 'M' | 'F' }))}
            className="h-14 rounded-xl border border-line-700 bg-court-900 px-3 text-[16px] text-line-000"
          >
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[13px] text-line-400">Div</label>
          <select
            value={form.div}
            onChange={e => setForm(f => ({ ...f, div: Number(e.target.value) as 1 | 2 }))}
            className="h-14 rounded-xl border border-line-700 bg-court-900 px-3 text-[16px] text-line-000"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </div>
        <button
          disabled={busy}
          type="submit"
          className={`h-14 rounded-xl border border-line-000 bg-line-000 px-6 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
        >
          Add
        </button>
      </form>

      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search a player…"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-12 w-full rounded-xl border border-line-700 bg-transparent px-3 text-[16px] text-line-000 placeholder:text-line-400"
      />

      {loading ? (
        <p className="text-line-400">Loading…</p>
      ) : (
        <>
          {DIVS.map(div => {
            const ranking = !searching && rankingDiv === div && sortState;
            const saved = savedByDiv[div];
            const namesById = new Map(byDiv[div].map(p => [p.id, p.name]));
            const shown = searching ? byDiv[div].filter(p => normalizeName(p.name).includes(searchQ)) : byDiv[div];

            return (
              <section key={div}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-line-400">div {div} · strongest to weakest</p>
                  {!ranking && !searching && (
                    <button
                      onClick={() => beginRanking(div)}
                      className={`text-[13px] text-line-400 underline ${TAP}`}
                    >
                      {saved ? `Continue ranking · ${saved.doneComparisons} of ${saved.totalComparisons}` : 'Rank via comparisons'}
                    </button>
                  )}
                </div>

                {ranking && sortState ? (
                  (() => {
                    const pair = currentPair(sortState, namesById);
                    if (!pair) return null;
                    const shown = Math.min(sortState.doneComparisons + 1, sortState.totalComparisons);
                    return (
                      <div className="space-y-3 rounded-xl border border-line-700 bg-court-800 p-4">
                        <p className="text-center text-[13px] text-line-400">Who is stronger?</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => respond('a')}
                            className={`min-h-[96px] flex-1 rounded-xl border border-line-700 px-2 font-display text-[20px] text-line-000 ${TAP}`}
                            style={{ fontStretch: '110%' }}
                          >
                            {pair.a}
                          </button>
                          <button
                            onClick={() => respond('b')}
                            className={`min-h-[96px] flex-1 rounded-xl border border-line-700 px-2 font-display text-[20px] text-line-000 ${TAP}`}
                            style={{ fontStretch: '110%' }}
                          >
                            {pair.b}
                          </button>
                        </div>
                        <p className="text-center text-[13px] text-line-400">
                          <button onClick={() => respond('skip')} className="underline">skip</button>
                          {' '}· <span className="tabular">{shown} of {sortState.totalComparisons}</span>
                        </p>
                        <div className="flex justify-center gap-4 text-[11px] text-line-700">
                          <button onClick={() => restartRanking(div)}>Start over</button>
                          <button onClick={cancelRanking}>Cancel</button>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <ul className="space-y-2">
                    {shown.map(p => {
                      const i = byDiv[div].indexOf(p); // true rank position, even when filtered
                      return (
                        <li
                          key={p.id}
                          className="flex min-h-[56px] items-center justify-between gap-2 rounded-xl border border-line-700 bg-court-800 px-3 py-2"
                        >
                          <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>
                            {i + 1}. {p.name} <span className="text-line-400">{p.gender}</span>
                          </span>
                          <div className="flex items-center gap-1">
                            {!searching && (
                              <>
                                <button
                                  disabled={i === 0}
                                  onClick={() => moveInDiv(div, i, -1)}
                                  aria-label={`Move ${p.name} up`}
                                  className={`flex h-11 w-11 items-center justify-center rounded-lg border border-line-700 text-line-400 disabled:opacity-30 ${TAP}`}
                                >
                                  ▲
                                </button>
                                <button
                                  disabled={i === byDiv[div].length - 1}
                                  onClick={() => moveInDiv(div, i, 1)}
                                  aria-label={`Move ${p.name} down`}
                                  className={`flex h-11 w-11 items-center justify-center rounded-lg border border-line-700 text-line-400 disabled:opacity-30 ${TAP}`}
                                >
                                  ▼
                                </button>
                              </>
                            )}
                            <button onClick={() => toggleActive(p)} className="ml-2 text-[13px] text-line-400">Remove</button>
                          </div>
                        </li>
                      );
                    })}
                    {shown.length === 0 && (
                      <li className="text-[13px] text-line-400">{searching ? 'No name matches.' : 'Nobody here yet.'}</li>
                    )}
                  </ul>
                )}
              </section>
            );
          })}

          {inactiveShown.length > 0 && (
            <section>
              <p className="mb-2 text-[11px] font-medium text-line-400">removed ({inactiveShown.length})</p>
              <ul className="space-y-2">
                {inactiveShown.map(p => (
                  <li
                    key={p.id}
                    className="flex min-h-[56px] items-center justify-between rounded-xl border border-line-800 px-3 py-2 text-line-400"
                  >
                    <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>
                      {p.name} <span className="text-line-700">{p.gender}</span>
                    </span>
                    <button onClick={() => toggleActive(p)} className="text-[13px] text-line-000">Restore</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default function AdminPlayersPage() {
  return (
    <AdminGate>
      <AdminPlayersPageInner />
    </AdminGate>
  );
}
