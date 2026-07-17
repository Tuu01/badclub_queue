'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useActiveSession } from '@/lib/use-active-session';
import { writeFetch, enterCode } from '@/lib/client-code';
import { useRole } from '@/lib/client-role';
import { useActor, setActor as saveActor } from '@/lib/client-identity';
import { usePlayers } from '@/lib/use-players';
import type { BoardData } from '@/lib/firestore';
import { TAP, EnterCodeLink, IdentityStrip, WhoAmI, AppNav } from './shared-ui';

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
  const [liveTournament, setLiveTournament] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/tournaments')
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        const live = (b.tournaments ?? []).find((t: { status: string }) => t.status === 'LIVE');
        setLiveTournament(live ? { id: live.id, name: live.name } : null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const activeRoster = players
    .filter(p => p.active)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Honest "are you actually in tonight?" status. Picking your name on
  // this screen sets WHO YOU ARE (for your stats) — it does NOT check you
  // in; a manager does that. Without this line a player picks their name,
  // nothing visibly happens, and they're left wondering if they're in the
  // queue. Show their real attendance status instead of staying silent.
  const myStatus = session?.status === 'LIVE' && actor
    ? session.attendance[actor.id]?.status
    : undefined;
  const checkedIn = myStatus === 'AVAILABLE' || myStatus === 'PLAYING' || myStatus === 'PAUSED';

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
      {/* Top strip: who you are (left) + a VISIBLE way in (right). The
          Organiser door used to be a tiny footer link nobody found — now
          it sits top-right on the home screen, like a normal app's
          sign-in. Players get the code prompt; admins jump to the hub. */}
      <div className="mb-2 flex min-h-[24px] items-center justify-between">
        {actor ? <WhoAmI name={actor.name} short /> : <span />}
        {role === 'ADMIN' ? (
          <Link href="/admin" className={`text-[13px] text-line-400 underline ${TAP}`}>Organiser →</Link>
        ) : role === 'PLAYER' ? (
          <button type="button" onClick={() => void enterCode()} className={`text-[13px] text-line-400 underline ${TAP}`}>
            Organiser sign-in
          </button>
        ) : (
          <span />
        )}
      </div>
      <div className="mb-6 text-center">
        <p className="font-display text-2xl" style={{ fontStretch: '115%' }}>Badminton Queue</p>
        <p className="mt-1 text-[13px] text-line-400">Fair matches and who&apos;s up next — every Saturday.</p>
      </div>

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
            {actor && (
              checkedIn ? (
                <p className="text-[13px] text-line-000">✓ You&apos;re checked in tonight</p>
              ) : (
                <p className="max-w-xs text-[13px] text-line-400">
                  {canManage
                    ? "You're not checked in yet."
                    : "You're not checked in yet — a manager will tap you in."}
                </p>
              )
            )}
            <Link
              href="/session"
              className={`mt-2 flex min-h-[56px] w-full max-w-xs items-center justify-center rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 ${TAP}`}
            >
              {checkedIn ? 'See the queue' : 'Go to session'}
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
          <p className="text-line-400">No badminton on right now — check back on Saturday.</p>
        )}
      </section>

      {/* Live tournament — same treatment as a live session. Admin lands
          on the run screen; everyone else on the standings/live view. */}
      {liveTournament && (
        <section className="mt-4 flex flex-col items-center gap-2 text-center">
          <p className="flex items-center gap-1.5 text-[13px] text-live">
            <span className="inline-block h-[7px] w-[7px] rounded-full bg-live" />
            🏆 Tournament is live · {liveTournament.name}
          </p>
          <Link
            href={role === 'ADMIN' ? `/tournament/${liveTournament.id}/run` : `/tournament/${liveTournament.id}`}
            className={`mt-1 flex min-h-[56px] w-full max-w-xs items-center justify-center rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 ${TAP}`}
          >
            Go to tournament
          </Link>
        </section>
      )}

      <div className="mx-auto my-6 max-w-xs border-t border-line-700" />

      <section className="mx-auto max-w-xs">
        {actor ? <MixingTeaser actor={actor} /> : <IdentityStrip roster={activeRoster} onPick={saveActor} />}
      </section>

      <div className="mt-6" />

      <AppNav current="home" />
    </main>
  );
}
