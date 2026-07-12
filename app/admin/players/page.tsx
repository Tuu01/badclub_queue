'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { usePlayers } from '@/lib/use-players';
import { writeFetch } from '@/lib/client-code';
import type { PublicPlayerDoc } from '@/lib/firestore';

const DIVS: Array<1 | 2> = [1, 2];

export default function AdminPlayersPage() {
  const { players, loading } = usePlayers();
  const [form, setForm] = useState<{ name: string; gender: 'M' | 'F'; div: 1 | 2 }>({
    name: '', gender: 'M', div: 1,
  });
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // Kéo-thả cập nhật danh sách LOCAL ngay (mượt tay), server xác nhận sau.
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
    <main className="mx-auto max-w-2xl p-4 space-y-8">
      <h1 className="text-2xl font-bold">Người chơi</h1>

      <form onSubmit={addPlayer} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm mb-1">Tên</label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="h-14 min-w-[10rem] rounded border border-gray-300 px-3"
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Giới tính</label>
          <select
            value={form.gender}
            onChange={e => setForm(f => ({ ...f, gender: e.target.value as 'M' | 'F' }))}
            className="h-14 rounded border border-gray-300 px-3"
          >
            <option value="M">Nam</option>
            <option value="F">Nữ</option>
          </select>
        </div>
        <div>
          <label className="block text-sm mb-1">Div</label>
          <select
            value={form.div}
            onChange={e => setForm(f => ({ ...f, div: Number(e.target.value) as 1 | 2 }))}
            className="h-14 rounded border border-gray-300 px-3"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </div>
        <button disabled={busy} type="submit" className="h-14 rounded bg-black px-6 text-white disabled:opacity-50">
          Thêm
        </button>
      </form>

      {loading ? (
        <p>Đang tải…</p>
      ) : (
        <>
          {DIVS.map(div => (
            <section key={div}>
              <h2 className="mb-2 text-lg font-semibold">Div {div} · kéo-thả để xếp hạng seed</h2>
              <ul className="space-y-2">
                {byDiv[div].map(p => (
                  <li
                    key={p.id}
                    draggable
                    onDragStart={() => setDragId(p.id)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleDrop(div, p.id)}
                    className="flex min-h-[56px] cursor-move items-center justify-between rounded border border-gray-300 bg-white px-3 py-2"
                  >
                    <span>{p.seedRank}. {p.name} {p.gender === 'F' ? '♀' : ''}</span>
                    <button onClick={() => toggleActive(p)} className="text-sm text-red-600">Gỡ</button>
                  </li>
                ))}
                {byDiv[div].length === 0 && <li className="text-sm text-gray-500">Chưa có ai.</li>}
              </ul>
            </section>
          ))}

          {inactive.length > 0 && (
            <section>
              <h2 className="mb-2 text-lg font-semibold text-gray-500">Đã gỡ ({inactive.length})</h2>
              <ul className="space-y-2">
                {inactive.map(p => (
                  <li
                    key={p.id}
                    className="flex min-h-[56px] items-center justify-between rounded border border-gray-200 px-3 py-2 text-gray-500"
                  >
                    <span>{p.name}</span>
                    <button onClick={() => toggleActive(p)} className="text-sm text-blue-600">Khôi phục</button>
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
