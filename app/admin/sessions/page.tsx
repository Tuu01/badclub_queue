'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase-client';
import type { SessionDoc } from '@/lib/firestore';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

function formatPlayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function StatusLabel({ status }: { status: SessionDoc['status'] | undefined }) {
  if (status === 'LIVE') {
    return (
      <span className="flex items-center gap-1.5 text-live">
        <span className="inline-block h-[7px] w-[7px] rounded-full bg-live" />
        LIVE
      </span>
    );
  }
  if (status === 'DRAFT') return <span className="text-line-000">DRAFT</span>;
  if (status === 'DONE') return <span className="text-line-700">DONE</span>;
  return <span className="text-line-700">— (pre-lifecycle)</span>;
}

export default function AllSessionsPage() {
  const [sessions, setSessions] = useState<SessionDoc[] | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'sessions'), snap => {
      const docs = snap.docs
        .map(d => d.data() as SessionDoc)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest/most-future first
      setSessions(docs);
    });
    return unsub;
  }, []);

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-court-900 p-4 text-line-000">
      <Link href="/admin" className="block text-[13px] text-line-400">← Back to admin</Link>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>All sessions</p>

      {sessions === null ? (
        <p className="text-line-400">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-line-400">No sessions yet. Create one at /admin/session/new.</p>
      ) : (
        <ul className="divide-y divide-line-700 rounded-xl border border-line-700">
          {sessions.map(s => {
            const playerCount = Object.keys(s.players ?? {}).length;
            const attendanceCount = Object.values(s.attendance ?? {}).filter(a => a.status !== 'LEFT').length;
            const row = (
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="font-display text-[17px]" style={{ fontStretch: '105%' }}>{formatPlayDate(s.date)}</p>
                  <p className="text-[13px] text-line-400">
                    {s.courtCount} court{s.courtCount === 1 ? '' : 's'} · {playerCount} in roster
                    {s.status === 'LIVE' || s.status === 'DONE' ? ` · ${attendanceCount} checked in` : ''}
                  </p>
                </div>
                <div className="text-[13px] font-medium">
                  <StatusLabel status={s.status} />
                </div>
              </div>
            );
            return (
              <li key={s.id}>
                {s.status === 'LIVE' ? (
                  <Link href="/" className={`block ${TAP}`}>{row}</Link>
                ) : s.status === 'DRAFT' ? (
                  <Link href="/admin/session/new" className={`block ${TAP}`}>{row}</Link>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
