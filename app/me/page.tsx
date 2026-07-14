'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useActor } from '@/lib/client-identity';
import { WhoAmI, PageFooter } from '../shared-ui';
import { labelForBand, BAND_MIN_GAMES } from '@/lib/skill-band';
import type { BoardData } from '@/lib/firestore';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

function Bar({ frac }: { frac: number }) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-court-700">
      <div className="h-full rounded-full bg-line-000" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function MePage() {
  const actor = useActor();
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/board')
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (!actor) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center text-line-000">
        <p className="text-line-400">Pick your name on the main screen first.</p>
        <Link href="/" className={`min-h-[44px] text-[13px] text-line-000 underline ${TAP}`}>← Home</Link>
      </main>
    );
  }

  if (loading || !data) {
    return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Loading…</main>;
  }

  const me = data.members.find(m => m.id === actor.id);

  if (!me) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center text-line-000">
        <p className="text-line-400">Nothing to show yet — come back after a few sessions.</p>
        <Link href="/board" className={`min-h-[44px] text-[13px] text-line-000 underline ${TAP}`}>See the board</Link>
        <Link href="/" className={`min-h-[44px] text-[13px] text-line-400 underline ${TAP}`}>← Home</Link>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col bg-court-900 px-4 py-6 text-line-000">
      <div className="flex items-center justify-between">
        <WhoAmI name={actor.name} short />
        <Link href="/" className="text-[13px] text-line-400">← Home</Link>
      </div>
      <p className="mt-2 font-display text-xl" style={{ fontStretch: '115%' }}>{actor.name}</p>

      {/* Mixing */}
      <section className="mt-6">
        <p className="text-[13px] text-line-400">
          Played with <span className="font-medium text-line-000">{me.mixing.partners}</span> of{' '}
          {me.mixing.possible} people
        </p>
        <div className="mt-2"><Bar frac={me.mixing.possible > 0 ? me.mixing.partners / me.mixing.possible : 0} /></div>
      </section>

      {/* THE MOST IMPORTANT THING ON EITHER PAGE — see LEADERBOARD.md §3. */}
      <section className="mt-4 rounded-xl border-2 border-signal bg-signal-dim/30 p-4">
        <p className="text-[13px] font-medium text-signal">Never partnered with</p>
        {me.mixing.neverPartneredWith.length > 0 ? (
          <p className="mt-2 font-display text-2xl leading-snug text-line-000" style={{ fontStretch: '110%' }}>
            {me.mixing.neverPartneredWith.join(' · ')}
          </p>
        ) : (
          <p className="mt-2 text-[15px] text-line-000">
            You&apos;ve played with everyone you&apos;ve been at a session with.
          </p>
        )}
      </section>

      {/* Attendance */}
      <section className="mt-6 space-y-1">
        <p className="text-[13px] text-line-400">
          Attended <span className="font-medium text-line-000">{me.attendance.attended}</span> of the last{' '}
          {me.attendance.ofLast} sessions
        </p>
        <p className="text-[13px] text-line-400">
          Current streak: <span className="font-medium text-line-000">{me.attendance.streak}</span>
        </p>
      </section>

      <div className="mx-0 mt-6 border-t border-line-700" />

      {/* Skill band — a coarse level (not a number), provisional until
          the rating converges (~6 months). See /board for the whole
          group's bands and LEADERBOARD.md §5's decision note. Still a
          Link, never a dead end. */}
      <Link href="/board" className={`mt-4 flex items-center justify-between rounded-xl border border-line-700 p-3 ${TAP}`}>
        <span className="text-[15px] text-line-000">🏆 Skill</span>
        {me.skill.band ? (
          <span className="text-[13px] text-line-400">
            <span className="font-medium text-line-000">{labelForBand(me.skill.band)}</span>
            {me.skill.provisional
              ? ' · provisional'
              : me.skill.settling && me.skill.adjacentBand
                ? ` · settling toward ${labelForBand(me.skill.adjacentBand)}`
                : ' · confirmed'}
          </span>
        ) : (
          <span className="tabular text-[13px] text-line-400">
            {me.skill.gamesTotal} games in — level shows after {BAND_MIN_GAMES}
          </span>
        )}
      </Link>
      <Link href="/board" className={`mt-2 flex items-center justify-between rounded-xl border border-line-700 p-3 ${TAP}`}>
        <span className="text-[15px] text-line-000">📈 Improvement</span>
        <span className="text-[13px] text-line-400">needs Skill first</span>
      </Link>

      <div className="mt-6" />

      <PageFooter border={false}>
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-4 text-[13px] text-line-400">
          <Link href="/board" className="underline">See the full board →</Link>
        </div>
      </PageFooter>
    </main>
  );
}
