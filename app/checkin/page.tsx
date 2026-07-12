'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePlayers } from '@/lib/use-players';
import { useSession } from '@/lib/use-session';
import { writeFetch } from '@/lib/client-code';
import { todaySessionId } from '@/lib/session-id';

export default function CheckinPage() {
  const { players, loading } = usePlayers();
  const sessionId = todaySessionId();
  const { session, loading: sessionLoading } = useSession(sessionId);

  const [courtCount, setCourtCount] = useState(3);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const active = useMemo(
    () => [...players].filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name)),
    [players],
  );

  // Nếu /admin/session/new đã chốt danh sách buổi, chỉ hiện ĐÚNG những
  // người đó ("Shows only the ~22 people on the roster" — PROMPT.md).
  // Chưa có buổi (hoặc chưa ai chốt danh sách) → hiện toàn bộ 55 người,
  // giống hành vi tối giản của Step 1.
  const hasPresetRoster = !!session && Object.keys(session.players).length > 0;
  const roster = useMemo(
    () => (hasPresetRoster ? active.filter(p => session!.players[p.id]) : active),
    [active, hasPresetRoster, session],
  );
  const extra = useMemo(
    () => (hasPresetRoster ? active.filter(p => !session!.players[p.id]) : []),
    [active, hasPresetRoster, session],
  );

  const effectiveCourtCount = hasPresetRoster ? session!.courtCount : courtCount;

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
      const res = await writeFetch(`/api/session/${sessionId}/checkin`, {
        method: 'POST',
        body: JSON.stringify({ courtCount: effectiveCourtCount, playerIds: [...selected] }),
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

  function renderGrid(list: typeof active) {
    return (
      <ul className="grid grid-cols-2 gap-2">
        {list.map(p => {
          const on = selected.has(p.id);
          const already = session?.attendance[p.id]?.status && session.attendance[p.id].status !== 'LEFT';
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => toggle(p.id)}
                disabled={!!already}
                className={`min-h-[56px] w-full rounded border px-3 py-2 text-left disabled:opacity-40 ${
                  on ? 'border-black bg-black text-white' : 'border-gray-300 bg-white'
                }`}
              >
                {p.name}{already ? ' ✓' : ''}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="text-2xl font-bold">Check-in</h1>

      {hasPresetRoster ? (
        <p className="text-sm text-gray-500">
          {session!.courtCount} sân · danh sách đã chốt ở /admin/session/new ({roster.length} người)
        </p>
      ) : (
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
      )}

      {loading || sessionLoading ? (
        <p>Đang tải…</p>
      ) : (
        <>
          {renderGrid(roster)}
          {roster.length === 0 && (
            <p className="text-sm text-gray-500">
              Chưa có ai trong danh sách. Thêm người ở /admin/players trước.
            </p>
          )}

          {hasPresetRoster && (
            <div>
              <button
                type="button"
                onClick={() => setShowMore(s => !s)}
                className="min-h-[44px] text-sm text-gray-500 underline"
              >
                {showMore ? 'Ẩn' : '+ Thêm người không có trong danh sách'}
              </button>
              {showMore && <div className="mt-2">{renderGrid(extra)}</div>}
            </div>
          )}
        </>
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

      {!hasPresetRoster && (
        <Link href="/admin/session/new" className="block text-center text-sm text-gray-500">
          Muốn dán danh sách từ nhóm chat? → /admin/session/new
        </Link>
      )}
    </main>
  );
}
