'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { usePlayers } from '@/lib/use-players';
import { useActiveSession } from '@/lib/use-active-session';
import { writeFetch, enterCode } from '@/lib/client-code';
import { useRole } from '@/lib/client-role';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../shared-ui';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

export default function CheckinPage() {
  const router = useRouter();
  const { players, loading } = usePlayers();
  const { session, loading: sessionLoading } = useActiveSession();
  const sessionId = session?.id ?? '';
  const role = useRole();
  const canManage = role === 'MANAGER' || role === 'ADMIN';
  const actor = useActor();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [guestOpen, setGuestOpen] = useState(false);
  const [guestForm, setGuestForm] = useState<{ name: string; gender: 'M' | 'F' }>({ name: '', gender: 'M' });

  const active = useMemo(
    () => [...players].filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name)),
    [players],
  );

  // The session (created by /admin/session/new) already has its roster
  // set — /checkin only shows those ~22 people (PROMPT.md).
  const roster = useMemo(
    () => (session ? active.filter(p => session.players[p.id]) : []),
    [active, session],
  );
  const extra = useMemo(
    () => (session ? active.filter(p => !session.players[p.id]) : []),
    [active, session],
  );

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function done() {
    if (busy) return;
    if (selected.size === 0) {
      router.push('/session');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/checkin`, {
        method: 'POST',
        body: JSON.stringify({ playerIds: [...selected] }),
      });
      if (res.ok) {
        router.push('/session');
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Error: ${body?.error ?? res.status}`);
      }
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
                className={`min-h-[56px] w-full rounded-xl border px-3 py-2 text-left font-display text-[17px] disabled:opacity-40 ${TAP} ${
                  on ? 'border-line-000 bg-line-000 text-court-900' : 'border-line-700 text-line-000'
                }`}
                style={{ fontStretch: '105%' }}
              >
                {p.name}{already ? ' ✓' : ''}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  if (!canManage) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center text-line-000">
        <p className="text-line-400">Check-in needs the manager code.</p>
        <button
          type="button"
          onClick={() => void enterCode()}
          className="min-h-[44px] text-[13px] text-line-000 underline"
        >
          Enter manager code
        </button>
        <Link href="/" className="min-h-[44px] text-[13px] text-line-400 underline">← Home</Link>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-court-900 px-4 py-6 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/" className="text-[13px] text-line-400">← Home</Link>
      </div>
      <p className="mb-4 mt-2 font-display text-xl" style={{ fontStretch: '115%' }}>Check-in</p>

      {loading || sessionLoading ? (
        <p className="text-line-400">Loading…</p>
      ) : !session ? (
        <p className="text-line-400">
          No session yet.{' '}
          <Link href="/admin/session/new" className="underline text-line-000">Create one</Link>.
        </p>
      ) : (
        <>
          <p className="mb-4 text-[13px] text-line-400">
            {session.courtCount} courts · roster ({roster.length} people)
          </p>

          {renderGrid(roster)}
          {roster.length === 0 && (
            <p className="text-[13px] text-line-400">
              Nobody in the roster yet.{' '}
              <Link href="/admin/players" className="underline text-line-000">Add people</Link> first.
            </p>
          )}

          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowMore(s => !s)}
              className="min-h-[44px] text-[13px] text-line-400 underline"
            >
              {showMore ? 'Hide' : '+ Add someone not on the list'}
            </button>
            {showMore && <div className="mt-2">{renderGrid(extra)}</div>}
          </div>

          <button
            type="button"
            onClick={done}
            disabled={busy}
            className={`mt-4 min-h-[56px] w-full rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
          >
            {busy ? 'Saving…' : 'Done'}
          </button>

          {message && <p className="mt-3 text-center text-[13px] text-line-400">{message}</p>}

          <div className="mt-6 border-t border-line-700 pt-4">
            {guestOpen ? (
              <div className="flex flex-wrap items-end gap-2">
                <input
                  value={guestForm.name}
                  onChange={e => setGuestForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Guest name"
                  className="h-14 min-w-[10rem] flex-1 rounded-xl border border-line-700 bg-transparent px-3 text-[16px] text-line-000 placeholder:text-line-400"
                />
                <select
                  value={guestForm.gender}
                  onChange={e => setGuestForm(f => ({ ...f, gender: e.target.value as 'M' | 'F' }))}
                  className="h-14 rounded-xl border border-line-700 bg-court-900 px-3 text-[16px] text-line-000"
                >
                  <option value="M">Male</option>
                  <option value="F">Female</option>
                </select>
                <button onClick={addGuest} disabled={busy} className={`h-14 rounded-xl border border-line-000 bg-line-000 px-4 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}>
                  Add
                </button>
                <button onClick={() => setGuestOpen(false)} className={`h-14 rounded-xl border border-line-700 px-4 text-[16px] font-medium text-line-400 ${TAP}`}>
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setGuestOpen(true)} className={`min-h-[56px] w-full rounded-xl border border-line-700 text-[16px] text-line-400 ${TAP}`}>
                + Add guest
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
