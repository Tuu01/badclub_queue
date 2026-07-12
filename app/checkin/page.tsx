'use client';

import { useMemo, useState } from 'react';
import { usePlayers } from '@/lib/use-players';
import { writeFetch } from '@/lib/client-code';
import { todaySessionId } from '@/lib/session-id';

export default function CheckinPage() {
  const { players, loading } = usePlayers();
  const [courtCount, setCourtCount] = useState(3);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const active = useMemo(
    () => [...players].filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name)),
    [players],
  );

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const sessionId = todaySessionId();
      const res = await writeFetch(`/api/session/${sessionId}/checkin`, {
        method: 'POST',
        body: JSON.stringify({ courtCount, playerIds: [...selected] }),
      });
      if (res.ok) {
        setMessage(`Đã check-in ${selected.size} người — buổi ${sessionId}.`);
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Lỗi: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="text-2xl font-bold">Check-in</h1>

      <div className="flex items-center gap-3">
        <label className="text-sm">Số sân</label>
        <input
          type="number"
          min={1}
          max={8}
          value={courtCount}
          onChange={e => setCourtCount(Math.max(1, Number(e.target.value) || 1))}
          className="h-14 w-20 rounded border border-gray-300 px-3 text-lg"
        />
      </div>

      {loading ? (
        <p>Đang tải…</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {active.map(p => {
            const on = selected.has(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  className={`min-h-[56px] w-full rounded border px-3 py-2 text-left ${
                    on ? 'border-black bg-black text-white' : 'border-gray-300 bg-white'
                  }`}
                >
                  {p.name}
                </button>
              </li>
            );
          })}
          {active.length === 0 && (
            <li className="col-span-2 text-sm text-gray-500">
              Chưa có ai trong danh sách. Thêm người ở /admin/players trước.
            </li>
          )}
        </ul>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={busy || selected.size === 0}
        className="min-h-[56px] w-full rounded bg-green-600 text-lg font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Đang lưu…' : `Check-in ${selected.size} người`}
      </button>

      {message && <p className="text-center">{message}</p>}
    </main>
  );
}
