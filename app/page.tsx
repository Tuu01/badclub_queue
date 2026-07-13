'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useActiveSession } from '@/lib/use-active-session';
import { writeFetch } from '@/lib/client-code';
import { useActor, setActor as saveActor } from '@/lib/client-identity';
import { computeQueue } from '@/lib/session-view';
import type { PlayerId, Suggestion } from '@/lib/types';
import { CourtDiagram } from './CourtDiagram';

const MODES = ['OFF', 'RECORD', 'ASSIGN'] as const;
type Mode = (typeof MODES)[number];

const UNDO_WINDOW_MS = 60_000;
const RECONNECT_MS = 5_000;
const OFFLINE_MS = 15_000;
const TAP = 'transition-transform duration-75 active:scale-[0.98]';

type PickerCtx = { courtIdx: number; viaSwap: boolean; suggestion: Suggestion | null };
type SwapCtx = { courtIdx: number; outId: PlayerId; outName: string };

function ordinalSuffix(n: number): string {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

function ConnectionDot({ state }: { state: 'live' | 'reconnecting' | 'offline' }) {
  const color = state === 'live' ? 'bg-live' : state === 'reconnecting' ? 'bg-line-400' : 'bg-signal';
  return <span className={`inline-block h-[7px] w-[7px] rounded-full ${color}`} />;
}

function formatPlayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

function AdminLink() {
  return (
    <Link href="/admin" className="block px-4 py-6 text-center text-[13px] text-line-700">
      Admin
    </Link>
  );
}

// Anyone can pause anyone (UC-14 — "she's in the toilet, she can't
// pause herself"). Leaving needs a tap here too (UC-13), but on its
// own row so a stray tap can't send someone home by mistake.
function PlayerActionRow({
  busy, pauseLabel, onPause, onLeave, onCancel,
}: {
  busy: boolean;
  pauseLabel: string;
  onPause: () => void;
  onLeave: () => void;
  onCancel: () => void;
}) {
  const TAP_LOCAL = 'transition-transform duration-75 active:scale-[0.98]';
  return (
    <div className="flex gap-2 bg-court-800 px-4 py-2">
      <button
        type="button"
        disabled={busy}
        onClick={onPause}
        className={`min-h-[40px] flex-1 rounded-lg border border-line-700 text-[14px] font-medium text-line-000 disabled:opacity-40 ${TAP_LOCAL}`}
      >
        {pauseLabel}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onLeave}
        className={`min-h-[40px] flex-1 rounded-lg border border-line-700 text-[14px] font-medium text-line-400 disabled:opacity-40 ${TAP_LOCAL}`}
      >
        Left
      </button>
      <button
        type="button"
        onClick={onCancel}
        className={`min-h-[40px] rounded-lg border border-line-700 px-3 text-[14px] font-medium text-line-700 ${TAP_LOCAL}`}
      >
        Cancel
      </button>
    </div>
  );
}

export default function Home() {
  const { session, loading, online, liveConflict } = useActiveSession();
  const sessionId = session?.id ?? '';

  const actor = useActor();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);

  const [pickerCtx, setPickerCtx] = useState<PickerCtx | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [swapCtx, setSwapCtx] = useState<SwapCtx | null>(null);
  const [swapHint, setSwapHint] = useState<string | null>(null);
  const [pausedConfirmId, setPausedConfirmId] = useState<PlayerId | null>(null);
  const [playerActionId, setPlayerActionId] = useState<PlayerId | null>(null);
  const [lastAction, setLastAction] = useState<{ auditLogId: string; at: number } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ASSIGN-mode suggestions, keyed by court. undefined = still loading;
  // null = the algorithm couldn't find one (not enough people) — see
  // ARCHITECTURE.md §7.
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

  // Auto-fetches a suggestion for EVERY empty court while mode = ASSIGN.
  // Guarded with a ref (not synchronous setState in the effect body),
  // so it never refetches redundantly — only refetches when
  // invalidateSuggestion() is called (409, after a successful Take
  // court/Swap, or a court just freed up after a game).
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

  // Latches the moment `online` first flips false, so a real outage
  // gets the "reconnecting" then "offline" grace period UC-10 wants —
  // but recovers to 'live' the instant online flips back true, no
  // lingering delay. Adjusted DURING RENDER (React's documented
  // pattern for "sync from an external value," same as the DRAFT
  // pre-fill in /admin/session/new) rather than in a useEffect or a
  // ref read, both of which react-hooks/* now flags directly.
  if (online && offlineSince !== null) {
    setOfflineSince(null);
  } else if (!online && offlineSince === null) {
    setOfflineSince(now);
  }
  const sinceOffline = offlineSince !== null ? now - offlineSince : 0;
  const connection: 'live' | 'reconnecting' | 'offline' =
    offlineSince === null ? 'live' : sinceOffline > OFFLINE_MS ? 'offline' : sinceOffline > RECONNECT_MS ? 'reconnecting' : 'live';
  const stale = connection === 'offline';

  const availablePlayers = useMemo(() => {
    if (!session) return [];
    return Object.values(session.players)
      .filter(p => session.attendance[p.id]?.status === 'AVAILABLE')
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [session]);

  const pausedPlayers = useMemo(() => {
    if (!session) return [];
    return Object.values(session.players)
      .filter(p => session.attendance[p.id]?.status === 'PAUSED')
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [session]);

  // The REAL tier-1 gate — reuses buildQueue() as-is, no reimplemented logic.
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

  // Shared by manual "Start court" (RECORD) AND "Swap" (ASSIGN).
  // accepted:false ONLY when it went through Swap — this is the
  // algorithm's real score (see PROMPT.md "MEASUREMENT").
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
        // Normal — another court just grabbed the same person. Pick again.
        setPicked([]);
        setPickHint('A few people were just assigned to another court — pick again.');
        invalidateSuggestion(courtIdx);
      }
    } finally {
      setBusy(false);
    }
  }

  // Swap ONE player on a court that's ALREADY IN PLAY (UC-1). Distinct
  // from pickerCtx/viaSwap above, which replaces a suggestion BEFORE a
  // game exists. This never rebalances teams — same slot, in or out.
  function openSwapPicker(courtIdx: number, outId: PlayerId, outName: string) {
    setSwapCtx({ courtIdx, outId, outName });
    setSwapHint(null);
    setPausedConfirmId(null);
  }

  async function doSwap(inId: PlayerId) {
    if (!swapCtx || busy || !actor) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/swap`, {
        method: 'POST',
        body: JSON.stringify({ courtIdx: swapCtx.courtIdx, outId: swapCtx.outId, inId, actor: actor.name }),
      });
      if (res.ok) {
        setSwapCtx(null);
        setPausedConfirmId(null);
      } else if (res.status === 409) {
        // Normal — someone else just grabbed inId. Not an error.
        setPausedConfirmId(null);
        setSwapHint('That person was just taken elsewhere — pick someone else.');
      } else {
        const errBody = await res.json().catch(() => null);
        setSwapHint(errBody?.error ?? 'Could not swap — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  // "Take court" — accepts the suggestion as-is, one tap, no re-picking.
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
      if (!res.ok) invalidateSuggestion(courtIdx); // 409 — someone was just taken elsewhere, fetch a fresh suggestion
    } finally {
      setBusy(false);
    }
  }

  async function recordWinner(courtIdx: number, gameId: string, winner: 'A' | 'B' | null) {
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
        invalidateSuggestion(courtIdx); // court just freed up — any old suggestion is stale
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

  // UC-14 — anyone can pause anyone, one tap, no confirmation. Shared
  // by the footer "Pause me" button and the queue's per-row action row.
  async function doPauseFor(playerId: PlayerId, paused: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ playerId, paused }),
      });
      if (res.ok) setPlayerActionId(null);
    } finally {
      setBusy(false);
    }
  }

  // UC-13 — one-directional. gamesToday is preserved, not reset.
  async function doLeaveFor(playerId: PlayerId) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/leave`, {
        method: 'POST',
        body: JSON.stringify({ playerId }),
      });
      if (res.ok) setPlayerActionId(null);
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!actor || !session || busy) return;
    const cur = session.attendance[actor.id]?.status;
    if (cur !== 'AVAILABLE' && cur !== 'PAUSED') return;
    await doPauseFor(actor.id, cur === 'AVAILABLE');
  }

  async function startSession() {
    if (!session || busy) return;
    setBusy(true);
    setStartError(null);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/start`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setStartError(body?.error ?? `Could not start session (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Loading…</main>;
  }

  // Never silently pick one — see lib/use-active-session.ts. This
  // takes priority over every other screen below.
  if (liveConflict) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center">
        <p className="font-display text-2xl text-signal" style={{ fontStretch: '115%' }}>
          ⚠ Two sessions are live.
        </p>
        <p className="text-line-400">This is a bug. Tell the admin.</p>
        <ul className="text-[13px] text-line-400">
          {liveConflict.map(s => <li key={s.id}>{s.date}</li>)}
        </ul>
        <Link href="/admin/sessions" className="text-[13px] text-line-000 underline">
          Go to /admin/sessions to end one
        </Link>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="flex min-h-dvh flex-col bg-court-900 px-4 text-center">
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="font-display text-2xl text-line-000" style={{ fontStretch: '115%' }}>Badminton Queue</p>
          <p className="text-line-400">No session yet.</p>
        </div>
        <AdminLink />
      </main>
    );
  }

  if (session.status === 'DRAFT') {
    return (
      <main className="flex min-h-dvh flex-col bg-court-900 px-4 text-center">
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-[13px] text-line-400">Next session</p>
          <p className="font-display text-2xl text-line-000" style={{ fontStretch: '115%' }}>
            {formatPlayDate(session.date)} · {session.targetHeadcount} players
          </p>
          <button
            disabled={busy}
            onClick={startSession}
            className={`mt-3 flex min-h-[56px] w-full max-w-xs items-center justify-center rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
          >
            Start session
          </button>
          {startError && <p className="mt-3 max-w-xs text-[13px] text-signal">{startError}</p>}
        </div>
        <AdminLink />
      </main>
    );
  }

  // status === 'LIVE' from here.
  const presentCount = Object.values(session.attendance).filter(a => a.status !== 'LEFT').length;

  // Empty state: nobody checked in yet — check-in IS the screen, not a footer action.
  if (presentCount === 0) {
    return (
      <main className="flex min-h-dvh flex-col bg-court-900 px-4 text-center">
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-line-400">Nobody&apos;s checked in yet</p>
          <Link
            href="/checkin"
            className={`flex min-h-[56px] w-full max-w-xs items-center justify-center rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 ${TAP}`}
          >
            Check people in
          </Link>
        </div>
        <AdminLink />
      </main>
    );
  }

  // "Open the app → pick your name → localStorage. Done." — only asked once.
  if (!actor) {
    const everyone = Object.values(session.players).sort((a, b) => a.name.localeCompare(b.name));
    return (
      <main className="flex min-h-dvh flex-col bg-court-900 px-4 py-6">
        <p className="mb-4 font-display text-xl text-line-000" style={{ fontStretch: '115%' }}>Who are you?</p>
        <div className="grid flex-1 grid-cols-2 content-start gap-2">
          {everyone.map(p => (
            <button
              key={p.id}
              onClick={() => saveActor({ id: p.id, name: p.name })}
              className={`min-h-[56px] rounded-xl border border-line-700 px-3 font-display text-[17px] text-line-000 ${TAP}`}
              style={{ fontStretch: '105%' }}
            >
              {p.name}
            </button>
          ))}
          {everyone.length === 0 && <p className="col-span-2 text-line-400">Nobody has checked in today yet.</p>}
        </div>
        <AdminLink />
      </main>
    );
  }

  const myStatus = session.attendance[actor.id]?.status;
  const myQueueIdx = queue.findIndex(q => q.id === actor.id);
  const clock = new Date(now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const undoSecondsLeft = lastAction ? Math.max(0, Math.ceil((UNDO_WINDOW_MS - (now - lastAction.at)) / 1000)) : 0;

  return (
    <main className="min-h-dvh bg-court-900 pb-28 text-line-000">
      {/* status bar */}
      <header className="flex h-11 items-center justify-between px-4 text-[13px] text-line-400">
        <span>{session.courtCount} courts · {presentCount} people</span>
        <span className="tabular flex items-center gap-2">
          {clock}
          <ConnectionDot state={connection} />
        </span>
      </header>

      {stale && (
        <p className="px-4 pb-2 text-[13px] text-signal">Offline. What you&apos;re seeing is stale.</p>
      )}

      {/* hero */}
      <section className="flex flex-col items-center gap-1 px-4 py-6 text-center">
        {myStatus === 'PLAYING' ? (
          <p className="font-display text-[32px] font-medium text-line-000" style={{ fontStretch: '120%' }}>Playing</p>
        ) : myStatus === 'PAUSED' ? (
          <p className="font-display text-[32px] font-medium text-line-400" style={{ fontStretch: '120%' }}>Paused</p>
        ) : myQueueIdx >= 0 ? (
          <>
            <p className="text-[11px] font-medium text-line-400">
              you&apos;re {myQueueIdx + 1}{ordinalSuffix(myQueueIdx + 1)} in line
            </p>
            <p className="tabular font-display text-[44px] font-medium text-line-000" style={{ fontStretch: '120%' }}>
              {Math.round(queue[myQueueIdx].waitMs / 60_000)} min
            </p>
          </>
        ) : (
          <p className="text-line-400">Not present in today&apos;s session</p>
        )}
      </section>

      <div className="mx-4 border-t border-line-700" />

      {/* mode switch — first-class, always visible */}
      <div className="flex gap-px px-4 py-3">
        {MODES.map(m => (
          <button
            key={m}
            onClick={() => changeMode(m)}
            className={`h-11 flex-1 rounded-lg border text-[16px] font-medium ${TAP} ${
              session.mode === m ? 'border-line-000 bg-line-000 text-court-900' : 'border-line-700 text-line-400'
            }`}
          >
            {m.charAt(0) + m.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {/* courts */}
      <section className="space-y-3 px-4">
        {session.courts.map(court => {
          const picking = pickerCtx?.courtIdx === court.idx;
          const suggestion = suggestions[court.idx];
          const hasSuggestion = session.mode === 'ASSIGN' && !court.gameId && !!suggestion;
          const iAmInIt = !!(court.players && court.players.includes(actor.id));
          const borderClass = iAmInIt ? 'border-signal' : hasSuggestion ? 'border-line-000' : 'border-line-700';

          const teamAnames = court.teamA
            ? (court.teamA.map(id => session.players[id]?.name ?? id) as [string, string])
            : null;
          const teamBnames = court.teamB
            ? (court.teamB.map(id => session.players[id]?.name ?? id) as [string, string])
            : null;

          const elapsedMs = court.startedAt ? now - court.startedAt : 0;
          const elapsedMin = Math.floor(elapsedMs / 60_000);
          const elapsedSec = Math.floor((elapsedMs % 60_000) / 1000);
          const clockBright = elapsedMin >= 22;

          return (
            <div key={court.idx} className={`overflow-hidden rounded-xl border bg-court-800 ${borderClass}`}>
              <div className="flex items-center justify-between px-4 pb-2 pt-3">
                <span className="text-[11px] font-medium text-line-400">
                  {court.gameId ? 'in play' : hasSuggestion ? `court ${court.idx + 1} · suggested` : `court ${court.idx + 1}`}
                </span>
                {court.gameId && court.startedAt && (
                  <span className={`tabular text-[13px] ${clockBright ? 'text-line-000' : 'text-line-400'}`}>
                    {elapsedMin}:{String(elapsedSec).padStart(2, '0')}
                  </span>
                )}
              </div>

              <div className="px-4 pb-3">
                <CourtDiagram teamA={teamAnames} teamB={teamBnames} />
              </div>

              {court.gameId && court.teamA && court.teamB && swapCtx?.courtIdx === court.idx ? (
                <div className="space-y-2 border-t border-line-700 p-4">
                  <p className="text-[13px] text-line-400">Swap out {swapCtx.outName}</p>
                  {swapHint && <p className="text-[13px] text-signal">{swapHint}</p>}

                  {/* D2 priority 1 — AVAILABLE, queue order (fewest games → longest wait). */}
                  <div className="grid grid-cols-2 gap-2">
                    {queue.map(q => (
                      <button
                        key={q.id}
                        disabled={busy || stale}
                        onClick={() => doSwap(q.id)}
                        className={`min-h-[48px] rounded-lg border border-line-700 px-2 text-left font-display text-[17px] text-line-000 disabled:opacity-40 ${TAP}`}
                        style={{ fontStretch: '105%' }}
                      >
                        {session.players[q.id]?.name ?? q.id}
                      </button>
                    ))}
                    {queue.length === 0 && pausedPlayers.length === 0 && (
                      <p className="col-span-2 text-[13px] text-line-400">Nobody else is available.</p>
                    )}
                  </div>

                  {/* D2 priority 2 — PAUSED, greyed, confirm before putting them back on court. */}
                  {pausedPlayers.length > 0 && (
                    <>
                      <p className="pt-2 text-[11px] font-medium text-line-400">paused</p>
                      <div className="grid grid-cols-2 gap-2">
                        {pausedPlayers.map(p =>
                          pausedConfirmId === p.id ? (
                            <div key={p.id} className="col-span-2 space-y-2 rounded-lg border border-line-700 p-2">
                              <p className="text-[13px] text-line-400">{p.name} is paused. Put them on court anyway?</p>
                              <div className="flex gap-2">
                                <button
                                  disabled={busy || stale}
                                  onClick={() => doSwap(p.id)}
                                  className={`min-h-[48px] flex-1 rounded-lg border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                                >
                                  Confirm
                                </button>
                                <button
                                  onClick={() => setPausedConfirmId(null)}
                                  className={`min-h-[48px] rounded-lg border border-line-700 px-4 text-[16px] font-medium text-line-400 ${TAP}`}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              key={p.id}
                              disabled={stale}
                              onClick={() => setPausedConfirmId(p.id)}
                              className={`min-h-[48px] rounded-lg border border-line-700 px-2 text-left font-display text-[17px] text-line-700 disabled:opacity-40 ${TAP}`}
                              style={{ fontStretch: '105%' }}
                            >
                              {p.name}
                            </button>
                          ),
                        )}
                      </div>
                    </>
                  )}

                  <button
                    onClick={() => { setSwapCtx(null); setSwapHint(null); setPausedConfirmId(null); }}
                    className={`min-h-[48px] w-full rounded-lg border border-line-700 text-[16px] font-medium text-line-400 ${TAP}`}
                  >
                    Cancel
                  </button>
                </div>
              ) : court.gameId && court.teamA && court.teamB ? (
                <>
                  {/* UC-1 — tap a name to swap someone in for them, mid-match. */}
                  <div className="flex gap-1 border-t border-line-700 px-3 py-2">
                    {[...court.teamA, ...court.teamB].map(id => (
                      <button
                        key={id}
                        disabled={busy || stale}
                        onClick={() => openSwapPicker(court.idx, id, session.players[id]?.name ?? id)}
                        className={`min-h-[32px] flex-1 rounded-md border border-line-700 px-1 text-[12px] text-line-400 disabled:opacity-40 ${TAP}`}
                      >
                        {session.players[id]?.name ?? id}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 border-t border-line-700">
                    <button
                      disabled={busy || stale}
                      onClick={() => recordWinner(court.idx, court.gameId!, 'A')}
                      className={`min-h-[56px] border-r border-line-700 px-2 text-[16px] font-medium text-line-000 disabled:opacity-40 active:bg-court-700 ${TAP}`}
                    >
                      {court.teamA.map(id => session.players[id]?.name ?? id).join(' & ')} won
                    </button>
                    <button
                      disabled={busy || stale}
                      onClick={() => recordWinner(court.idx, court.gameId!, 'B')}
                      className={`min-h-[56px] px-2 text-[16px] font-medium text-line-000 disabled:opacity-40 active:bg-court-700 ${TAP}`}
                    >
                      {court.teamB.map(id => session.players[id]?.name ?? id).join(' & ')} won
                    </button>
                  </div>
                  {/* UC-7a — free the court without a winner. Queue-urgent,
                      rating-not-urgent: see recordResult() in lib/firestore.ts. */}
                  <button
                    disabled={busy || stale}
                    onClick={() => recordWinner(court.idx, court.gameId!, null)}
                    className={`min-h-[36px] w-full border-t border-line-700 text-[12px] text-line-700 disabled:opacity-40 ${TAP}`}
                  >
                    Not sure who won — free the court
                  </button>
                </>
              ) : picking ? (
                <div className="space-y-2 border-t border-line-700 p-4">
                  <p className="text-[13px] text-line-400">
                    Picked {picked.length}/4
                    {picked.length === 4 && (
                      <>
                        {' '}— Team A: {picked.slice(0, 2).map(id => session.players[id]?.name).join(' & ')}
                        {' '}· Team B: {picked.slice(2, 4).map(id => session.players[id]?.name).join(' & ')}
                      </>
                    )}
                  </p>
                  {pickHint && <p className="text-[13px] text-signal">{pickHint}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    {availablePlayers.map(p => {
                      const on = picked.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          onClick={() => togglePick(p.id)}
                          className={`min-h-[48px] rounded-lg border px-2 text-left font-display text-[17px] ${TAP} ${
                            on ? 'border-line-000 bg-line-000 text-court-900' : 'border-line-700 text-line-000'
                          }`}
                          style={{ fontStretch: '105%' }}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      disabled={picked.length !== 4 || busy || stale}
                      onClick={confirmPick}
                      className={`min-h-[56px] flex-1 rounded-lg border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => { setPickerCtx(null); setPicked([]); setPickHint(null); }}
                      className={`min-h-[56px] rounded-lg border border-line-700 px-4 text-[16px] font-medium text-line-400 ${TAP}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : session.mode === 'OFF' ? (
                <p className="border-t border-line-700 py-4 text-center text-[13px] text-line-400">
                  Teams picked by hand — not tracked.
                </p>
              ) : session.mode === 'RECORD' ? (
                <button
                  disabled={stale}
                  onClick={() => openPicker(court.idx, false)}
                  className={`min-h-[56px] w-full border-t border-line-700 text-[16px] font-medium text-line-400 disabled:opacity-40 ${TAP}`}
                >
                  Start court
                </button>
              ) : suggestion === undefined ? (
                <p className="border-t border-line-700 py-4 text-center text-[13px] text-line-400">Finding a suggestion…</p>
              ) : suggestion === null ? (
                <p className="border-t border-line-700 py-4 text-center text-[13px] text-line-400">Waiting for a court</p>
              ) : (
                <div className="border-t border-line-700">
                  {/* THE REASON SENTENCE — always shown, never hidden. */}
                  <p className="px-4 pt-3 text-[13px] text-line-400">{suggestion.reason}</p>
                  <div className="mt-3 flex border-t border-line-700">
                    <button
                      disabled={busy || stale}
                      onClick={() => takeSuggested(court.idx)}
                      className={`min-h-[56px] flex-[2] border-r border-line-700 text-[16px] font-medium text-line-000 disabled:opacity-40 active:bg-court-700 ${TAP}`}
                    >
                      Take court
                    </button>
                    <button
                      disabled={stale}
                      onClick={() => openPicker(court.idx, true)}
                      className={`min-h-[56px] flex-1 text-[16px] font-medium text-line-400 disabled:opacity-40 active:bg-court-700 ${TAP}`}
                    >
                      Swap
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* queue — tap anyone → Pause / Left. No permission, no confirmation
          for pause; Left needs one (see the action row below). UC-13/UC-14. */}
      <section className="mt-6">
        <p className="px-4 pb-2 text-[11px] font-medium text-line-400">queue · {queue.length} people</p>
        <ul>
          {queue.map((q, i) => {
            const mine = q.id === actor.id;
            const open = playerActionId === q.id;
            return (
              <li key={q.id}>
                <button
                  type="button"
                  disabled={stale}
                  onClick={() => setPlayerActionId(open ? null : q.id)}
                  className={`flex w-full items-center justify-between px-4 py-2.5 text-left disabled:opacity-40 ${mine ? 'bg-signal-dim' : ''}`}
                >
                  <span
                    className={`font-display text-[17px] ${mine ? 'text-signal' : 'text-line-000'}`}
                    style={{ fontStretch: '105%' }}
                  >
                    {i + 1}&nbsp;&nbsp;{session.players[q.id]?.name ?? q.id}
                  </span>
                  <span className={`tabular text-[13px] ${mine ? 'text-signal' : 'text-line-400'}`}>
                    {Math.round(q.waitMs / 60_000)} min · {q.games}
                  </span>
                </button>
                {open && (
                  <PlayerActionRow
                    busy={busy}
                    onPause={() => doPauseFor(q.id, true)}
                    onLeave={() => doLeaveFor(q.id)}
                    onCancel={() => setPlayerActionId(null)}
                    pauseLabel="Pause"
                  />
                )}
              </li>
            );
          })}
          {pausedPlayers.map(p => {
            const open = playerActionId === p.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={stale}
                  onClick={() => setPlayerActionId(open ? null : p.id)}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-line-400 disabled:opacity-40"
                >
                  <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>{p.name}</span>
                  <span className="text-[13px]">paused</span>
                </button>
                {open && (
                  <PlayerActionRow
                    busy={busy}
                    onPause={() => doPauseFor(p.id, false)}
                    onLeave={() => doLeaveFor(p.id)}
                    onCancel={() => setPlayerActionId(null)}
                    pauseLabel="Back in"
                  />
                )}
              </li>
            );
          })}
          {queue.length === 0 && pausedPlayers.length === 0 && (
            <li className="px-4 py-2.5 text-line-400">Nobody is waiting.</li>
          )}
        </ul>
      </section>

      {/* recessed footer */}
      <footer className="mt-8 flex items-center justify-center gap-4 px-4 py-4 text-[13px] text-line-400">
        <button
          onClick={togglePause}
          disabled={busy || (myStatus !== 'AVAILABLE' && myStatus !== 'PAUSED')}
          className="min-h-[44px] disabled:opacity-40"
        >
          {myStatus === 'PAUSED' ? 'Back in' : 'Pause me'}
        </button>
        <span className="text-line-700">·</span>
        <button onClick={() => changeMode('RECORD')} className="min-h-[44px]">Manual teams</button>
        <span className="text-line-700">·</span>
        <Link href="/checkin" className="min-h-[44px]">Check people in</Link>
      </footer>

      <AdminLink />

      {/* undo bar */}
      {lastAction && undoSecondsLeft > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 border-t border-line-700 bg-court-800 px-4 pt-3"
          style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
        >
          <div className="flex items-center justify-between text-[13px] text-line-000">
            <span>Recorded · <button onClick={undo} disabled={busy} className="font-medium text-line-000 underline disabled:opacity-40">Undo</button></span>
            <span className="tabular text-line-400">{undoSecondsLeft}s</span>
          </div>
          <div className="mt-2 h-px w-full bg-line-700">
            <div
              className="undo-bar-fill h-px bg-line-000"
              style={{ width: `${(undoSecondsLeft / (UNDO_WINDOW_MS / 1000)) * 100}%`, transition: 'width 1s linear' }}
            />
          </div>
        </div>
      )}
    </main>
  );
}
