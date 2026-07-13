'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { usePlayers } from '@/lib/use-players';
import { writeFetch } from '@/lib/client-code';
import type { PublicPlayerDoc } from '@/lib/firestore';

const DIVS: Array<1 | 2> = [1, 2];
const TAP = 'transition-transform duration-75 active:scale-[0.98]';

export default function AdminPlayersPage() {
  const { players, loading } = usePlayers();
  const [form, setForm] = useState<{ name: string; gender: 'M' | 'F'; div: 1 | 2 }>({
    name: '', gender: 'M', div: 1,
  });
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // Drag-and-drop updates the LOCAL list right away (smooth feel), server confirms after.
  const [localOrder, setLocalOrder] = useState<Record<number, string[]> | null>(null);

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

  function handleDrop(div: 1 | 2, targetId: string) {
    const from = dragId;
    setDragId(null);
    if (!from || from === targetId) return;

    const list = [...byDiv[div]];
    const fromIdx = list.findIndex(p => p.id === from);
    const toIdx = list.findIndex(p => p.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    const orderedIds = list.map(p => p.id);

    setLocalOrder(prev => ({ ...(prev ?? {}), [div]: orderedIds }));
    writeFetch('/api/players/reorder', { method: 'POST', body: JSON.stringify({ div, orderedIds }) });
  }

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-8 bg-court-900 p-4 text-line-000">
      <Link href="/admin" className="block text-[13px] text-line-400">← Back to admin</Link>
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

      {loading ? (
        <p className="text-line-400">Loading…</p>
      ) : (
        <>
          {DIVS.map(div => (
            <section key={div}>
              <p className="mb-2 text-[11px] font-medium text-line-400">div {div} · drag-and-drop to set seed rank</p>
              <ul className="space-y-2">
                {byDiv[div].map(p => (
                  <li
                    key={p.id}
                    draggable
                    onDragStart={() => setDragId(p.id)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleDrop(div, p.id)}
                    className="flex min-h-[56px] cursor-move items-center justify-between rounded-xl border border-line-700 bg-court-800 px-3 py-2"
                  >
                    <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>
                      {p.seedRank}. {p.name} {p.gender === 'F' ? '♀' : ''}
                    </span>
                    <button onClick={() => toggleActive(p)} className="text-[13px] text-line-400">Remove</button>
                  </li>
                ))}
                {byDiv[div].length === 0 && <li className="text-[13px] text-line-400">Nobody here yet.</li>}
              </ul>
            </section>
          ))}

          {inactive.length > 0 && (
            <section>
              <p className="mb-2 text-[11px] font-medium text-line-400">removed ({inactive.length})</p>
              <ul className="space-y-2">
                {inactive.map(p => (
                  <li
                    key={p.id}
                    className="flex min-h-[56px] items-center justify-between rounded-xl border border-line-800 px-3 py-2 text-line-400"
                  >
                    <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>{p.name}</span>
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
