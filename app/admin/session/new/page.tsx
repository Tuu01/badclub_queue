'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePlayers } from '@/lib/use-players';
import { writeFetch } from '@/lib/client-code';
import { todaySessionId } from '@/lib/session-id';
import { estimateSession, safeHeadcount } from '@/lib/session-estimate';
import { matchPastedNames, type MatchedLine } from '@/lib/fuzzy-match';

export default function NewSessionPage() {
  const { players, loading } = usePlayers();
  const active = useMemo(() => players.filter(p => p.active), [players]);

  const [step, setStep] = useState<1 | 2>(1);
  const [courts, setCourts] = useState(3);
  const [headcount, setHeadcount] = useState(22);
  const estimate = estimateSession(courts, headcount);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pasteText, setPasteText] = useState('');
  const [matches, setMatches] = useState<MatchedLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function runMatch() {
    const results = matchPastedNames(pasteText, active.map(p => ({ id: p.id, name: p.name })));
    setMatches(results);
    setSelected(prev => {
      const next = new Set(prev);
      for (const r of results) if (r.best) next.add(r.best.id);
      return next;
    });
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Sắp theo LÂU CHƯA ĐẾN — không phải xếp hạng, không phán xét lý do
  // (xem PROMPT.md: "NO ⚠️, no red"). Chưa từng chơi (lastPlayedAt=null)
  // đứng đầu — lâu nhất có thể tưởng tượng được.
  const notSelected = useMemo(
    () =>
      active
        .filter(p => !selected.has(p.id))
        .sort((a, b) => (a.lastPlayedAt ?? -Infinity) - (b.lastPlayedAt ?? -Infinity)),
    [active, selected],
  );

  const selectedList = useMemo(
    () => active.filter(p => selected.has(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [active, selected],
  );

  async function confirm() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const sessionId = todaySessionId();
      const res = await writeFetch(`/api/session/${sessionId}/roster`, {
        method: 'POST',
        body: JSON.stringify({ courtCount: courts, playerIds: [...selected] }),
      });
      if (res.ok) {
        setMessage(`Đã chốt ${selected.size} người cho buổi ${sessionId}. Sang /checkin để điểm danh ai có mặt.`);
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Lỗi: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="p-4">Đang tải…</main>;

  if (step === 1) {
    return (
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <h1 className="text-2xl font-bold">Buổi mới — Bước 1</h1>

        <div className="flex items-center gap-3">
          <label className="w-28 text-sm">Số sân</label>
          <input
            type="number" min={1} max={8} value={courts}
            onChange={e => setCourts(Math.max(1, Number(e.target.value) || 1))}
            className="h-14 w-24 rounded border border-gray-300 px-3 text-lg"
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="w-28 text-sm">Số người dự kiến</label>
          <input
            type="number" min={1} value={headcount}
            onChange={e => setHeadcount(Math.max(1, Number(e.target.value) || 1))}
            className="h-14 w-24 rounded border border-gray-300 px-3 text-lg"
          />
        </div>

        {estimate && (
          <div className="rounded border border-gray-300 p-3 text-sm">
            <p>
              ~{estimate.gamesPerPerson.toFixed(1)} trận/người · ngồi ngoài{' '}
              {Math.round(estimate.sittingOutFraction * 100)}% thời gian
            </p>
            {estimate.poolTooSmall && (
              <p className="mt-2 text-amber-700">
                Chỉ {estimate.pool} người ngồi ngoài cùng lúc — thuật toán mất khả năng trộn người,
                gần như xếp thuần theo thứ tự chờ. An toàn: từ {safeHeadcount(courts)} người trở lên
                với {courts} sân.
              </p>
            )}
          </div>
        )}

        <button onClick={() => setStep(2)} className="min-h-[56px] w-full rounded bg-black text-white">
          Tiếp tục
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="text-2xl font-bold">Buổi mới — Bước 2</h1>
      <p className="text-sm text-gray-500">{courts} sân · mục tiêu {headcount} người</p>

      <div className="space-y-2">
        <label className="text-sm font-medium">Dán danh sách từ nhóm chat</label>
        <textarea
          value={pasteText}
          onChange={e => setPasteText(e.target.value)}
          rows={6}
          placeholder={'Cường\nHà\nLan\n...'}
          className="w-full rounded border border-gray-300 p-3"
        />
        <button onClick={runMatch} className="min-h-[48px] rounded bg-black px-4 text-white">
          Ghép tên
        </button>
      </div>

      {matches && (
        <div className="space-y-2 rounded border border-gray-300 p-3">
          <p className="text-sm font-medium">
            Kết quả ghép ({matches.filter(m => m.best).length}/{matches.length} khớp)
          </p>
          <ul className="space-y-1 text-sm">
            {matches.map((m, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>{m.raw}</span>
                {m.best ? (
                  <span className={selected.has(m.best.id) ? 'text-green-700' : 'text-gray-400'}>
                    → {m.best.name}
                  </span>
                ) : (
                  <span className="text-gray-400">không khớp</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold">Đã chọn · {selectedList.length} người</h2>
        <div className="grid grid-cols-2 gap-2">
          {selectedList.map(p => (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className="min-h-[48px] rounded border border-black bg-black px-2 text-left text-sm text-white"
            >
              {p.name}
            </button>
          ))}
          {selectedList.length === 0 && <p className="col-span-2 text-sm text-gray-500">Chưa chọn ai.</p>}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-500">Chưa chọn · sắp theo lâu chưa đến</h2>
        <div className="grid grid-cols-2 gap-2">
          {notSelected.map(p => (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className="min-h-[48px] rounded border border-gray-300 px-2 text-left text-sm"
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setStep(1)} className="min-h-[56px] rounded border border-gray-300 px-4">
          Quay lại
        </button>
        <button
          disabled={selected.size === 0 || busy}
          onClick={confirm}
          className="min-h-[56px] flex-1 rounded bg-green-600 text-white disabled:opacity-50"
        >
          Chốt {selected.size} người
        </button>
      </div>

      {message && <p className="text-center text-sm">{message}</p>}
      <Link href="/checkin" className="block text-center text-sm text-gray-500">Sang /checkin để điểm danh</Link>
    </main>
  );
}
