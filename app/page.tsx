'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useActiveSession } from '@/lib/use-active-session';
import { writeFetch, clearCode } from '@/lib/client-code';
import { useRole } from '@/lib/client-role';
import { useActor, setActor as saveActor } from '@/lib/client-identity';
import { usePlayers } from '@/lib/use-players';
import type { BoardData } from '@/lib/firestore';
import { TAP, EnterCodeLink, IdentityStrip, WhoAmI, PageFooter } from './shared-ui';

function formatPlayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

// The home screen's discovery hook — see LEADERBOARD.md §0. Renders
// nothing until there's real signal (no 0/0, no flash of empty while
// loading); the Leaderboard/My-stats links below it are the fallback,
// so this is a bonus, never a dead end on its own.
function MixingTeaser({ actor }: { actor: { id: string; name: string } }) {
  const [data, setData] = useState<{ partners: number; possible: number; streak: number } | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/board')
      .then(res => res.json())
      .then((d: BoardData) => {
        if (cancelled) return;
        const me = d.members.find(m => m.id === actor.id);
        setData(me ? { partners: me.mixing.partners, possible: me.mixing.possible, streak: me.attendance.streak } : null);
      })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [actor.id]);

  if (!data || data.possible === 0) return null;
  return (
    <div className="space-y-1 text-center text-[13px] text-line-400">
      <p>🤝 You&apos;ve played with {data.partners} of {data.possible} people</p>
      {data.streak > 0 && <p>🔥 {data.streak} session{data.streak === 1 ? '' : 's'} in a row</p>}
    </div>
  );
}

// THE HOME SCREEN — `/`, on its own route now (see /session for the
// live screen). The app sleeps 167 hours a week; this is where almost
// every open lands. Not an empty state. Session status (if any) up
// top, a link to /session when something's actually happening, the
// mixing teaser as the retention hook, then the only discovery path
// to /board and /me. See PROMPT.md's route map.
export default function HomePage() {
  const router = useRouter();
  const { session, loading, liveConflict } = useActiveSession();
  const sessionId = session?.id ?? '';
  const role = useRole();
  const canManage = role === 'MANAGER' || role === 'ADMIN';
  const actor = useActor();
  const { players } = usePlayers();

  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const activeRoster = players
    .filter(p => p.active)
    .sort((a, b) => a.name.localeCompare(b.name));

  async function startSession() {
    if (!session || busy) return;
    setBusy(true);
    setStartError(null);
    try {
      const res = await writeFetch(`/api/session/${sessionId}/start`, { method: 'POST' });
      if (res.ok) {
        router.push('/session');
      } else {
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

  return (
    <main className="flex min-h-dvh flex-col bg-court-900 px-4 py-6 text-line-000">
      {actor && (
        <div className="mb-2">
          <WhoAmI name={actor.name} short />
        </div>
      )}
      <p className="mb-6 text-center font-display text-2xl" style={{ fontStretch: '115%' }}>Badminton Queue</p>

      <section className="flex flex-col items-center gap-2 text-center">
        {liveConflict ? (
          <>
            <p className="text-[13px] font-medium text-signal">⚠ Two sessions are live — that&apos;s a bug.</p>
            <Link href="/session" className={`text-[13px] text-line-000 underline ${TAP}`}>See /session</Link>
          </>
        ) : session?.status === 'LIVE' ? (
          <>
            <p className="flex items-center gap-1.5 text-[13px] text-live">
              <span className="inline-block h-[7px] w-[7px] rounded-full bg-live" />
              Session is live · {formatPlayDate(session.date)}
            </p>
            <Link
              href="/session"
              className={`mt-2 flex min-h-[56px] w-full max-w-xs items-center justify-center rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 ${TAP}`}
            >
              Go to session
            </Link>
          </>
        ) : session?.status === 'DRAFT' ? (
          <>
            <p className="text-[13px] text-line-400">Next session</p>
            <p className="font-display text-xl" style={{ fontStretch: '115%' }}>
              {formatPlayDate(session.date)} · {session.targetHeadcount} players
            </p>
            {canManage ? (
              <>
                <button
                  disabled={busy}
                  onClick={startSession}
                  className={`mt-2 flex min-h-[56px] w-full max-w-xs items-center justify-center rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                >
                  Start session
                </button>
                {startError && <p className="mt-2 max-w-xs text-[13px] text-signal">{startError}</p>}
              </>
            ) : (
              <div className="mt-2 space-y-2">
                <p className="text-[13px] text-line-400">Waiting for a manager to start this.</p>
                <EnterCodeLink label="Enter manager code" />
              </div>
            )}
          </>
        ) : (
          <p className="text-line-400">No session yet.</p>
        )}
      </section>

      <div className="mx-auto my-6 max-w-xs border-t border-line-700" />

      <section className="mx-auto max-w-xs">
        {actor ? <MixingTeaser actor={actor} /> : <IdentityStrip roster={activeRoster} onPick={saveActor} />}
      </section>

      <div className="mt-6" />

      <PageFooter border={false}>
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-4 text-[13px] text-line-400">
          <Link href="/board" className="underline">Leaderboard</Link>
          <span className="text-line-700">·</span>
          <Link href="/me" className="underline">My stats</Link>
          <span className="text-line-700">·</span>
          <Link href="/tournaments" className="underline">Tournaments</Link>
          {role === 'PLAYER' && (
            <>
              <span className="text-line-700">·</span>
              <EnterCodeLink label="Enter code" />
            </>
          )}
          {role === 'ADMIN' && (
            <>
              <span className="text-line-700">·</span>
              <Link href="/admin" className="underline">Admin</Link>
            </>
          )}
          {role !== 'PLAYER' && (
            <>
              <span className="text-line-700">·</span>
              <button type="button" onClick={() => clearCode()} className="underline">
                Log out ({role === 'ADMIN' ? 'admin' : 'manager'})
              </button>
            </>
          )}
        </div>
      </PageFooter>
    </main>
  );
}
