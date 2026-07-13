'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase-client';
import { writeFetch } from '@/lib/client-code';
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
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'sessions'), snap => {
      const docs = snap.docs
        .map(d => d.data() as SessionDoc)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest/most-future first
      setSessions(docs);
    });
    return unsub;
  }, []);

  async function deleteDraft(id: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await writeFetch(`/api/session/${id}/draft`, { method: 'DELETE' });
      if (res.ok) {
        setConfirmId(null);
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Error: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function endSession(id: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await writeFetch(`/api/session/${id}/end`, { method: 'POST' });
      if (res.ok) {
        setConfirmId(null);
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Error: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-court-900 p-4 text-line-000">
      <Link href="/admin" className="block text-[13px] text-line-400">← Back to admin</Link>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>All sessions</p>

      {message && <p className="text-[13px] text-signal">{message}</p>}

      {sessions === null ? (
        <p className="text-line-400">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-line-400">No sessions yet. Create one at /admin/session/new.</p>
      ) : (
        <ul className="divide-y divide-line-700 rounded-xl border border-line-700">
          {sessions.map(s => {
            const playerCount = Object.keys(s.players ?? {}).length;
            const attendanceCount = Object.values(s.attendance ?? {}).filter(a => a.status !== 'LEFT').length;
            const inProgressCourts = (s.courts ?? []).filter(c => c.gameId !== null).length;
            const confirming = confirmId === s.id;

            return (
              <li key={s.id}>
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-display text-[17px]" style={{ fontStretch: '105%' }}>{formatPlayDate(s.date)}</p>
                    <p className="text-[13px] text-line-400">
                      {s.courtCount} court{s.courtCount === 1 ? '' : 's'} · {playerCount} in roster
                      {s.status === 'LIVE' || s.status === 'DONE' ? ` · ${attendanceCount} checked in` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-[13px] font-medium">
                    <StatusLabel status={s.status} />
                    {s.status === 'LIVE' && <Link href="/" className={`text-line-400 underline ${TAP}`}>Open</Link>}
                    {s.status === 'DRAFT' && <Link href="/admin/session/new" className={`text-line-400 underline ${TAP}`}>Edit</Link>}
                    {s.status === 'LIVE' && (
                      <button
                        disabled={busy}
                        onClick={() => setConfirmId(s.id)}
                        className={`text-line-700 disabled:opacity-40 ${TAP}`}
                      >
                        End
                      </button>
                    )}
                    {s.status === 'DRAFT' && (
                      <button
                        disabled={busy}
                        onClick={() => setConfirmId(s.id)}
                        className={`text-line-700 disabled:opacity-40 ${TAP}`}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {confirming && s.status === 'LIVE' && (
                  <div className="space-y-2 border-t border-line-700 bg-court-800 p-3">
                    <p className="text-[13px] text-line-400">
                      End this session ({formatPlayDate(s.date)})?
                      {inProgressCourts > 0
                        ? ` ${inProgressCourts} court${inProgressCourts === 1 ? '' : 's'} still in progress — those matches will be left exactly as they are, inside a session / no longer shows.`
                        : ' Nobody is mid-match right now.'}
                    </p>
                    <div className="flex gap-2">
                      <button
                        disabled={busy}
                        onClick={() => endSession(s.id)}
                        className={`min-h-[44px] flex-1 rounded-lg border border-signal bg-signal text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                      >
                        End session
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {confirming && s.status === 'DRAFT' && (
                  <div className="space-y-2 border-t border-line-700 bg-court-800 p-3">
                    <p className="text-[13px] text-line-400">
                      Delete this draft ({formatPlayDate(s.date)})? Nobody has checked in, so nothing is lost — but it can&apos;t be undone.
                    </p>
                    <div className="flex gap-2">
                      <button
                        disabled={busy}
                        onClick={() => deleteDraft(s.id)}
                        className={`min-h-[44px] flex-1 rounded-lg border border-signal bg-signal text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
