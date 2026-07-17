'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase-client';
import { writeFetch } from '@/lib/client-code';
import type { SessionDoc } from '@/lib/firestore';
import { formatSummaryText } from '@/lib/session-summary-format';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../../shared-ui';
import { AdminGate } from '../admin-gate';

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
        Live
      </span>
    );
  }
  if (status === 'DRAFT') return <span className="text-line-000">Not started</span>;
  if (status === 'DONE') return <span className="text-line-700">Done</span>;
  return <span className="text-line-700">Not started</span>;
}

function AllSessionsPageInner() {
  const actor = useActor();
  const [sessions, setSessions] = useState<SessionDoc[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'sessions'), snap => {
      const docs = snap.docs
        .map(d => d.data() as SessionDoc)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest/most-future first
      setSessions(docs);
    });
    return unsub;
  }, []);

  // ADMIN-tier, any status — works on DRAFT/LIVE/DONE alike, unlike
  // the DRAFT-only endpoint /admin/session/new still relies on for its
  // own edit/wrong-date-fix flow. See lib/firestore.ts#deleteSession.
  async function deleteSessionAction(id: string) {
    if (busy || deleteText.trim().toLowerCase() !== 'delete') return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await writeFetch(`/api/session/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setDeleteConfirmId(null);
        setDeleteText('');
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
        const body = await res.json().catch(() => null);
        setConfirmId(null);
        if (body?.summary) {
          const boardUrl = `${window.location.origin}/board`;
          setSummaryText(formatSummaryText(body.summary, boardUrl));
          setCopied(false);
        }
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Error: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function copySummary() {
    if (!summaryText) return;
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopied(true);
    } catch {
      setCopied(false);
      setMessage('Could not copy automatically — select the text above and copy manually.');
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-court-900 p-4 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/admin" className="text-[13px] text-line-400">← Back to admin</Link>
      </div>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Sessions</p>

      {/* New session — the create flow is a two-step wizard (date/courts,
          then roster), so it lives on its own page; this is the entry. */}
      <section className="rounded-xl border border-line-700 p-4">
        <p className="text-[13px] font-medium text-line-000">New session</p>
        <p className="mt-1 text-[13px] text-line-400">Set the play date, courts, and roster.</p>
        <Link
          href="/admin/session/new"
          className={`mt-3 inline-flex h-12 items-center rounded-lg border border-line-000 bg-line-000 px-5 text-[15px] font-medium text-court-900 ${TAP}`}
        >
          New session →
        </Link>
      </section>

      {message && <p className="text-[13px] text-signal">{message}</p>}

      <p className="text-[11px] font-medium text-line-400">ALL SESSIONS</p>

      {/* F-2 — the only discovery path to /board. Persists across list
          re-renders (the session flips LIVE→DONE via the same
          onSnapshot listener the instant this appears). */}
      {summaryText && (
        <div className="space-y-2 rounded-xl border border-line-000 bg-court-800 p-4">
          <p className="text-[13px] font-medium text-line-000">Session ended — paste this into the group chat:</p>
          <textarea
            readOnly
            value={summaryText}
            rows={7}
            onFocus={e => e.currentTarget.select()}
            className="w-full rounded-lg border border-line-700 bg-transparent p-3 text-[13px] text-line-000"
          />
          <div className="flex gap-2">
            <button
              onClick={copySummary}
              className={`min-h-[44px] flex-1 rounded-lg border border-line-000 bg-line-000 text-[14px] font-medium text-court-900 ${TAP}`}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button
              onClick={() => setSummaryText(null)}
              className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

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
                    {s.status === 'LIVE' && <Link href="/session" className={`text-line-400 underline ${TAP}`}>Open</Link>}
                    {s.status === 'DRAFT' && <Link href="/admin/session/new" className={`text-line-400 underline ${TAP}`}>Edit</Link>}
                    {(s.status === 'LIVE' || s.status === 'DONE') && (
                      <Link href={`/history?session=${s.id}`} className={`text-line-400 underline ${TAP}`}>History</Link>
                    )}
                    {s.status === 'LIVE' && (
                      <button
                        disabled={busy}
                        onClick={() => setConfirmId(s.id)}
                        className={`text-line-700 disabled:opacity-40 ${TAP}`}
                      >
                        End
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => { setDeleteConfirmId(s.id); setDeleteText(''); }}
                      className={`text-signal disabled:opacity-40 ${TAP}`}
                    >
                      Delete
                    </button>
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

                {deleteConfirmId === s.id && (
                  <div className="space-y-2 border-t border-line-700 bg-court-800 p-3">
                    <p className="text-[13px] text-line-400">
                      Delete this session ({formatPlayDate(s.date)}) permanently? This can&apos;t be undone
                      {s.status !== 'DRAFT' ? ' — every recorded match for it goes with it.' : '.'}
                    </p>
                    <input
                      type="text"
                      value={deleteText}
                      onChange={e => setDeleteText(e.target.value)}
                      placeholder="Type delete to confirm"
                      className="h-11 w-full rounded-lg border border-line-700 bg-transparent px-3 text-[15px] text-line-000 placeholder:text-line-400"
                    />
                    <div className="flex gap-2">
                      <button
                        disabled={busy || deleteText.trim().toLowerCase() !== 'delete'}
                        onClick={() => deleteSessionAction(s.id)}
                        className={`min-h-[44px] flex-1 rounded-lg border border-signal bg-signal text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => { setDeleteConfirmId(null); setDeleteText(''); }}
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

export default function AllSessionsPage() {
  return (
    <AdminGate>
      <AllSessionsPageInner />
    </AdminGate>
  );
}
