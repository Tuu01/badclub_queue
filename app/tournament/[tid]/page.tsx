'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../../shared-ui';
import type { TournamentView } from '@/lib/tournament';

type ViewData = TournamentView & { names: Record<string, string> };

export default function TournamentPage({ params }: { params: Promise<{ tid: string }> }) {
  const { tid } = use(params);
  const actor = useActor();
  const [data, setData] = useState<ViewData | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tournament/${tid}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [tid]);

  if (data === undefined) {
    return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Loading…</main>;
  }
  if (!data) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center text-line-000">
        <p className="text-line-400">Tournament not found.</p>
        <Link href="/" className="min-h-[44px] text-[13px] text-line-400 underline">← Home</Link>
      </main>
    );
  }

  const { tournament: t, teamRecords, playerRecords, championTeamId, names } = data;
  const teamName = (id: string) => t.teams.find(tm => tm.id === id)?.name ?? id;
  const nameOf = (id: string) => names[id] ?? id;
  const rankedPlayers = [...playerRecords].sort((a, b) => {
    const pa = a.wins + a.losses ? a.wins / (a.wins + a.losses) : 0;
    const pb = b.wins + b.losses ? b.wins / (b.wins + b.losses) : 0;
    return pb - pa || b.wins - a.wins;
  });

  return (
    <main className="mx-auto min-h-dvh max-w-2xl bg-court-900 px-4 py-6 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/" className="text-[13px] text-line-400">← Home</Link>
      </div>
      <p className="mt-2 font-display text-2xl" style={{ fontStretch: '115%' }}>{t.name}</p>
      <p className="text-[13px] text-line-400">
        {t.date}{t.venue ? ` · ${t.venue}` : ''} · {t.courtCount} courts
        {t.imported ? ' · imported' : ''}
      </p>

      {/* Teams + records */}
      <section className="mt-6">
        <p className="text-[11px] font-medium text-line-400">TEAMS</p>
        <ul className="mt-2 space-y-2">
          {teamRecords.map(r => {
            const champ = r.teamId === championTeamId;
            const team = t.teams.find(tm => tm.id === r.teamId);
            return (
              <li key={r.teamId} className={`rounded-xl border p-3 ${champ ? 'border-signal bg-signal-dim/30' : 'border-line-700'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>
                    {champ ? '🏆 ' : ''}{teamName(r.teamId)}
                  </span>
                  <span className="tabular text-[13px] text-line-400">{r.wins}–{r.losses}</span>
                </div>
                {team && (
                  <p className="mt-1 text-[12px] text-line-400">{team.playerIds.map(nameOf).join(' · ')}</p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Per-player winrate — computed on read */}
      <section className="mt-6">
        <p className="text-[11px] font-medium text-line-400">PLAYERS · winrate this tournament</p>
        <ul className="mt-2 divide-y divide-line-700 border-t border-line-700">
          {rankedPlayers.map(r => {
            const total = r.wins + r.losses;
            const pct = total ? Math.round((r.wins / total) * 100) : 0;
            const mine = actor?.id === r.playerId;
            return (
              <li key={r.playerId} className={`flex items-center justify-between px-1 py-2 ${mine ? 'text-signal' : ''}`}>
                <span className="text-[15px]">{nameOf(r.playerId)}</span>
                <span className="tabular text-[13px] text-line-400">{r.wins}–{r.losses} · {pct}%</span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Games */}
      <section className="mt-6 pb-10">
        <p className="text-[11px] font-medium text-line-400">GAMES · {data.games.length}</p>
        <ul className="mt-2 space-y-1">
          {data.games.map(g => {
            const aWon = g.winner === 'A';
            const bWon = g.winner === 'B';
            const pa = `${nameOf(g.playerIds[0])} & ${nameOf(g.playerIds[1])}`;
            const pb = `${nameOf(g.playerIds[2])} & ${nameOf(g.playerIds[3])}`;
            return (
              <li key={g.id} className="flex items-center justify-between gap-2 rounded-lg border border-line-700 px-3 py-2 text-[13px]">
                <span className={aWon ? 'font-medium text-line-000' : 'text-line-400'}>{pa}</span>
                <span className="shrink-0 text-[11px] text-line-700">
                  {g.winner ? (g.scoreLoser != null ? `21–${g.scoreLoser}` : 'won') : 'vs'}
                  {g.note ? ' ⚠' : ''}
                </span>
                <span className={`text-right ${bWon ? 'font-medium text-line-000' : 'text-line-400'}`}>{pb}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
