'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from '@/lib/use-session';
import { todaySessionId } from '@/lib/session-id';
import { writeFetch } from '@/lib/client-code';
import { useActor, setActor as saveActor } from '@/lib/client-identity';
import { computeQueue } from '@/lib/session-view';
import type { Suggestion } from '@/lib/types';

const MODES = ['OFF', 'RECORD', 'ASSIGN'] as const;
type Mode = (typeof MODES)[number];

const UNDO_WINDOW_MS = 60_000;
const STALE_MS = 15_000;

type PickerCtx = { courtIdx: number; viaSwap: boolean; suggestion: Suggestion | null };

export default function Home() {
  const sessionId = todaySessionId();
  const { session, loading, lastUpdateAt } = useSession(sessionId);

  const actor = useActor();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [pickerCtx, setPickerCtx] = useState<PickerCtx | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestForm, setGuestForm] = useState<{ name: string; gender: 'M' | 'F' }>({ name: '', gender: 'M' });
  const [lastAction, setLastAction] = useState<{ auditLogId: string; at: number } | null>(null);
  const [busy, setBusy] = useState(false);

  // Gợi ý ASSIGN mode, theo sân. undefined = chưa tải xong; null = thuật
  // toán không tìm được (chưa đủ người) — xem ARCHITECTURE.md §7.
  const [suggestions, setSuggestions] = useState<Record<number, Suggestion | null>>({});
  const suggestionFetchedRef = useRef<Set<number>>(new Set());

  function invalidateSuggestion(courtIdx: number) {
    suggestionFetchedRef.current.delete(courtIdx);
    setSuggestions(prev => {
      if (!(courtIdx in prev)) return prev;
      const next = { ...prev };
      delete next[courtIdx];
      return next;
    });
  }

  // Tự tải gợi ý cho MỌI sân trống khi mode = ASSIGN. Bảo vệ bằng ref
  // (không phải setState đồng bộ trong effect) nên không fetch lặp lại
  // — chỉ fetch lại khi invalidateSuggestion() được gọi (409, sau khi
  // Nhận sân/Đổi thành công, hoặc sân vừa trống lại sau một trận).
  useEffect(() => {
    if (!session || session.mode !== 'ASSIGN') return;
    const empties = session.courts.filter(c => !c.gameId).map(c => c.idx);
    for (const idx of empties) {
      if (suggestionFetchedRef.current.has(idx)) continue;
      suggestionFetchedRef.current.add(idx);
      fetch(`/api/session/${sessionId}/suggest?court=${idx}`)
        .then(res => res.json())
        .then(body => setSuggestions(prev => ({ ...prev, [idx]: body.suggestion ?? null })))
        .catch(() => setSuggestions(prev => ({ ...prev, [idx]: null })));
    }
  }, [session, sessionId]);

  const stale = lastUpdateAt !== null && now - lastUpdateAt > STALE_MS;

  const availablePlayers = useMemo(() => {
    if (!session) return [];
    return Object.values(session.players)
      .filter(p => session.attendance[p.id]?.status === 'AVAILABLE')
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [session]);

  // Tầng 1 (cổng) THẬT — dùng lại buildQueue() thuần, không dựng lại logic.
  const queue = useMemo(() => (session ? computeQueue(session, now) : []), [session, now]);

  async function changeMode(mode: Mode) {
    await writeFetch(`/api/session/${sessionId}/mode`, { method: 'POST', body: JSON.stringify({ mode }) });
  }

  function togglePick(id: string) {
    setPickHint(null);
    setPicked(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 4) return prev;
      return [...prev, id];
    });
  }

  function openPicker(courtIdx: number, viaSwap: boolean) {
    setPickerCtx({ courtIdx, viaSwap, suggestion: viaSwap ? (suggestions[courtIdx] ?? null) : null });
    setPicked([]);
    setPickHint(null);
  }

  // Dùng chung cho "Bắt đầu sân" thủ công (RECORD) VÀ "Đổi" (ASSIGN).
  // accepted:false CHỈ khi đi qua Đổi — đây là điểm số thật của thuật
  // toán (xem PROMPT.md "MEASUREMENT").
  async function confirmPick() {
    if (!pickerCtx || picked.length !== 4 || busy || !actor) return;
    const { courtIdx, viaSwap, suggestion } = pickerCtx;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          courtIdx,
          four: picked,
          teamA: picked.slice(0, 2),
          teamB: picked.slice(2, 4),
          accepted: !viaSwap,
          assignedByApp: viaSwap,
          suggested: viaSwap ? suggestion?.four : undefined,
          reason: viaSwap ? suggestion?.reason : undefined,
          actor: actor.name,
        }),
      });
      if (res.ok) {
        setPickerCtx(null);
        setPicked([]);
        invalidateSuggestion(courtIdx);
      } else if (res.status === 409) {
        // Bình thường — sân khác vừa lấy trùng người. Chọn lại.
        setPicked([]);
        setPickHint('Vài người vừa được xếp sân khác — chọn lại.');
        invalidateSuggestion(courtIdx);
      }
    } finally {
      setBusy(false);
    }
  }

  // "Nhận sân" — chấp nhận gợi ý nguyên vẹn, một chạm, không cần chọn lại.
  async function takeSuggested(courtIdx: number) {
    const suggestion = suggestions[courtIdx];
    if (!suggestion || busy || !actor) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          courtIdx,
          four: suggestion.four,
          teamA: suggestion.teamA,
          teamB: suggestion.teamB,
          predictedProbA: suggestion.predictedProbA,
          accepted: true,
          assignedByApp: true,
          suggested: suggestion.four,
          reason: suggestion.reason,
          actor: actor.name,
        }),
      });
      if (!res.ok) invalidateSuggestion(courtIdx); // 409 — người vừa bị lấy chỗ khác, tải gợi ý mới
    } finally {
      setBusy(false);
    }
  }

  async function recordWinner(courtIdx: number, gameId: string, winner: 'A' | 'B') {
    if (busy || !actor) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/result`, {
        method: 'POST',
        body: JSON.stringify({ gameId, courtIdx, winner, actor: actor.name }),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.auditLogId) setLastAction({ auditLogId: body.auditLogId, at: Date.now() });
        invalidateSuggestion(courtIdx); // sân vừa trống lại — gợi ý cũ (nếu có) đã lỗi thời
      }
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!lastAction || busy) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/undo`, {
        method: 'POST',
        body: JSON.stringify({ auditLogId: lastAction.auditLogId }),
      });
      if (res.ok) setLastAction(null);
    } finally {
      setBusy(false);
    }
  }

  async function addGuest() {
    if (!guestForm.name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/guest`, {
        method: 'POST',
        body: JSON.stringify(guestForm),
      });
      if (res.ok) {
        setGuestOpen(false);
        setGuestForm({ name: '', gender: 'M' });
      }
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!actor || !session || busy) return;
    const cur = session.attendance[actor.id]?.status;
    if (cur !== 'AVAILABLE' && cur !== 'PAUSED') return;
    setBusy(true);
    try {
      await writeFetch(`/api/session/${sessionId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ playerId: actor.id, paused: cur === 'AVAILABLE' }),
      });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="p-4">Đang tải…</main>;

  if (!session) {
    return (
      <main className="mx-auto max-w-md space-y-4 p-4">
        <h1 className="text-2xl font-bold">Badminton Queue</h1>
        <p>Chưa có buổi hôm nay.</p>
        <Link href="/checkin" className="block min-h-[56px] rounded border border-gray-300 px-4 py-3 text-center">
          Check-in trước
        </Link>
      </main>
    );
  }

  // "Mở app → chọn tên → localStorage. Xong." — chỉ hỏi một lần.
  if (!actor) {
    const everyone = Object.values(session.players).sort((a, b) => a.name.localeCompare(b.name));
    return (
      <main className="mx-auto max-w-md space-y-4 p-4">
        <h1 className="text-xl font-bold">Bạn là ai?</h1>
        <div className="grid grid-cols-2 gap-2">
          {everyone.map(p => (
            <button
              key={p.id}
              onClick={() => saveActor({ id: p.id, name: p.name })}
              className="min-h-[56px] rounded border border-gray-300 px-2"
            >
              {p.name}
            </button>
          ))}
          {everyone.length === 0 && <p className="col-span-2 text-sm text-gray-500">Chưa ai check-in hôm nay.</p>}
        </div>
      </main>
    );
  }

  const myStatus = session.attendance[actor.id]?.status;
  const myQueueIdx = queue.findIndex(q => q.id === actor.id);
  const presentCount = Object.values(session.attendance).filter(a => a.status !== 'LEFT').length;
  const clock = new Date(now).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const undoSecondsLeft = lastAction ? Math.max(0, Math.ceil((UNDO_WINDOW_MS - (now - lastAction.at)) / 1000)) : 0;

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{session.courtCount} sân · {presentCount} người</h1>
        <span className="flex items-center gap-2 text-sm text-gray-500">
          {clock}
          <span className={`h-2.5 w-2.5 rounded-full ${stale ? 'bg-red-500' : 'bg-green-500'}`} />
        </span>
      </header>

      {stale && (
        <p className="rounded bg-red-50 p-2 text-center text-sm text-red-700">
          Mất kết nối. Những gì bạn thấy có thể cũ.
        </p>
      )}

      <section className="text-center">
        {myStatus === 'PLAYING' ? (
          <p className="text-3xl font-bold">Đang thi đấu</p>
        ) : myStatus === 'PAUSED' ? (
          <p className="text-3xl font-bold text-gray-500">Đang tạm nghỉ</p>
        ) : myQueueIdx >= 0 ? (
          <>
            <p className="text-lg">Bạn đang xếp thứ {myQueueIdx + 1}</p>
            <p className="text-5xl font-bold">{Math.round(queue[myQueueIdx].waitMs / 60_000)} phút</p>
          </>
        ) : (
          <p className="text-gray-500">Chưa có mặt trong buổi hôm nay</p>
        )}
      </section>

      <div className="flex gap-2">
        {MODES.map(m => (
          <button
            key={m}
            onClick={() => changeMode(m)}
            className={`h-12 flex-1 rounded border font-medium ${
              session.mode === m ? 'border-black bg-black text-white' : 'border-gray-300 bg-white'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <section className="space-y-3">
        {session.courts.map(court => {
          const picking = pickerCtx?.courtIdx === court.idx;
          const suggestion = suggestions[court.idx];

          return (
            <div key={court.idx} className="rounded border border-gray-300 p-3">
              <div className="mb-2 text-sm text-gray-500">Sân {court.idx + 1}</div>

              {court.gameId && court.teamA && court.teamB ? (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={busy || stale}
                    onClick={() => recordWinner(court.idx, court.gameId!, 'A')}
                    className="min-h-[56px] rounded bg-blue-600 px-2 text-white disabled:opacity-50"
                  >
                    {court.teamA.map(id => session.players[id]?.name ?? id).join(' & ')} thắng
                  </button>
                  <button
                    disabled={busy || stale}
                    onClick={() => recordWinner(court.idx, court.gameId!, 'B')}
                    className="min-h-[56px] rounded bg-blue-600 px-2 text-white disabled:opacity-50"
                  >
                    {court.teamB.map(id => session.players[id]?.name ?? id).join(' & ')} thắng
                  </button>
                </div>
              ) : picking ? (
                <div className="space-y-2">
                  <p className="text-sm">
                    Đã chọn {picked.length}/4
                    {picked.length === 4 && (
                      <>
                        {' '}— Đội A: {picked.slice(0, 2).map(id => session.players[id]?.name).join(' & ')}
                        {' '}· Đội B: {picked.slice(2, 4).map(id => session.players[id]?.name).join(' & ')}
                      </>
                    )}
                  </p>
                  {pickHint && <p className="text-sm text-red-600">{pickHint}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    {availablePlayers.map(p => {
                      const on = picked.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          onClick={() => togglePick(p.id)}
                          className={`min-h-[48px] rounded border px-2 text-left text-sm ${
                            on ? 'border-black bg-black text-white' : 'border-gray-300 bg-white'
                          }`}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button
                      disabled={picked.length !== 4 || busy || stale}
                      onClick={confirmPick}
                      className="min-h-[56px] flex-1 rounded bg-green-600 text-white disabled:opacity-50"
                    >
                      Xác nhận
                    </button>
                    <button
                      onClick={() => { setPickerCtx(null); setPicked([]); setPickHint(null); }}
                      className="min-h-[56px] rounded border border-gray-300 px-4"
                    >
                      Huỷ
                    </button>
                  </div>
                </div>
              ) : session.mode === 'OFF' ? (
                <p className="py-4 text-center text-sm text-gray-400">Chế độ TẮT — tự chia sân, app không ghi nhận.</p>
              ) : session.mode === 'RECORD' ? (
                <button
                  disabled={stale}
                  onClick={() => openPicker(court.idx, false)}
                  className="min-h-[56px] w-full rounded border border-dashed border-gray-400 text-gray-600 disabled:opacity-50"
                >
                  Bắt đầu sân
                </button>
              ) : suggestion === undefined ? (
                <p className="py-4 text-center text-sm text-gray-400">Đang tìm gợi ý…</p>
              ) : suggestion === null ? (
                <p className="py-4 text-center text-sm text-gray-400">Chưa đủ người — chờ sân khác.</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase text-gray-400">Gợi ý</p>
                  <p className="font-medium">
                    {suggestion.teamA.map(id => session.players[id]?.name ?? id).join(' & ')}
                    {' vs '}
                    {suggestion.teamB.map(id => session.players[id]?.name ?? id).join(' & ')}
                  </p>
                  {/* CÂU GIẢI THÍCH — luôn hiện, không bao giờ giấu. */}
                  <p className="text-sm text-gray-600">{suggestion.reason}</p>
                  <div className="flex gap-2">
                    <button
                      disabled={busy || stale}
                      onClick={() => takeSuggested(court.idx)}
                      className="min-h-[56px] flex-[2] rounded bg-green-600 text-white disabled:opacity-50"
                    >
                      Nhận sân
                    </button>
                    <button
                      disabled={stale}
                      onClick={() => openPicker(court.idx, true)}
                      className="min-h-[56px] flex-1 rounded border border-gray-300 disabled:opacity-50"
                    >
                      Đổi
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-500">Hàng chờ · {queue.length} người</h2>
        <ul className="space-y-1">
          {queue.map((q, i) => {
            const mine = q.id === actor.id;
            return (
              <li
                key={q.id}
                className={`flex items-center justify-between rounded px-3 py-2 ${mine ? 'bg-black text-white' : 'bg-gray-50'}`}
              >
                <span>{i + 1}. {session.players[q.id]?.name ?? q.id}{mine ? ' (Bạn)' : ''}</span>
                <span className="text-sm">{Math.round(q.waitMs / 60_000)} phút · {q.games} trận</span>
              </li>
            );
          })}
          {queue.length === 0 && <li className="text-sm text-gray-500">Không ai đang chờ.</li>}
        </ul>
      </section>

      <section>
        {guestOpen ? (
          <div className="flex flex-wrap items-end gap-2 rounded border border-gray-300 p-3">
            <input
              value={guestForm.name}
              onChange={e => setGuestForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Tên khách"
              className="h-14 min-w-[10rem] rounded border border-gray-300 px-3"
            />
            <select
              value={guestForm.gender}
              onChange={e => setGuestForm(f => ({ ...f, gender: e.target.value as 'M' | 'F' }))}
              className="h-14 rounded border border-gray-300 px-3"
            >
              <option value="M">Nam</option>
              <option value="F">Nữ</option>
            </select>
            <button onClick={addGuest} disabled={busy} className="h-14 rounded bg-black px-4 text-white disabled:opacity-50">
              Thêm
            </button>
            <button onClick={() => setGuestOpen(false)} className="h-14 rounded border border-gray-300 px-4">
              Huỷ
            </button>
          </div>
        ) : (
          <button onClick={() => setGuestOpen(true)} className="min-h-[56px] w-full rounded border border-gray-300 text-gray-600">
            + Thêm khách
          </button>
        )}
      </section>

      <footer className="flex items-center justify-center gap-6 text-sm text-gray-500">
        <button
          onClick={togglePause}
          disabled={busy || (myStatus !== 'AVAILABLE' && myStatus !== 'PAUSED')}
          className="min-h-[44px] disabled:opacity-40"
        >
          {myStatus === 'PAUSED' ? 'Quay lại chơi' : 'Tạm nghỉ'}
        </button>
        <button onClick={() => changeMode('RECORD')} className="min-h-[44px]">Xếp tay</button>
      </footer>

      <Link href="/admin/players" className="block text-center text-sm text-gray-500">
        /admin/players
      </Link>

      {lastAction && undoSecondsLeft > 0 && (
        <div className="fixed inset-x-0 bottom-0 flex items-center justify-between bg-black p-4 text-white">
          <span>Đã ghi kết quả · {undoSecondsLeft}s</span>
          <button onClick={undo} disabled={busy} className="min-h-[44px] rounded bg-white px-4 text-black disabled:opacity-50">
            Hoàn tác
          </button>
        </div>
      )}
    </main>
  );
}
