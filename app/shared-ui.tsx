'use client';

// Small pieces shared between `/` (home) and `/session` (the live
// session screen) now that they're separate routes. Kept here instead
// of duplicated in both files.

import Link from 'next/link';
import { useState } from 'react';
import { useRole } from '@/lib/client-role';
import { enterCode, clearCode, writeFetch } from '@/lib/client-code';
import { clearActor } from '@/lib/client-identity';

export const TAP = 'transition-transform duration-75 active:scale-[0.98]';

// /admin is create/edit/delete sessions + CRUD players — ADMIN-tier, not
// MANAGER. Hidden rather than greyed for anyone below that.
export function AdminLink() {
  const role = useRole();
  if (role !== 'ADMIN') return null;
  return (
    <Link href="/admin" className="block px-4 py-6 text-center text-[13px] text-line-700">
      Admin
    </Link>
  );
}

// The symmetric action to "Enter code" — no confirmation, since it's
// exactly as reversible as entering it in the first place (tap Enter
// code again). Drops this browser back to PLAYER instantly.
export function LogoutLink() {
  const role = useRole();
  if (role === 'PLAYER') return null;
  return (
    <button
      type="button"
      onClick={() => clearCode()}
      className="block w-full px-4 pb-6 text-center text-[13px] text-line-700"
    >
      Log out ({role === 'ADMIN' ? 'admin' : 'manager'})
    </button>
  );
}

// Shown in place of a manager-only action for a PLAYER — never a dead
// end, always a way to become a MANAGER on the spot.
export function EnterCodeLink({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => void enterCode()}
      className="min-h-[44px] text-[13px] text-line-400 underline"
    >
      {label}
    </button>
  );
}

// VALUE FIRST, IDENTITY SECOND. Never a full-screen wall — a collapsed
// strip that expands in place, so the rest of the screen (courts,
// queue, the home teaser) is visible and usable the whole time. Used
// both in a live session (roster = tonight's session.players) and on
// the home screen (roster = the full active club, via usePlayers()).
export function IdentityStrip({
  roster, onPick,
}: {
  roster: Array<{ id: string; name: string }>;
  onPick: (a: { id: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex w-full items-center justify-between rounded-xl border border-line-700 px-4 py-3 text-left ${TAP}`}
      >
        <span className="text-line-400">Who are you?</span>
        <span className="text-[13px] font-medium text-line-000 underline">Pick your name</span>
      </button>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {roster.map(p => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          className={`min-h-[48px] rounded-xl border border-line-700 px-3 text-left font-display text-[16px] text-line-000 ${TAP}`}
          style={{ fontStretch: '105%' }}
        >
          {p.name}
        </button>
      ))}
      {roster.length === 0 && <p className="col-span-2 text-line-400">No players yet.</p>}
    </div>
  );
}

// The footer/nav cluster (Leaderboard/My stats, Admin, Log out, the
// session footer, etc.) — not `fixed`/pinned to the viewport, so it
// scrolls away with the rest of the page on tall content. `mt-auto`
// (parent must be `flex min-h-dvh flex-col`) is what keeps it sitting
// at the bottom of the screen on short content instead of floating
// right under the last section.
export function PageFooter({ children, border = true }: { children: React.ReactNode; border?: boolean }) {
  return (
    <div
      className={`mt-auto bg-court-900 ${border ? 'border-t border-line-700' : ''}`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {children}
    </div>
  );
}

// UC-19 — "Wrong name picked on first open." Fat fingers, app now
// thinks you're Tuan. One tap, no confirmation, no password — exactly
// as easy to undo as it was to do in the first place. `short` drops
// "You are ... · change" down to just the (underlined, still
// tappable) name, for tight spots like the status bar.
export function WhoAmI({ name, short }: { name: string; short?: boolean }) {
  return (
    <button type="button" onClick={() => clearActor()} className="text-[13px] text-line-400 underline">
      {short ? name : `You are ${name} · change`}
    </button>
  );
}

// UC-21 — lives INSIDE the recorded/score popup on /session, and also
// reused on /history for editing an already-recorded score. Saves on
// blur/Enter or the Save button, not per keystroke. Keyed by gameId at
// the call site so a new result gets a blank field, not the previous
// game's leftover value.
export function ScoreInput({
  sessionId, gameId, disabled, initialWinner, initialLoser, winnerOnRight, secondaryAction, onSaved,
}: {
  sessionId: string;
  gameId: string;
  disabled: boolean;
  /** Pre-fills from an already-recorded score — used when editing from match history. */
  initialWinner?: number;
  initialLoser?: number;
  /**
   * /history lines each match up with the court diagram above it (teamA
   * left, teamB right) — so the winner's field needs to sit on whichever
   * side actually won, not always first. Omit for the post-record popup
   * on /session, which has no left/right court context to match.
   */
  winnerOnRight?: boolean;
  /** Renders alongside Save as an equal-width pair — e.g. Undo on the post-record popup. */
  secondaryAction?: { label: string; onClick: () => void };
  /** Fires after a successful save — the post-record popup closes itself on it. */
  onSaved?: () => void;
}) {
  // 21 is the common case (badminton's normal winning score), not the
  // only one — deuce games run to 30. Pre-filled, not fixed: still a
  // real editable field.
  const [winnerValue, setWinnerValue] = useState(initialWinner != null ? String(initialWinner) : '21');
  const [loserValue, setLoserValue] = useState(initialLoser != null ? String(initialLoser) : '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Loser's score is the "did you actually mean to enter this" gate —
  // matches the old single-field behavior: type nothing there, nothing
  // saves, regardless of whether the winner field was edited from 21.
  async function commit() {
    if (loserValue.trim() === '' || busy) return;
    const winner = Number(winnerValue);
    const loser = Number(loserValue);
    if (!Number.isInteger(winner) || winner < 21 || winner > 30) return;
    if (!Number.isInteger(loser) || loser < 0 || loser > 29 || loser >= winner) return;
    setBusy(true);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/score`, {
        method: 'POST',
        body: JSON.stringify({ gameId, scoreWinner: winner, scoreLoser: loser }),
      });
      if (res.ok) {
        setSaved(true);
        onSaved?.();
      }
    } finally {
      setBusy(false);
    }
  }

  const winnerInput = (
    <input
      key="winner"
      type="number"
      inputMode="numeric"
      min={21}
      max={30}
      disabled={disabled || busy}
      value={winnerValue}
      onChange={e => { setWinnerValue(e.target.value); setSaved(false); }}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className="h-8 w-14 rounded-md border border-line-700 bg-transparent px-2 text-center text-[13px] text-line-000 disabled:opacity-40"
    />
  );
  const loserInput = (
    <input
      key="loser"
      type="number"
      inputMode="numeric"
      min={0}
      max={29}
      disabled={disabled || busy}
      value={loserValue}
      onChange={e => { setLoserValue(e.target.value); setSaved(false); }}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      placeholder="score"
      className="h-8 w-14 rounded-md border border-line-700 bg-transparent px-2 text-center text-[13px] text-line-000 disabled:opacity-40"
    />
  );
  const saveButton = (
    <button
      key="save"
      type="button"
      disabled={disabled || busy || loserValue.trim() === ''}
      onClick={commit}
      className="h-8 rounded-md border border-line-000 bg-line-000 px-3 text-[13px] font-medium text-court-900 disabled:opacity-40"
    >
      Save
    </button>
  );

  if (winnerOnRight !== undefined) {
    return (
      <div className="flex w-full items-center justify-between text-[13px] text-line-400">
        {winnerOnRight ? loserInput : winnerInput}
        <div className="flex items-center gap-2">
          {saveButton}
          {saved && <span className="text-live">saved</span>}
        </div>
        {winnerOnRight ? winnerInput : loserInput}
      </div>
    );
  }

  const blockSaveButton = (
    <button
      type="button"
      disabled={disabled || busy || loserValue.trim() === ''}
      onClick={commit}
      className={`min-h-[44px] rounded-lg border border-line-000 bg-line-000 text-[14px] font-medium text-court-900 disabled:opacity-40 ${
        secondaryAction ? 'flex-1' : 'w-full'
      }`}
    >
      Save
    </button>
  );

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2 text-[13px] text-line-400">
        {winnerInput}
        <span>–</span>
        {loserInput}
        {saved && <span className="text-live">saved</span>}
      </div>
      {secondaryAction ? (
        <div className="flex gap-2">
          {blockSaveButton}
          <button
            type="button"
            onClick={secondaryAction.onClick}
            className="min-h-[44px] flex-1 rounded-lg border border-line-700 text-[14px] font-medium text-line-400"
          >
            {secondaryAction.label}
          </button>
        </div>
      ) : (
        blockSaveButton
      )}
    </div>
  );
}
