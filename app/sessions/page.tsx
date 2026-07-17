'use client';

// Player-facing, read-only list of past (and live) sessions — the public
// counterpart to the admin's /admin/sessions. Sessions are open-read
// (firestore.rules), so this reads them directly via the client SDK, same
// as the admin list. Tapping a session opens its matches in /history
// (already PLAYER-tier and view-only). No admin actions here.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase-client';
import type { SessionDoc } from '@/lib/firestore';
import { useActor } from '@/lib/client-identity';
import { WhoAmI, AppNav } from '../shared-ui';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

function formatPlayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SessionsPage() {
  const actor = useActor();
  const [sessions, setSessions] = useState<SessionDoc[] | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'sessions'), snap => {
      const docs = snap.docs
        .map(d => d.data() as SessionDoc)
        .filter(s => s.status === 'LIVE' || s.status === 'DONE') // hide unstarted drafts
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
      setSessions(docs);
    });
    return unsub;
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col bg-court-900 px-4 py-6 text-line-000">
      <div className="flex items-center justify-between">
        {actor ? <WhoAmI name={actor.name} short /> : <span />}
        <Link href="/" className="text-[13px] text-line-400">← Home</Link>
      </div>
      <p className="mt-2 font-display text-xl" style={{ fontStretch: '115%' }}>Sessions</p>
      <p className="mb-4 mt-1 text-[13px] text-line-400">Every club session — tap one to see its matches.</p>

      {sessions === null ? (
        <p className="text-[13px] text-line-400">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-[13px] text-line-400">No sessions yet — they&apos;ll show here after the first one.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sessions.map(s => {
            const present = Object.values(s.attendance ?? {}).filter(a => a.status !== 'LEFT').length;
            const live = s.status === 'LIVE';
            const href = live ? '/session' : `/history?session=${s.id}`;
            return (
              <Link
                key={s.id}
                href={href}
                className={`flex flex-col gap-2 rounded-2xl border border-line-700 bg-court-800 p-4 ${TAP}`}
              >
                {live ? (
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-live">
                    <span className="inline-block h-[7px] w-[7px] rounded-full bg-live" />
                    Live now
                  </span>
                ) : (
                  <span className="text-[12px] font-medium text-line-400">Done</span>
                )}
                <p className="font-display text-[18px]" style={{ fontStretch: '105%' }}>{formatPlayDate(s.date)}</p>
                <p className="text-[13px] text-line-400">
                  {present} player{present === 1 ? '' : 's'} present · {s.courtCount} court{s.courtCount === 1 ? '' : 's'}
                </p>
                <span className="mt-1 text-[13px] font-medium text-line-000">
                  {live ? 'Open live →' : 'View matches →'}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <AppNav current="sessions" />
    </main>
  );
}
