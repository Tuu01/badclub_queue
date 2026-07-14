'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../shared-ui';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';
interface TItem { id: string; name: string; date: string; status: string; teamsFinalized: boolean; imported: boolean; }

// PLAYER-tier — view-only discovery, reached from the home footer.
// Tapping a tournament opens its standings/live view at /tournament/[id].
export default function TournamentsPage() {
  const actor = useActor();
  const [list, setList] = useState<TItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/tournaments').then(r => r.json()).then(b => { if (!cancelled) setList(b.tournaments ?? []); });
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-court-900 px-4 py-6 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/" className="text-[13px] text-line-400">← Home</Link>
      </div>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Tournaments</p>

      {list === null ? (
        <p className="text-[13px] text-line-400">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-line-400">No tournaments yet.</p>
      ) : (
        <ul className="divide-y divide-line-700 rounded-xl border border-line-700">
          {list.map(t => (
            <li key={t.id}>
              <Link href={`/tournament/${t.id}`} className={`flex items-center justify-between gap-2 px-4 py-3 ${TAP}`}>
                <span className="min-w-0">
                  <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>🏆 {t.name}</span>
                  <span className="block text-[13px] text-line-400">{t.date}{t.imported ? ' · imported' : ''}</span>
                </span>
                <span className="shrink-0 text-[13px] text-line-400">
                  {t.status === 'LIVE' ? 'live' : t.status === 'DONE' ? 'results →' : 'upcoming'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
