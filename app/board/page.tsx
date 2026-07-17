'use client';

// No live Skill board. Deliberately.
//
// Ratings today = a hand-made seed + zero games. sigma = 8.0 for everyone.
// Publishing that number means publishing MY GUESS with noise on top.
//
// Whoever lands at the bottom of a table built on zero data will quit,
// and we'd have killed a user in week one with a number that measured
// nothing at all.
//
// Gate: sigma < 4.0 && gamesTotal >= 15.  ~6 months at 2 games/week.
// See LEADERBOARD.md §5.
//
// You get to lose their trust exactly once.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useActor } from '@/lib/client-identity';
import { WhoAmI, AppNav } from '../shared-ui';
import { labelForBand, BAND_MIN_GAMES, type SkillBand } from '@/lib/skill-band';
import type { BoardData, BoardMember } from '@/lib/firestore';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';
const TABS = ['SKILL', 'ATTENDANCE', 'MIXING', 'IMPROVEMENT'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  MIXING: '🤝 Mixing',
  ATTENDANCE: '🔥 Attendance',
  SKILL: '🏆 Skill',
  IMPROVEMENT: '📈 Improvement',
};

function Bar({ frac }: { frac: number }) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-court-700">
      <div className="h-full rounded-full bg-line-000" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Row({ mine, name, right, frac }: { mine: boolean; name: string; right: string; frac: number }) {
  return (
    <li className={`px-4 py-2.5 ${mine ? 'bg-signal-dim' : ''}`}>
      <div className="flex items-center justify-between">
        <span className={`font-display text-[17px] ${mine ? 'text-signal' : 'text-line-000'}`} style={{ fontStretch: '105%' }}>
          {name}
        </span>
        <span className={`tabular text-[13px] ${mine ? 'text-signal' : 'text-line-400'}`}>{right}</span>
      </div>
      <div className="mt-1.5">
        <Bar frac={frac} />
      </div>
    </li>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="px-4 py-8 text-center text-[13px] text-line-400">{text}</p>;
}

function MixingTab({ members, myId }: { members: BoardMember[]; myId: string | undefined }) {
  const eligible = members.filter(m => m.mixing.possible > 0);
  if (eligible.length === 0) {
    return <EmptyState text="Nothing to show yet — come back after a few sessions." />;
  }
  const sorted = [...eligible].sort((a, b) => {
    const fa = a.mixing.partners / a.mixing.possible;
    const fb = b.mixing.partners / b.mixing.possible;
    return fb - fa || b.mixing.partners - a.mixing.partners;
  });
  return (
    <div>
      <p className="px-4 pb-3 text-[13px] text-line-400">Different people you&apos;ve partnered with, ever.</p>
      <ul>
        {sorted.map(m => (
          <Row
            key={m.id}
            mine={m.id === myId}
            name={m.id === myId ? 'You' : m.name}
            right={`${m.mixing.partners} / ${m.mixing.possible}`}
            frac={m.mixing.partners / m.mixing.possible}
          />
        ))}
      </ul>
    </div>
  );
}

function AttendanceTab({ members, myId }: { members: BoardMember[]; myId: string | undefined }) {
  const eligible = members.filter(m => m.attendance.ofLast > 0);
  if (eligible.length === 0) {
    return <EmptyState text="Nothing to show yet — come back after a few sessions." />;
  }
  const sorted = [...eligible].sort((a, b) =>
    b.attendance.attended - a.attendance.attended || b.attendance.streak - a.attendance.streak);
  return (
    <div>
      <p className="px-4 pb-3 text-[13px] text-line-400">Sessions attended, most recent {sorted[0]?.attendance.ofLast ?? 0}.</p>
      <ul>
        {sorted.map(m => (
          <Row
            key={m.id}
            mine={m.id === myId}
            name={m.id === myId ? 'You' : m.name}
            right={`${m.attendance.attended} / ${m.attendance.ofLast}${m.attendance.streak > 0 ? ` · 🔥 ${m.attendance.streak} in a row` : ''}`}
            frac={m.attendance.attended / m.attendance.ofLast}
          />
        ))}
      </ul>
    </div>
  );
}

// Bands are shown GROUPED, never as a 1-2-3 ranked ladder — that
// ladder is exactly the failure mode LEADERBOARD.md §5/§10 warns about
// (an unlucky player sinks to the bottom and quits). Broad buckets stay
// correct even while the underlying rating is still noisy, and names
// within a band are alphabetical so there's no implied sub-ranking.
// See LEADERBOARD.md §5's provisional-band decision note.
const BAND_ORDER: SkillBand[] = ['ADVANCED', 'INTERMEDIATE', 'BEGINNER'];
const BAND_EMOJI: Record<SkillBand, string> = { ADVANCED: '🥇', INTERMEDIATE: '🥈', BEGINNER: '🥉' };

function SkillTab({ data, myId }: { data: BoardData; myId: string | undefined }) {
  const banded = data.members.filter(m => m.skill.band !== null);
  const gettingStarted = data.members.filter(m => m.skill.band === null).length;

  if (banded.length === 0) {
    return <EmptyState text="Nobody has enough games yet — bands appear after a few sessions." />;
  }

  return (
    <div className="space-y-5 px-4 py-4">
      <p className="text-[13px] text-line-400">
        Grouped by level, not ranked — two people in a band aren&apos;t ordered. Dimmed names are still
        provisional (the level can still move).
      </p>

      {BAND_ORDER.map(band => {
        const group = banded
          .filter(m => m.skill.band === band)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (group.length === 0) return null;
        return (
          <div key={band}>
            <p className="text-[13px] font-medium text-line-000">
              {BAND_EMOJI[band]} {labelForBand(band)} ({group.length})
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {group.map(m => {
                const mine = m.id === myId;
                const cls = mine
                  ? 'border-signal bg-signal-dim text-signal'
                  : m.skill.provisional
                    ? 'border-line-700 text-line-400'
                    : 'border-line-700 text-line-000';
                return (
                  <span
                    key={m.id}
                    className={`rounded-lg border px-3 py-1.5 font-display text-[15px] ${cls}`}
                    style={{ fontStretch: '105%' }}
                  >
                    {mine ? 'You' : m.name}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="border-t border-line-700 pt-4 text-center text-[13px] text-line-400">
        <p>
          <span className="font-medium text-line-000">{data.groupSkillReady} / {data.totalActiveMembers}</span>{' '}
          confirmed · the rest are still settling.
        </p>
        {gettingStarted > 0 && (
          <p className="mt-1">+{gettingStarted} just getting started (under {BAND_MIN_GAMES} games).</p>
        )}
        <p className="mt-2 text-line-700">Provisional levels firm up around 6 months of play.</p>
      </div>
    </div>
  );
}

function ImprovementTab({ data }: { data: BoardData }) {
  const skillReady = data.groupSkillReady > 0;
  return (
    <div className="space-y-4 px-4 py-4">
      <div className="rounded-xl border border-line-700 p-4">
        <p className="font-display text-lg text-line-000" style={{ fontStretch: '115%' }}>📈 Improvement — locked</p>
        <p className="mt-2 text-[13px] text-line-400">Who climbed the most this month.</p>

        <ul className="mt-3 space-y-1 text-[13px]">
          <li className="flex items-center gap-2">
            <span className={data.snapshotsCount > 0 ? 'text-live' : 'text-line-700'}>{data.snapshotsCount > 0 ? '✓' : '✗'}</span>
            <span className="text-line-400">Rating history — collecting now</span>
          </li>
          <li className="flex items-center gap-2">
            <span className={skillReady ? 'text-live' : 'text-line-700'}>{skillReady ? '✓' : '✗'}</span>
            <span className="text-line-400">A ranked rating — see Skill tab</span>
          </li>
        </ul>

        <p className="mt-3 text-[13px] text-line-000">
          Snapshots taken: <span className="tabular font-medium">{data.snapshotsCount}</span> session{data.snapshotsCount === 1 ? '' : 's'}
        </p>

        <p className="mt-3 text-[13px] text-line-400">
          Unlike Skill, anyone can top this board — it isn&apos;t who&apos;s best, it&apos;s who improved most.
        </p>
      </div>

      <div className="border-t border-line-700 pt-4 text-center">
        <p className="text-[13px] text-line-400">
          <span className="font-medium text-line-000">{data.groupSkillReady} / {data.totalActiveMembers}</span> players are ready.
        </p>
      </div>
    </div>
  );
}

interface Champion {
  tournamentId: string; tournamentName: string; date: string; teamName: string; memberNames: string[];
}

export default function BoardPage() {
  const actor = useActor();
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('SKILL');
  const [champion, setChampion] = useState<Champion | null>(null);

  useEffect(() => {
    fetch('/api/board')
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/tournaments/champion')
      .then(res => res.json())
      .then(b => { if (!cancelled) setChampion(b.champion ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="flex min-h-dvh flex-col bg-court-900 pb-10 text-line-000">
      <header className="px-4 pt-6 pb-2">
        <div className="flex items-center justify-between">
          {actor && <WhoAmI name={actor.name} short />}
          <Link href="/" className="text-[13px] text-line-400">← Home</Link>
        </div>
        <p className="mt-2 font-display text-xl" style={{ fontStretch: '115%' }}>Board</p>
      </header>

      {/* Glory showcase — the last tournament's champions. Separate from
          skill (tournament data is quarantined); computed on read. */}
      {champion && (
        <Link
          href={`/tournament/${champion.tournamentId}`}
          className={`mx-4 mb-1 block rounded-xl border border-line-000 bg-court-800 p-4 ${TAP}`}
        >
          <p className="text-[11px] font-medium tracking-wide text-line-400">🏆 CHAMPIONS · {champion.tournamentName}</p>
          <p className="mt-1 font-display text-[18px] text-line-000" style={{ fontStretch: '110%' }}>{champion.teamName}</p>
          <p className="mt-1 text-[13px] text-line-400">{champion.memberNames.join(' · ')}</p>
        </Link>
      )}

      <div className="flex gap-px px-4 py-3">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-11 flex-1 rounded-lg border text-[13px] font-medium ${TAP} ${
              tab === t ? 'border-line-000 bg-line-000 text-court-900' : 'border-line-700 text-line-400'
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {loading || !data ? (
        <p className="px-4 py-8 text-center text-[13px] text-line-400">Loading…</p>
      ) : (
        <section className="mt-2">
          {tab === 'MIXING' && <MixingTab members={data.members} myId={actor?.id} />}
          {tab === 'ATTENDANCE' && <AttendanceTab members={data.members} myId={actor?.id} />}
          {tab === 'SKILL' && <SkillTab data={data} myId={actor?.id} />}
          {tab === 'IMPROVEMENT' && <ImprovementTab data={data} />}
        </section>
      )}

      <div className="mt-6" />

      <AppNav current="board" />
    </main>
  );
}
