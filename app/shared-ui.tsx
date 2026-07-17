'use client';

// Small pieces shared between `/` (home) and `/session` (the live
// session screen) now that they're separate routes. Kept here instead
// of duplicated in both files.

import Link from 'next/link';
import { useState, useRef, Fragment, type ChangeEvent } from 'react';
import { useRole } from '@/lib/client-role';
import { useActiveSession } from '@/lib/use-active-session';
import { enterCode, clearCode, writeFetch } from '@/lib/client-code';
import { clearActor } from '@/lib/client-identity';
import { usePhotos } from '@/lib/use-photos';
import { fileToThumbnail } from '@/lib/resize-image';

export const TAP = 'transition-transform duration-75 active:scale-[0.98]';

// The ONE consistent nav across the app. Before this, every screen had
// its own ad-hoc footer (Home a full cluster, Board just "→ your page",
// Tournaments nothing) — so there was no MAP and half the screens were
// partial dead ends. Same links everywhere now. NOT pinned/sticky: the
// app deliberately has no fixed footers (they were removed on purpose),
// so this scrolls with the page like every other footer.
//
// `current` marks the screen you're on (bold, not a link). The Organiser
// door is ALWAYS here: a PLAYER can always find the way in (opens the
// code modal — kills the "invisible gate"), an ADMIN gets the hub, and
// anyone elevated can log back down.
const NAV_ITEMS = [
  { key: 'home', href: '/', label: 'Home' },
  { key: 'board', href: '/board', label: 'Leaderboard' },
  { key: 'me', href: '/me', label: 'My stats' },
  { key: 'tournaments', href: '/tournaments', label: 'Tournaments' },
] as const;

// The nav ROW on its own (no footer wrapper). Screens that already have a
// PageFooter with their own contextual bits — the Session screen's End
// session / Check people in and its end-confirm block — drop this row in
// and pass those actions via `extra`, so there's still ONE nav definition.
// The role/account cluster — Organiser (sign-in or hub) + Log out. ONE
// definition, used both in the footer nav and top-right on the home screen,
// so they can never drift. `·`-separated to sit inline in either place.
export function RoleControls({ current }: { current?: string }) {
  const role = useRole();
  const sep = <span aria-hidden className="text-line-700">·</span>;
  if (role === 'ADMIN') {
    return (
      <>
        <Link href="/admin" className={current === 'admin' ? 'font-medium text-line-000' : 'underline'}>Organiser</Link>
        {sep}
        <button type="button" onClick={() => clearCode()} className="underline">Log out</button>
      </>
    );
  }
  if (role === 'MANAGER') {
    return (
      <>
        <span className="text-line-400">Manager</span>
        {sep}
        <button type="button" onClick={() => clearCode()} className="underline">Log out</button>
      </>
    );
  }
  return <button type="button" onClick={() => void enterCode()} className="underline">Organiser sign-in</button>;
}

export function AppNavRow({ current, showRole = true }: { current?: string; showRole?: boolean }) {
  const { session } = useActiveSession();
  const sep = <span aria-hidden className="text-line-700">·</span>;

  // "Session" only appears while one is live — otherwise it'd link to an
  // empty screen. Slotted right after Home so it reads as the live thing.
  const items: Array<{ key: string; href: string; label: string }> = [...NAV_ITEMS];
  if (session?.status === 'LIVE') items.splice(1, 0, { key: 'session', href: '/session', label: 'Session' });

  return (
    <nav className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-4 text-[13px] text-line-400">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && sep}
          {item.key === current
            ? <span className="font-medium text-line-000">{item.label}</span>
            : <Link href={item.href} className="underline">{item.label}</Link>}
        </Fragment>
      ))}
      {showRole && <>{sep}<RoleControls current={current} /></>}
    </nav>
  );
}

export function AppNav({ current, showRole }: { current?: string; showRole?: boolean }) {
  return (
    <PageFooter border={false}>
      <AppNavRow current={current} showRole={showRole} />
    </PageFooter>
  );
}

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
  const { photos } = usePhotos();
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
          className={`flex min-h-[48px] items-center gap-2 rounded-xl border border-line-700 px-3 text-left font-display text-[16px] text-line-000 ${TAP}`}
          style={{ fontStretch: '105%' }}
        >
          <PlayerAvatar name={p.name} src={photos[p.id]} size={26} />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
      {roster.length === 0 && <p className="col-span-2 text-line-400">No players yet.</p>}
    </div>
  );
}

// A face, or a clean monochrome initials fallback (so unphotographed
// people still look intentional). `src` is a small JPEG data URI from
// usePhotos. The photo — not colour — is what carries recognition, so the
// fallback stays on-brand grey.
export function PlayerAvatar({ name, src, size = 28 }: { name: string; src?: string | null; size?: number }) {
  const initials =
    name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="flex-none rounded-full object-cover"
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) }}
      className="grid flex-none place-items-center rounded-full border border-line-700 bg-court-800 font-display leading-none text-line-400"
    >
      {initials}
    </span>
  );
}

// Self-serve: set the photo for whoever you've picked as your name. No
// code — same PLAYER-tier trust as pause/leave (a photo is reversible).
// The file is resized to a tiny thumbnail in the browser before upload.
export function MyPhotoCard({ actor }: { actor: { id: string; name: string } }) {
  const { photos, setLocal } = usePhotos();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const src = photos[actor.id];

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const thumb = await fileToThumbnail(file);
      const res = await fetch('/api/photos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: actor.id, thumb }),
      });
      if (res.ok) setLocal(actor.id, thumb);
      else setError('Could not save that photo.');
    } catch {
      setError('Could not read that image.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/photos', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: actor.id }),
      });
      if (res.ok) setLocal(actor.id, null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-line-700 p-3">
      <PlayerAvatar name={actor.name} src={src} size={48} />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] text-line-000">Your photo</p>
        <p className="text-[13px] text-line-400">
          {error ?? 'So people recognise you in the queue.'}
        </p>
      </div>
      <input ref={inputRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
      <div className="flex flex-none flex-col items-end gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className={`text-[13px] text-line-000 underline disabled:opacity-40 ${TAP}`}
        >
          {busy ? '…' : src ? 'Change' : 'Add photo'}
        </button>
        {src && !busy && (
          <button type="button" onClick={remove} className="text-[13px] text-line-400 underline">Remove</button>
        )}
      </div>
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
