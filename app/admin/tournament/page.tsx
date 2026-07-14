'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { writeFetch } from '@/lib/client-code';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../../shared-ui';
import { AdminGate } from '../admin-gate';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

interface TItem { id: string; name: string; date: string; status: string; teamsFinalized: boolean; imported: boolean; }

// Same treatment as /admin/sessions' StatusLabel — a green-dot LIVE badge.
function StatusLabel({ t }: { t: TItem }) {
  if (t.status === 'LIVE') {
    return (
      <span className="flex items-center gap-1.5 text-live">
        <span className="inline-block h-[7px] w-[7px] rounded-full bg-live" />
        LIVE
      </span>
    );
  }
  if (t.status === 'DONE') return <span className="text-line-700">DONE</span>;
  return <span className="text-line-000">DRAFT</span>;
}

function Inner() {
  const router = useRouter();
  const actor = useActor();
  const [list, setList] = useState<TItem[] | null>(null);
  const [form, setForm] = useState({ name: '', date: '', courtCount: 4 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState('');

  function load() { fetch('/api/tournaments').then(r => r.json()).then(b => setList(b.tournaments)); }
  useEffect(load, []);

  async function del(id: string) {
    if (busy || deleteText.trim().toLowerCase() !== 'delete') return;
    setBusy(true); setError(null);
    try {
      const res = await writeFetch(`/api/tournament/${id}`, { method: 'DELETE' });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? `Error ${res.status}`); return; }
      setDeleteId(null); setDeleteText(''); load();
    } finally { setBusy(false); }
  }

  async function create() {
    if (busy || !form.name.trim() || !form.date.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await writeFetch('/api/admin/tournament/create', { method: 'POST', body: JSON.stringify(form) });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? `Error ${res.status}`); return; }
      // straight into Phase 2 (or run if it somehow already exists finalized)
      router.push(`/tournament/${body.tid}/setup`);
    } finally { setBusy(false); }
  }

  const dest = (t: TItem) =>
    t.status === 'DONE' ? `/tournament/${t.id}`
      : t.teamsFinalized ? `/tournament/${t.id}/run`
        : `/tournament/${t.id}/setup`;

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-6 bg-court-900 p-4 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/admin" className="text-[13px] text-line-400">← Back to admin</Link>
      </div>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Tournaments</p>

      {/* Phase 1 — create */}
      <section className="space-y-3 rounded-xl border border-line-700 p-4">
        <p className="text-[13px] font-medium text-line-000">New tournament</p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-[13px] text-line-400">Name</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="h-12 min-w-[12rem] rounded-lg border border-line-700 bg-transparent px-3 text-[16px] text-line-000" />
          </div>
          <div>
            <label className="mb-1 block text-[13px] text-line-400">Date</label>
            <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="h-12 rounded-lg border border-line-700 bg-court-900 px-3 text-[16px] text-line-000" />
          </div>
          <div>
            <label className="mb-1 block text-[13px] text-line-400">Courts</label>
            <select value={form.courtCount} onChange={e => setForm(f => ({ ...f, courtCount: Number(e.target.value) }))}
              className="h-12 rounded-lg border border-line-700 bg-court-900 px-3 text-[16px] text-line-000">
              {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button disabled={busy} onClick={create}
            className={`h-12 rounded-lg border border-line-000 bg-line-000 px-5 text-[15px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}>
            Create → set up teams
          </button>
        </div>
        <p className="text-[13px] text-line-400">
          Also: <Link href="/admin/tournament/import" className="underline">import a historical tournament</Link>.
        </p>
        {error && <p className="text-[13px] text-signal">{error}</p>}
      </section>

      {/* List */}
      <section>
        <p className="mb-2 text-[11px] font-medium text-line-400">ALL TOURNAMENTS</p>
        {list === null ? <p className="text-[13px] text-line-400">Loading…</p>
          : list.length === 0 ? <p className="text-[13px] text-line-400">None yet.</p>
            : (
              <ul className="divide-y divide-line-700 rounded-xl border border-line-700">
                {list.map(t => (
                  <li key={t.id}>
                    <div className="flex items-center justify-between gap-2 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <span className="font-display text-[17px]" style={{ fontStretch: '105%' }}>{t.name}</span>
                        <span className="block text-[13px] text-line-400">{t.date}{t.imported ? ' · imported' : ''}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-[13px] font-medium">
                        <StatusLabel t={t} />
                        <Link href={dest(t)} className={`text-line-400 underline ${TAP}`}>
                          {t.status === 'DONE' ? 'Standings' : t.teamsFinalized ? 'Open' : 'Set up'}
                        </Link>
                        <button disabled={busy} onClick={() => { setDeleteId(t.id); setDeleteText(''); }} className={`text-signal disabled:opacity-40 ${TAP}`}>
                          Delete
                        </button>
                      </div>
                    </div>

                    {deleteId === t.id && (
                      <div className="space-y-2 border-t border-line-700 bg-court-800 p-3">
                        <p className="text-[13px] text-line-400">
                          Delete <span className="text-line-000">{t.name}</span> permanently? This can&apos;t be undone
                          {t.imported || t.teamsFinalized ? ' — every recorded game goes with it.' : '.'}
                        </p>
                        <input
                          type="text" value={deleteText} onChange={e => setDeleteText(e.target.value)}
                          placeholder="Type delete to confirm"
                          className="h-11 w-full rounded-lg border border-line-700 bg-transparent px-3 text-[15px] text-line-000 placeholder:text-line-400"
                        />
                        <div className="flex gap-2">
                          <button disabled={busy || deleteText.trim().toLowerCase() !== 'delete'} onClick={() => del(t.id)}
                            className={`min-h-[44px] flex-1 rounded-lg border border-signal bg-signal text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}>
                            Delete
                          </button>
                          <button onClick={() => { setDeleteId(null); setDeleteText(''); }}
                            className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
      </section>
    </main>
  );
}

export default function AdminTournamentsPage() {
  return <AdminGate><Inner /></AdminGate>;
}
