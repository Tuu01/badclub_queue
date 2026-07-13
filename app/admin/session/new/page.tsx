'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { usePlayers } from '@/lib/use-players';
import { useActiveSession } from '@/lib/use-active-session';
import { writeFetch } from '@/lib/client-code';
import { nextSaturday } from '@/lib/session-id';
import { estimateSession, safeHeadcount } from '@/lib/session-estimate';
import { matchPastedNames, type MatchedLine } from '@/lib/fuzzy-match';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

export default function NewSessionPage() {
  const router = useRouter();
  const { players, loading } = usePlayers();
  const active = useMemo(() => players.filter(p => p.active), [players]);

  const [step, setStep] = useState<1 | 2>(1);
  const [playDate, setPlayDate] = useState(() => nextSaturday());
  const [courts, setCourts] = useState(3);
  const [headcount, setHeadcount] = useState(22);
  const estimate = estimateSession(courts, headcount);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pasteText, setPasteText] = useState('');
  const [matches, setMatches] = useState<MatchedLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Editing the existing next-up DRAFT (wrong date/headcount/courts) is
  // cheap because nothing's checked in yet — see lib/firestore.ts
  // #setDraftRoster. Only ever edits the ONE nearest DRAFT
  // useActiveSession() resolves; if a LIVE session is happening right
  // now, this always behaves as "create a new one" instead (editing a
  // later-scheduled DRAFT while another session is live isn't handled
  // this pass — rare enough to accept).
  //
  // Pre-filling from the resolved DRAFT is done by adjusting state
  // DURING RENDER (React's documented pattern for "sync from an
  // external value once, then let the user edit locally") rather than
  // in a useEffect — calling setState directly in an effect body
  // triggers an extra cascading render and is exactly what
  // react-hooks/set-state-in-effect flags.
  const { session: activeSession } = useActiveSession();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [syncedDraftId, setSyncedDraftId] = useState<string | null>(null);

  if (activeSession && activeSession.status === 'DRAFT' && syncedDraftId === null) {
    setSyncedDraftId(activeSession.id);
    setEditingId(activeSession.id);
    setPlayDate(activeSession.date);
    setCourts(activeSession.courtCount);
    setHeadcount(activeSession.targetHeadcount);
    setSelected(new Set(Object.keys(activeSession.players)));
  }

  function runMatch() {
    const results = matchPastedNames(pasteText, active.map(p => ({ id: p.id, name: p.name })));
    setMatches(results);
    setSelected(prev => {
      const next = new Set(prev);
      for (const r of results) if (r.best) next.add(r.best.id);
      return next;
    });
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Sorted by LONGEST ABSENT — not a ranking, no judgment about why
  // (see PROMPT.md: "NO ⚠️, no red"). Never played (lastPlayedAt=null)
  // sorts first — the longest absence imaginable.
  const notSelected = useMemo(
    () =>
      active
        .filter(p => !selected.has(p.id))
        .sort((a, b) => (a.lastPlayedAt ?? -Infinity) - (b.lastPlayedAt ?? -Infinity)),
    [active, selected],
  );

  const selectedList = useMemo(
    () => active.filter(p => selected.has(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [active, selected],
  );

  async function confirm() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // Editing the same draft, date unchanged → edit in place.
      if (editingId && editingId === playDate) {
        const res = await writeFetch(`/api/session/${editingId}/draft`, {
          method: 'PUT',
          body: JSON.stringify({ courtCount: courts, playerIds: [...selected] }),
        });
        if (res.ok) { router.push('/admin'); return; }
        const body = await res.json().catch(() => null);
        setMessage(`Error: ${body?.error ?? res.status}`);
        return;
      }

      // Editing, but the date changed — the date IS the document id,
      // so there's no rename: delete the wrong-date draft, then create
      // a fresh one at the corrected date with the (possibly further
      // edited) roster.
      if (editingId && editingId !== playDate) {
        const delRes = await writeFetch(`/api/session/${editingId}/draft`, { method: 'DELETE' });
        if (!delRes.ok) {
          const body = await delRes.json().catch(() => null);
          setMessage(`Error deleting the old draft: ${body?.error ?? delRes.status}`);
          return;
        }
      }

      const res = await writeFetch(`/api/session/${playDate}/roster`, {
        method: 'POST',
        body: JSON.stringify({ courtCount: courts, playerIds: [...selected] }),
      });
      if (res.ok) {
        router.push('/admin');
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Error: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!editingId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await writeFetch(`/api/session/${editingId}/draft`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/admin');
      } else {
        const body = await res.json().catch(() => null);
        setMessage(`Error: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="min-h-dvh bg-court-900 p-4 text-line-400">Loading…</main>;

  if (step === 1) {
    return (
      <main className="mx-auto min-h-dvh max-w-2xl space-y-6 bg-court-900 p-4 text-line-000">
        <Link href="/admin" className="block text-[13px] text-line-400">← Back to admin</Link>
        <p className="font-display text-xl" style={{ fontStretch: '115%' }}>
          {editingId ? 'Edit next session — Step 1' : 'New session — Step 1'}
        </p>

        <div className="flex items-center gap-3">
          <label className="w-32 text-[13px] text-line-400">Play date</label>
          <input
            type="date" value={playDate}
            onChange={e => setPlayDate(e.target.value)}
            className="tabular h-14 rounded-xl border border-line-700 bg-transparent px-3 text-[16px] text-line-000"
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="w-32 text-[13px] text-line-400">Courts</label>
          <input
            type="number" min={1} max={8} value={courts}
            onChange={e => setCourts(Math.max(1, Number(e.target.value) || 1))}
            className="tabular h-14 w-24 rounded-xl border border-line-700 bg-transparent px-3 text-[16px] text-line-000"
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="w-32 text-[13px] text-line-400">Expected headcount</label>
          <input
            type="number" min={1} value={headcount}
            onChange={e => setHeadcount(Math.max(1, Number(e.target.value) || 1))}
            className="tabular h-14 w-24 rounded-xl border border-line-700 bg-transparent px-3 text-[16px] text-line-000"
          />
        </div>

        {estimate && (
          <div className="rounded-xl border border-line-700 p-3 text-[13px] text-line-400">
            <p>
              ~{estimate.gamesPerPerson.toFixed(1)} games/person · sitting out{' '}
              {Math.round(estimate.sittingOutFraction * 100)}% of the time
            </p>
            {estimate.poolTooSmall && (
              <p className="mt-2 text-line-000">
                Only {estimate.pool} people sitting out at once — the algorithm loses its freedom
                to mix people and falls back to almost pure FIFO. Safe: {safeHeadcount(courts)}+
                people with {courts} courts.
              </p>
            )}
          </div>
        )}

        <button
          onClick={() => setStep(2)}
          className={`min-h-[56px] w-full rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 ${TAP}`}
        >
          Continue
        </button>

        {editingId && (
          confirmDelete ? (
            <div className="space-y-2 rounded-xl border border-line-700 p-3">
              <p className="text-[13px] text-line-400">
                Delete this draft ({playDate})? Nobody has checked in, so nothing is lost — but it can&apos;t be undone.
              </p>
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={deleteDraft}
                  className={`min-h-[48px] flex-1 rounded-lg border border-signal bg-signal text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className={`min-h-[48px] rounded-lg border border-line-700 px-4 text-[16px] font-medium text-line-400 ${TAP}`}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className={`min-h-[44px] w-full text-[13px] text-line-700 ${TAP}`}
            >
              Delete this draft
            </button>
          )
        )}

        {message && <p className="text-center text-[13px] text-line-400">{message}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-6 bg-court-900 p-4 text-line-000">
      <Link href="/admin" className="block text-[13px] text-line-400">← Back to admin</Link>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>
        {editingId ? 'Edit next session — Step 2' : 'New session — Step 2'}
      </p>
      <p className="text-[13px] text-line-400">{playDate} · {courts} courts · target {headcount} people</p>

      <div className="space-y-2">
        <label className="text-[13px] font-medium text-line-400">Paste the list from the group chat</label>
        <textarea
          value={pasteText}
          onChange={e => setPasteText(e.target.value)}
          rows={6}
          placeholder={'Cuong\nHa\nLan\n...'}
          className="w-full rounded-xl border border-line-700 bg-transparent p-3 text-[16px] text-line-000 placeholder:text-line-400"
        />
        <button onClick={runMatch} className={`min-h-[48px] rounded-xl border border-line-000 bg-line-000 px-4 text-[16px] font-medium text-court-900 ${TAP}`}>
          Match names
        </button>
      </div>

      {matches && (
        <div className="space-y-2 rounded-xl border border-line-700 p-3">
          <p className="text-[13px] font-medium text-line-400">
            Match results ({matches.filter(m => m.best).length}/{matches.length} matched)
          </p>
          <ul className="space-y-1 text-[13px]">
            {matches.map((m, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span className="text-line-000">{m.raw}</span>
                {m.best ? (
                  <span className={selected.has(m.best.id) ? 'text-line-000' : 'text-line-400'}>
                    → {m.best.name}
                  </span>
                ) : (
                  <span className="text-line-400">no match</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-2 text-[11px] font-medium text-line-400">selected · {selectedList.length} people</p>
        <div className="grid grid-cols-2 gap-2">
          {selectedList.map(p => (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className={`min-h-[48px] rounded-lg border border-line-000 bg-line-000 px-2 text-left font-display text-[17px] text-court-900 ${TAP}`}
              style={{ fontStretch: '105%' }}
            >
              {p.name}
            </button>
          ))}
          {selectedList.length === 0 && <p className="col-span-2 text-[13px] text-line-400">Nobody selected yet.</p>}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-medium text-line-400">not selected · sorted by longest absent</p>
        <div className="grid grid-cols-2 gap-2">
          {notSelected.map(p => (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className={`min-h-[48px] rounded-lg border border-line-700 px-2 text-left font-display text-[17px] text-line-000 ${TAP}`}
              style={{ fontStretch: '105%' }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setStep(1)} className={`min-h-[56px] rounded-xl border border-line-700 px-4 text-[16px] font-medium text-line-400 ${TAP}`}>
          Back
        </button>
        <button
          disabled={selected.size === 0 || busy}
          onClick={confirm}
          className={`min-h-[56px] flex-1 rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
        >
          {editingId ? 'Save changes' : 'Create session'}
        </button>
      </div>

      {message && <p className="text-center text-[13px] text-line-400">{message}</p>}
    </main>
  );
}
