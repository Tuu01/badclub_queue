'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useActiveSession } from '@/lib/use-active-session';
import { writeFetch } from '@/lib/client-code';
import { useRole } from '@/lib/client-role';
import { useActor, setActor as saveActor } from '@/lib/client-identity';
import { computeQueue } from '@/lib/session-view';
import type { PlayerId, Suggestion } from '@/lib/types';
import { formatSummaryText } from '@/lib/session-summary-format';
import { TAP, AdminLink, EnterCodeLink, IdentityStrip, LogoutLink, WhoAmI, PageFooter, ScoreInput, AppNavRow, PlayerAvatar, RoleControls } from '../shared-ui';
import { usePhotos } from '@/lib/use-photos';
import { CourtDiagram } from '../CourtDiagram';

const MODES = ['ASSIGN', 'RECORD'] as const;
type Mode = (typeof MODES)[number];

// The stored mode values (ASSIGN/RECORD/OFF) are terrible on-screen labels:
// "Record" reads as "record the score", but it actually means "hand-pick the
// teams" — and scores get recorded in BOTH modes. So we show plain labels and
// a one-line hint of what the mode does, without touching the stored values.
const MODE_LABEL: Record<string, string> = { ASSIGN: 'App picks', RECORD: 'Pick myself', OFF: 'By hand' };
const MODE_HINT: Record<string, string> = {
  ASSIGN: 'The app suggests a fair match for each free court — tap “Take court” to accept it, or “Swap” to choose your own four.',
  RECORD: 'You choose who plays — tap “Start court” on a free court to pick the four yourself.',
  OFF: 'Teams are picked by hand and not tracked.',
};

const RECONNECT_MS = 5_000;
const OFFLINE_MS = 15_000;

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

// F-2's copyable summary, shown right after ending. Lives entirely on
// this route now — once a session ends, /session naturally falls into
// its own "no session right now" empty state underneath, so there's no
// cross-route transition to survive the way there was when / and
// /session were the same page.
function SessionEndedSummary({
  text, copied, onCopy, onDismiss,
}: {
  text: string;
  copied: boolean;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 space-y-2 border-t border-line-000 bg-court-800 p-4">
      <p className="text-[13px] font-medium text-line-000">Session ended — paste this into the group chat:</p>
      <textarea
        readOnly
        value={text}
        rows={6}
        onFocus={e => e.currentTarget.select()}
        className="w-full rounded-lg border border-line-700 bg-transparent p-3 text-[13px] text-line-000"
      />
      <div className="flex gap-2">
        <button
          onClick={onCopy}
          className={`min-h-[44px] flex-1 rounded-lg border border-line-000 bg-line-000 text-[14px] font-medium text-court-900 ${TAP}`}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button
          onClick={onDismiss}
          className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function SessionPage() {
  const { session, loading, online, liveConflict } = useActiveSession();
  const sessionId = session?.id ?? '';

  const actor = useActor();
  const role = useRole();
  const canManage = role === 'MANAGER' || role === 'ADMIN';
  const { photos } = usePhotos();

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
  const [pausePickerOpen, setPausePickerOpen] = useState(false);
  const [playerActionId, setPlayerActionId] = useState<PlayerId | null>(null);
  const [lastAction, setLastAction] = useState<{ auditLogId: string; at: number; gameId: string } | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [endConfirming, setEndConfirming] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState(false);
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

  // A suggestion for court 2 can name someone who just got assigned to
  // court 1 a moment ago — invalidateSuggestion() only ever clears the
  // court that WAS just filled, not every OTHER cached suggestion that
  // happens to reference the same people. The server always re-validates
  // on confirm (so nobody double-books), but the UI would keep showing
  // a suggestion that's already doomed to 409. This clears every cached
  // suggestion touching any of the given ids, so court 2 refetches with
  // people who are actually still available.
  function invalidateSuggestionsInvolving(playerIds: PlayerId[]) {
    setSuggestions(prev => {
      let changed = false;
      const next = { ...prev };
      for (const [idxStr, sug] of Object.entries(prev)) {
        if (sug && sug.four.some(id => playerIds.includes(id))) {
          const idx = Number(idxStr);
          delete next[idx];
          suggestionFetchedRef.current.delete(idx);
          changed = true;
        }
      }
      return changed ? next : prev;
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

  // Tonight's full planned roster, for the in-session IdentityStrip —
  // see the note above the LIVE-branch render for why this can't be
  // gated behind an early return (Rules of Hooks).
  const everyone = useMemo(
    () => (session ? Object.values(session.players).sort((a, b) => a.name.localeCompare(b.name)) : []),
    [session],
  );

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
        invalidateSuggestionsInvolving(picked);
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
        // inId just went from AVAILABLE to PLAYING — same staleness risk
        // as confirmPick/takeSuggested if some other court's cached
        // suggestion also named them.
        invalidateSuggestionsInvolving([inId]);
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
      if (res.ok) {
        // These 4 just got locked in — any OTHER court's cached suggestion
        // that also names one of them is now stale (see
        // invalidateSuggestionsInvolving). Without this, court 2 can sit
        // there suggesting someone who's already walking onto court 1.
        invalidateSuggestionsInvolving(suggestion.four);
      } else {
        invalidateSuggestion(courtIdx); // 409 — someone was just taken elsewhere, fetch a fresh suggestion
      }
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
        if (body.auditLogId) setLastAction({ auditLogId: body.auditLogId, at: Date.now(), gameId });
        invalidateSuggestion(courtIdx); // court just freed up — any old suggestion is stale
      }
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!lastAction || busy) return;
    setBusy(true);
    setUndoError(null);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/undo`, {
        method: 'POST',
        body: JSON.stringify({ auditLogId: lastAction.auditLogId }),
      });
      if (res.ok) {
        setLastAction(null);
      } else {
        const body = await res.json().catch(() => null);
        setUndoError(body?.error ?? 'Could not undo.');
      }
    } finally {
      setBusy(false);
    }
  }

  // UC-14 — anyone can pause anyone, one tap, no confirmation. Shared
  // by the queue's per-row action row and the manager/admin-only
  // "Pause someone" picker (a shortcut on top of that open access, not
  // a replacement for it — see CLAUDE.md ROLES).
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

  // The manager who's actually standing in the hall shouldn't need the
  // admin code just to end the session they're running — see
  // /admin/sessions for the ADMIN-reachable equivalent (same endpoint).
  async function endSessionAction() {
    if (!session || busy) return;
    setBusy(true);
    setEndError(null);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/end`, { method: 'POST' });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        setEndConfirming(false);
        if (body?.summary) {
          setSummaryText(formatSummaryText(body.summary, `${window.location.origin}/board`));
          setSummaryCopied(false);
        }
      } else {
        const body = await res.json().catch(() => null);
        setEndError(body?.error ?? `Could not end session (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function copySummary() {
    if (!summaryText) return;
    try {
      await navigator.clipboard.writeText(summaryText);
      setSummaryCopied(true);
    } catch {
      setSummaryCopied(false);
      setEndError('Could not copy automatically — select the text above and copy manually.');
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

  // No session live — this route is specifically for the live screen
  // now (see `/` for the home screen). Not an error, just nothing to
  // show here right now.
  if (!session || session.status === 'DRAFT') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center text-line-000">
        {actor && <WhoAmI name={actor.name} short />}
        <p className="text-line-400">No session right now.</p>
        <Link href="/" className={`min-h-[44px] text-[13px] text-line-000 underline ${TAP}`}>← Home</Link>
        {summaryText && (
          <SessionEndedSummary
            text={summaryText}
            copied={summaryCopied}
            onCopy={copySummary}
            onDismiss={() => setSummaryText(null)}
          />
        )}
      </main>
    );
  }

  // status === 'LIVE' from here.
  const presentCount = Object.values(session.attendance).filter(a => a.status !== 'LEFT').length;

  // Empty state: nobody checked in yet — check-in IS the screen, not a footer action.
  if (presentCount === 0) {
    return (
      <main className="flex min-h-dvh flex-col bg-court-900 px-4 text-center">
        <div className="flex items-center justify-between pt-4">
          {actor && <WhoAmI name={actor.name} short />}
          <Link href="/" className="text-[13px] text-line-400">← Home</Link>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-line-400">Nobody&apos;s checked in yet</p>
          {canManage ? (
            <>
              <Link
                href="/checkin"
                className={`flex min-h-[56px] w-full max-w-xs items-center justify-center rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 ${TAP}`}
              >
                Check people in
              </Link>
              {endConfirming ? (
                <div className="w-full max-w-xs space-y-2 rounded-xl border border-line-700 bg-court-800 p-3 text-left">
                  <p className="text-[13px] text-line-400">
                    End this session? Nobody&apos;s checked in — nothing is lost.
                  </p>
                  {endError && <p className="text-[13px] text-signal">{endError}</p>}
                  <div className="flex gap-2">
                    <button
                      disabled={busy}
                      onClick={endSessionAction}
                      className={`min-h-[44px] flex-1 rounded-lg border border-signal bg-signal text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                    >
                      End session
                    </button>
                    <button
                      onClick={() => { setEndConfirming(false); setEndError(null); }}
                      className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => setEndConfirming(true)}
                  className="min-h-[44px] text-[13px] text-line-400 underline disabled:opacity-40"
                >
                  Started this by mistake? End session
                </button>
              )}
            </>
          ) : (
            <EnterCodeLink label="Enter manager code to check people in" />
          )}
        </div>

        <AdminLink />
        <LogoutLink />

        {summaryText && (
          <SessionEndedSummary
            text={summaryText}
            copied={summaryCopied}
            onCopy={copySummary}
            onDismiss={() => setSummaryText(null)}
          />
        )}
      </main>
    );
  }

  // VALUE FIRST, IDENTITY SECOND — the whole screen below renders
  // regardless of whether `actor` is set. Only the hero (which needs
  // to know who "you" are) swaps for the IdentityStrip; courts, queue,
  // everything else is visible and usable immediately. See PROMPT.md.
  const inProgressCourts = session.courts.filter(c => c.gameId !== null).length;
  const myStatus = actor ? session.attendance[actor.id]?.status : undefined;
  const myQueueIdx = actor ? queue.findIndex(q => q.id === actor.id) : -1;
  const clock = new Date(now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  return (
    <main className="flex min-h-dvh flex-col bg-court-900 pb-6 text-line-000">
      {/* status bar — the name up front is UC-19: fat fingers, one tap
          to fix, no confirmation. */}
      <header className="flex min-h-11 items-center justify-between gap-x-3 px-4 py-1.5 text-[13px] text-line-400">
        {actor ? <WhoAmI name={actor.name} short /> : <span />}
        <span className="flex flex-wrap items-center justify-end gap-x-2">
          <ConnectionDot state={connection} />
          <span aria-hidden className="text-line-700">·</span>
          <RoleControls current="session" />
        </span>
      </header>
      {/* Ambient session context — kept quiet, off the top control row. */}
      <p className="px-4 pb-1 text-[12px] text-line-400">
        {session.courtCount} courts · {presentCount} people · <span className="tabular">{clock}</span>
      </p>

      {stale && (
        <p className="px-4 pb-2 text-[13px] text-signal">Offline. What you&apos;re seeing is stale.</p>
      )}

      {/* hero — this is where the strip lives once it "becomes the hero"
          after picking a name (same slot, not a separate screen). */}
      <section className="flex flex-col items-center gap-1 px-4 py-6 text-center">
        {!actor ? (
          <div className="w-full max-w-xs">
            <IdentityStrip roster={everyone} onPick={saveActor} />
          </div>
        ) : myStatus === 'PLAYING' ? (
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

      {/* mode switch — first-class, always visible to managers. A player
          can't act on it, so they get a plain readout, not dead buttons.
          "History" sits in the same row but isn't a mode itself — it
          links to /history (its own PLAYER-tier screen), not a
          session.mode change, so it's a separate link, not a MODES entry. */}
      <div className="flex items-center gap-2 px-4 pt-3">
        {canManage ? (
          <div className="flex flex-1 gap-px">
            {MODES.map(m => (
              <button
                key={m}
                onClick={() => changeMode(m)}
                className={`h-11 flex-1 rounded-lg border text-[16px] font-medium ${TAP} ${
                  session.mode === m ? 'border-line-000 bg-line-000 text-court-900' : 'border-line-700 text-line-400'
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        ) : (
          <p className="flex-1 text-[13px] text-line-400">
            Matches: {MODE_LABEL[session.mode] ?? session.mode}
          </p>
        )}
        <Link
          href="/history"
          className={`flex h-11 items-center rounded-lg border border-line-700 px-4 text-[16px] font-medium text-line-400 ${TAP}`}
        >
          History
        </Link>
      </div>
      {canManage && (
        <p className="px-4 pb-2 pt-1.5 text-[12px] leading-snug text-line-400">
          {MODE_HINT[session.mode]}
        </p>
      )}

      {/* Manager/admin shortcut on top of UC-14's open, no-code pause —
          not a replacement for it. Lists everyone currently AVAILABLE
          or PAUSED (not mid-match — you can't pause someone who's
          actively playing without pulling them off court first) so a
          manager can pause/un-pause anyone without hunting through the
          queue below. */}
      {canManage && (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={() => setPausePickerOpen(o => !o)}
            className={`text-[13px] text-line-400 underline ${TAP}`}
          >
            {pausePickerOpen ? 'Hide' : 'Pause someone'}
          </button>
          {pausePickerOpen && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {[...availablePlayers, ...pausedPlayers]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(p => {
                  const isPaused = session.attendance[p.id]?.status === 'PAUSED';
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={busy}
                      onClick={() => doPauseFor(p.id, !isPaused)}
                      className={`min-h-[48px] rounded-lg border border-line-700 px-2 text-left font-display text-[17px] disabled:opacity-40 ${TAP} ${
                        isPaused ? 'text-line-700' : 'text-line-000'
                      }`}
                      style={{ fontStretch: '105%' }}
                    >
                      {p.name}
                      {isPaused ? ' · paused' : ''}
                    </button>
                  );
                })}
              {availablePlayers.length === 0 && pausedPlayers.length === 0 && (
                <p className="col-span-2 text-[13px] text-line-400">Nobody available to pause right now.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* courts */}
      <section className="space-y-3 px-4">
        {session.courts.map(court => {
          const picking = pickerCtx?.courtIdx === court.idx;
          const suggestion = suggestions[court.idx];
          const hasSuggestion = session.mode === 'ASSIGN' && !court.gameId && !!suggestion;
          const iAmInIt = !!(court.players && actor && court.players.includes(actor.id));
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
                        disabled={busy || stale || !actor}
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
                                  disabled={busy || stale || !actor}
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
                canManage ? (
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
                        disabled={busy || stale || !actor}
                        onClick={() => recordWinner(court.idx, court.gameId!, 'A')}
                        className={`min-h-[56px] border-r border-line-700 px-2 text-[16px] font-medium text-line-000 disabled:opacity-40 active:bg-court-700 ${TAP}`}
                      >
                        {court.teamA.map(id => session.players[id]?.name ?? id).join(' & ')} won
                      </button>
                      <button
                        disabled={busy || stale || !actor}
                        onClick={() => recordWinner(court.idx, court.gameId!, 'B')}
                        className={`min-h-[56px] px-2 text-[16px] font-medium text-line-000 disabled:opacity-40 active:bg-court-700 ${TAP}`}
                      >
                        {court.teamB.map(id => session.players[id]?.name ?? id).join(' & ')} won
                      </button>
                    </div>
                    {/* UC-7a — free the court without a winner. Queue-urgent,
                        rating-not-urgent: see recordResult() in lib/firestore.ts. */}
                    <button
                      disabled={busy || stale || !actor}
                      onClick={() => recordWinner(court.idx, court.gameId!, null)}
                      className={`min-h-[36px] w-full border-t border-line-700 text-[12px] text-line-700 disabled:opacity-40 ${TAP}`}
                    >
                      Not sure who won — free the court
                    </button>
                  </>
                ) : (
                  <p className="border-t border-line-700 py-4 text-center text-[13px] text-line-400">In play</p>
                )
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
                      disabled={picked.length !== 4 || busy || stale || !actor}
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
                canManage ? (
                  <button
                    disabled={stale}
                    onClick={() => openPicker(court.idx, false)}
                    className={`min-h-[56px] w-full border-t border-line-700 text-[16px] font-medium text-line-400 disabled:opacity-40 ${TAP}`}
                  >
                    Start court
                  </button>
                ) : (
                  <p className="border-t border-line-700 py-4 text-center text-[13px] text-line-400">Waiting for a manager</p>
                )
              ) : suggestion === undefined ? (
                <p className="border-t border-line-700 py-4 text-center text-[13px] text-line-400">Finding a suggestion…</p>
              ) : suggestion === null ? (
                <p className="border-t border-line-700 py-4 text-center text-[13px] text-line-400">Waiting for a court</p>
              ) : (
                <div className="border-t border-line-700">
                  {/* THE REASON SENTENCE — always shown, never hidden. */}
                  <p className="px-4 pt-3 text-[13px] text-line-400">{suggestion.reason}</p>
                  {canManage && (
                    <div className="mt-3 flex border-t border-line-700">
                      <button
                        disabled={busy || stale || !actor}
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
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* queue — anyone (no code needed) taps anyone → Pause / Left, no
          confirmation for pause; Left needs one (see the action row
          below). UC-13/UC-14. Deliberately PLAYER-tier — see CLAUDE.md
          "ROLES": the person who sees a court free up is whoever's
          sitting out, not whoever holds the manager code. */}
      <section className="mt-6">
        <p className="px-4 pb-2 text-[11px] font-medium text-line-400">queue · {queue.length} people</p>
        <ul>
          {queue.map((q, i) => {
            const mine = actor ? q.id === actor.id : false;
            const open = playerActionId === q.id;
            return (
              <li key={q.id}>
                <button
                  type="button"
                  disabled={stale}
                  onClick={() => setPlayerActionId(open ? null : q.id)}
                  className={`flex w-full items-center justify-between px-4 py-2.5 text-left disabled:opacity-40 ${mine ? 'bg-signal-dim' : ''}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`tabular text-[13px] ${mine ? 'text-signal' : 'text-line-400'}`}>{i + 1}</span>
                    <PlayerAvatar name={session.players[q.id]?.name ?? q.id} src={photos[q.id]} size={22} />
                    <span
                      className={`font-display text-[17px] ${mine ? 'text-signal' : 'text-line-000'}`}
                      style={{ fontStretch: '105%' }}
                    >
                      {session.players[q.id]?.name ?? q.id}
                    </span>
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

      <div className="mt-6" />

      <PageFooter border={false}>
        {/* End session — reachable by MANAGER, not just ADMIN via
            /admin/sessions (same endpoint). The person actually running
            tonight's session shouldn't need the admin code just to close
            it out. */}
        {endConfirming && (
          <div className="mx-4 mt-3 space-y-2 rounded-xl border border-line-700 bg-court-800 p-3">
            <p className="text-[13px] text-line-400">
              End this session?
              {inProgressCourts > 0
                ? ` ${inProgressCourts} court${inProgressCourts === 1 ? '' : 's'} still in progress — those matches will be left exactly as they are.`
                : ' Nobody is mid-match right now.'}
            </p>
            {endError && <p className="text-[13px] text-signal">{endError}</p>}
            <div className="flex gap-2">
              <button
                disabled={busy}
                onClick={endSessionAction}
                className={`min-h-[44px] flex-1 rounded-lg border border-signal bg-signal text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
              >
                End session
              </button>
              <button
                onClick={() => { setEndConfirming(false); setEndError(null); }}
                className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* The shared nav row (Home · Leaderboard · My stats · Tournaments
            · Organiser) — one definition, see AppNavRow. The session-only
            manager actions ride in via `extra`; pause is done by tapping
            your own queue row, and mode-switching has its own tab strip
            higher up, so neither is duplicated here. */}
        <AppNavRow
          current="session"
          showRole={false}
          extra={canManage ? (
            <>
              <button onClick={() => setEndConfirming(true)} disabled={busy} className="underline disabled:opacity-40">
                End session
              </button>
              <span aria-hidden className="text-line-700">·</span>
              <Link href="/checkin" className="underline">Check people in</Link>
            </>
          ) : undefined}
        />
      </PageFooter>

      {/* Recorded/score prompt — centered, not a slim bottom bar.
          Recording the winner already succeeded instantly; this is a
          follow-up prompt, not a gate. Closes itself once the score is
          saved, or on Undo — no auto-close/countdown, since score
          editing is always available later via /history anyway.
          Suppressed once the session's ended — the summary overlay
          takes that spot. */}
      {lastAction && canManage && !summaryText && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-court-900/80 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-xl border border-line-700 bg-court-800 p-4">
            <p className="text-[13px] text-line-000">Recorded</p>
            <ScoreInput
              key={lastAction.gameId}
              sessionId={sessionId}
              gameId={lastAction.gameId}
              disabled={stale}
              secondaryAction={{ label: 'Undo', onClick: undo }}
              onSaved={() => setLastAction(null)}
            />
            {undoError && <p className="text-[13px] text-signal">{undoError}</p>}
          </div>
        </div>
      )}

      {summaryText && (
        <SessionEndedSummary
          text={summaryText}
          copied={summaryCopied}
          onCopy={copySummary}
          onDismiss={() => setSummaryText(null)}
        />
      )}
    </main>
  );
}
