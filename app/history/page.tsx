'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase-client';
import { useActiveSession } from '@/lib/use-active-session';
import { useRole } from '@/lib/client-role';
import { useActor } from '@/lib/client-identity';
import type { GameHistoryEntry, SessionDoc } from '@/lib/firestore';
import { WhoAmI, ScoreInput } from '../shared-ui';
import { CourtDiagram } from '../CourtDiagram';

// Any specific session (ADMIN's "History" link on /admin/sessions,
// for a session that's DONE or otherwise not the live one) — sessions
// are open-read in firestore.rules, same as the live listener below.
function useSessionById(id: string | null) {
  const [session, setSession] = useState<SessionDoc | null | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    const unsub = onSnapshot(doc(db, 'sessions', id), snap => {
      setSession(snap.exists() ? (snap.data() as SessionDoc) : null);
    });
    return unsub;
  }, [id]);
  return session;
}

// PLAYER-tier — no code required, view-only, same as watching the live
// courts on /session. Reached either via the "History" button next to
// the mode switch on /session (the live session, no ?session= param —
// falls back to useActiveSession), or via ADMIN's "History" link per
// row on /admin/sessions (?session=<id>, any session regardless of
// status). Score editing here is MANAGER+ (same permission as
// recording the winner in the first place — see
// /api/session/[id]/score), reusing the exact same ScoreInput as the
// post-record popup, just pre-filled from whatever's already saved.
function HistoryPageInner() {
  const explicitId = useSearchParams().get('session');
  const active = useActiveSession();
  const bySessionId = useSessionById(explicitId);

  const session = explicitId ? (bySessionId ?? null) : active.session;
  const loading = explicitId ? bySessionId === undefined : active.loading;
  const sessionId = session?.id ?? '';

  const role = useRole();
  const canManage = role === 'MANAGER' || role === 'ADMIN';
  const actor = useActor();

  const [history, setHistory] = useState<GameHistoryEntry[] | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/session/${sessionId}/games`)
      .then(res => res.json())
      .then(body => { if (!cancelled) setHistory(body.history ?? []); });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (loading) {
    return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Loading…</main>;
  }

  if (!session) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center text-line-000">
        <p className="text-line-400">{explicitId ? 'Session not found.' : 'No session right now.'}</p>
        <Link href="/" className="min-h-[44px] text-[13px] text-line-400 underline">← Home</Link>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-court-900 px-4 py-6 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        {explicitId ? (
          <Link href="/admin/sessions" className="text-[13px] text-line-400">← All sessions</Link>
        ) : (
          <Link href="/session" className="text-[13px] text-line-400">← Session</Link>
        )}
      </div>
      <p className="mb-4 mt-2 font-display text-xl" style={{ fontStretch: '115%' }}>Match history</p>

      {history === null ? (
        <p className="text-[13px] text-line-400">Loading…</p>
      ) : history.length === 0 ? (
        <p className="text-[13px] text-line-400">No matches yet.</p>
      ) : (
        <ul className="space-y-3">
          {history.map(g => {
            const teamA = g.teamA.map(id => session.players[id]?.name ?? id) as [string, string];
            const teamB = g.teamB.map(id => session.players[id]?.name ?? id) as [string, string];
            const winnerNames = g.winner === 'A' ? teamA : teamB;
            // Team A is always the diagram's left column, Team B the
            // right — so the score fields (and the static score below,
            // for non-managers) need to know which side actually won to
            // line up under the right column, not just "winner first."
            const winnerOnRight = g.winner === 'B';
            const leftScore = winnerOnRight ? g.scoreLoser : g.scoreWinner;
            const rightScore = winnerOnRight ? g.scoreWinner : g.scoreLoser;
            return (
              <li key={g.id} className="overflow-hidden rounded-xl border border-line-700 bg-court-800">
                <div className="flex items-center justify-between px-4 pb-2 pt-3">
                  <span className="text-[11px] font-medium text-line-400">court {g.courtIndex + 1}</span>
                  <span className="text-[15px] font-medium text-line-000">{winnerNames.join(' & ')} won</span>
                </div>
                <div className="px-4 pb-3">
                  <CourtDiagram teamA={teamA} teamB={teamB} />
                </div>
                <div className="border-t border-line-700 px-4 py-3">
                  {canManage ? (
                    <ScoreInput
                      sessionId={sessionId}
                      gameId={g.id}
                      disabled={false}
                      initialWinner={g.scoreWinner ?? undefined}
                      initialLoser={g.scoreLoser ?? undefined}
                      winnerOnRight={winnerOnRight}
                    />
                  ) : (
                    g.scoreWinner != null && (
                      <div className="flex items-center justify-between text-[13px] text-line-400">
                        <span>{leftScore}</span>
                        <span>{rightScore}</span>
                      </div>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Loading…</main>}>
      <HistoryPageInner />
    </Suspense>
  );
}
