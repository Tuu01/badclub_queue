'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { writeFetch } from '@/lib/client-code';
import { useActor } from '@/lib/client-identity';
import type { TournamentView } from '@/lib/tournament';
import type { TournamentGame } from '@/lib/tournament-types';
import { WhoAmI } from '../../../shared-ui';
import { AdminGate } from '../../../admin/admin-gate';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';
type View = TournamentView & { names: Record<string, string> };

// PHASE 3 — the admin runs it courtside for ~4 hours. Denser than the
// session screen (he's standing, not sweating). Court columns, each with
// its live match + queue. Auto-promotion puts the next match ON the
// court; a human taps Start clock. Record → auto-promote → 60s undo.
function Inner({ tid }: { tid: string }) {
  const router = useRouter();
  const actor = useActor();
  const [view, setView] = useState<View | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [last, setLast] = useState<{ auditLogId: string; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refetch = useCallback(async () => {
    const r = await fetch(`/api/tournament/${tid}`);
    if (!r.ok) { setView(null); return; }
    const d = (await r.json()) as View;
    if (!d.tournament.teamsFinalized) { router.replace(`/tournament/${tid}/setup`); return; }
    setView(d);
  }, [tid, router]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tournament/${tid}`).then(r => (r.ok ? r.json() : null)).then((d: View | null) => {
      if (cancelled) return;
      if (!d) { setView(null); return; }
      if (!d.tournament.teamsFinalized) { router.replace(`/tournament/${tid}/setup`); return; }
      setView(d);
    });
    return () => { cancelled = true; };
  }, [tid, router]);
  useEffect(() => { clockRef.current = setInterval(() => setNow(Date.now()), 1000); return () => { if (clockRef.current) clearInterval(clockRef.current); }; }, []);

  async function act(body: object, after?: (b: unknown) => void) {
    setBusy(true); setErr(null);
    try {
      const r = await writeFetch(`/api/tournament/${tid}`, { method: 'POST', body: JSON.stringify(body) });
      const b = await r.json().catch(() => null);
      if (!r.ok || b?.ok === false) { setErr(b?.error ?? `Error ${r.status}`); return; }
      after?.(b);
      await refetch();
    } finally { setBusy(false); }
  }

  if (view === undefined) return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Loading…</main>;
  if (!view) return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Tournament not found.</main>;

  const { tournament: t, games, names } = view;
  const nm = (id: string) => names[id] ?? id;
  const teamName = (id: string) => t.teams.find(x => x.id === id)?.name ?? id;
  const pairNames = (g: TournamentGame, side: 'A' | 'B') =>
    (side === 'A' ? [g.playerIds[0], g.playerIds[1]] : [g.playerIds[2], g.playerIds[3]]).map(nm).join(' & ');
  const undoSecs = last ? Math.max(0, Math.ceil((60_000 - (now - last.at)) / 1000)) : 0;

  async function record(g: TournamentGame, winner: 'A' | 'B') {
    await act({ action: 'result', gid: g.id, winner, actor: actor?.name },
      (b: unknown) => { const r = b as { auditLogId?: string }; if (r.auditLogId) setLast({ auditLogId: r.auditLogId, at: Date.now() }); });
  }

  return (
    <main className="mx-auto min-h-dvh max-w-5xl space-y-4 bg-court-900 p-4 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <div className="flex gap-3 text-[13px] text-line-400">
          <Link href={`/tournament/${tid}`} className="underline">Standings</Link>
          <Link href="/admin/tournament" className="underline">Tournaments</Link>
        </div>
      </div>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>{t.name} · running</p>
      {err && <p className="text-[13px] text-signal">{err}</p>}

      {/* Court columns */}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(t.courtCount, 3)}, minmax(0,1fr))` }}>
        {Array.from({ length: t.courtCount }, (_, c) => {
          const ongoing = games.find(g => g.courtIdx === c && g.status === 'ONGOING');
          const queue = games.filter(g => g.courtIdx === c && g.status === 'SCHEDULED').sort((a, b) => a.id.localeCompare(b.id));
          return (
            <div key={c} className="rounded-xl border border-line-700 bg-court-800 p-3">
              <p className="text-[11px] font-medium text-line-400">COURT {c + 1}</p>
              {ongoing ? (
                <div className="mt-2 space-y-2">
                  <div className="text-[15px]">
                    <p className="font-medium">{pairNames(ongoing, 'A')}</p>
                    <p className="text-[11px] text-line-700">vs</p>
                    <p className="font-medium">{pairNames(ongoing, 'B')}</p>
                  </div>
                  {ongoing.startedAt == null ? (
                    <button disabled={busy} onClick={() => act({ action: 'start', gid: ongoing.id })}
                      className={`min-h-[44px] w-full rounded-lg border border-line-000 bg-line-000 text-[14px] font-medium text-court-900 ${TAP}`}>
                      Start clock
                    </button>
                  ) : (
                    <p className="tabular text-[13px] text-line-400">
                      {Math.floor((now - ongoing.startedAt) / 60000)}:{String(Math.floor(((now - ongoing.startedAt) % 60000) / 1000)).padStart(2, '0')}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-1">
                    <button disabled={busy} onClick={() => record(ongoing, 'A')}
                      className={`min-h-[44px] rounded-lg border border-line-700 px-1 text-[13px] font-medium text-line-000 disabled:opacity-40 ${TAP}`}>
                      {teamName(ongoing.teamA)} won
                    </button>
                    <button disabled={busy} onClick={() => record(ongoing, 'B')}
                      className={`min-h-[44px] rounded-lg border border-line-700 px-1 text-[13px] font-medium text-line-000 disabled:opacity-40 ${TAP}`}>
                      {teamName(ongoing.teamB)} won
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-[13px] text-line-700">Court free.</p>
              )}
              {queue.length > 0 && (
                <div className="mt-3 border-t border-line-700 pt-2">
                  <p className="text-[11px] text-line-700">up next · {queue.length}</p>
                  {queue.map(g => (
                    <p key={g.id} className="mt-1 text-[12px] text-line-400">{pairNames(g, 'A')} vs {pairNames(g, 'B')}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ScheduleForm view={view} busy={busy} onSchedule={(b) => act(b)} />
      <SubstituteForm view={view} busy={busy} onSub={(b) => act(b)} />

      {/* 60s undo */}
      {last && undoSecs > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-sm p-4">
          <div className="flex items-center justify-between rounded-xl border border-line-700 bg-court-800 px-4 py-3 text-[13px]">
            <span>Recorded · {undoSecs}s</span>
            <button disabled={busy} onClick={() => act({ action: 'undo', auditLogId: last.auditLogId }, () => setLast(null))}
              className="font-medium text-line-000 underline">Undo</button>
          </div>
        </div>
      )}
    </main>
  );
}

// pick teamA/teamB, 2 players from each, a court, a round label → schedule.
function ScheduleForm({ view, busy, onSchedule }: { view: View; busy: boolean; onSchedule: (b: object) => void }) {
  const { tournament: t, names } = view;
  const [teamA, setTeamA] = useState(t.teams[0]?.id ?? '');
  const [teamB, setTeamB] = useState(t.teams[1]?.id ?? '');
  const [pairA, setPairA] = useState<string[]>([]);
  const [pairB, setPairB] = useState<string[]>([]);
  const [courtIdx, setCourtIdx] = useState(0);
  const [round, setRound] = useState('RR');
  const rosterOf = (tid: string) => t.teams.find(x => x.id === tid)?.playerIds ?? [];
  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter(x => x !== id) : arr.length < 2 ? [...arr, id] : arr);
  const ready = teamA && teamB && teamA !== teamB && pairA.length === 2 && pairB.length === 2;

  const chip = (id: string, on: boolean, onTap: () => void) => (
    <button key={id} onClick={onTap} className={`min-h-[40px] rounded-lg border px-2 text-[13px] ${TAP} ${on ? 'border-line-000 bg-line-000 text-court-900' : 'border-line-700 text-line-000'}`}>
      {names[id] ?? id}
    </button>
  );

  return (
    <section className="space-y-3 rounded-xl border border-line-700 p-4">
      <p className="text-[13px] font-medium text-line-000">Schedule a match</p>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <select value={teamA} onChange={e => { setTeamA(e.target.value); setPairA([]); }} className="h-10 rounded-lg border border-line-700 bg-court-900 px-2 text-line-000">
          {t.teams.map(tm => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
        </select>
        <span className="text-line-700">vs</span>
        <select value={teamB} onChange={e => { setTeamB(e.target.value); setPairB([]); }} className="h-10 rounded-lg border border-line-700 bg-court-900 px-2 text-line-000">
          {t.teams.map(tm => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
        </select>
        <select value={courtIdx} onChange={e => setCourtIdx(Number(e.target.value))} className="h-10 rounded-lg border border-line-700 bg-court-900 px-2 text-line-000">
          {Array.from({ length: t.courtCount }, (_, i) => <option key={i} value={i}>Court {i + 1}</option>)}
        </select>
        <input value={round} onChange={e => setRound(e.target.value)} placeholder="round" className="h-10 w-20 rounded-lg border border-line-700 bg-transparent px-2 text-line-000" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-wrap gap-1">{rosterOf(teamA).map(id => chip(id, pairA.includes(id), () => toggle(pairA, setPairA, id)))}</div>
        <div className="flex flex-wrap gap-1">{rosterOf(teamB).map(id => chip(id, pairB.includes(id), () => toggle(pairB, setPairB, id)))}</div>
      </div>
      <button disabled={busy || !ready}
        onClick={() => onSchedule({ action: 'schedule', round, courtIdx, teamA, teamB, pairA, pairB })}
        className={`min-h-[44px] w-full rounded-lg border border-signal bg-signal text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}>
        Add to court {courtIdx + 1}
      </button>
    </section>
  );
}

function SubstituteForm({ view, busy, onSub }: { view: View; busy: boolean; onSub: (b: object) => void }) {
  const { tournament: t, names } = view;
  const [open, setOpen] = useState(false);
  const [teamId, setTeamId] = useState(t.teams[0]?.id ?? '');
  const [out, setOut] = useState('');
  const [inn, setInn] = useState('');
  const roster = t.teams.find(x => x.id === teamId)?.playerIds ?? [];
  const onTeams = new Set(t.teams.flatMap(x => x.playerIds));
  const candidates = Object.keys(names).filter(id => !onTeams.has(id));

  if (!open) return <button onClick={() => setOpen(true)} className={`text-[13px] text-line-400 underline ${TAP}`}>Substitute a no-show…</button>;
  return (
    <section className="space-y-2 rounded-xl border border-line-700 p-4 text-[13px]">
      <p className="font-medium text-line-000">Substitute (team stays frozen — logged)</p>
      <div className="flex flex-wrap gap-2">
        <select value={teamId} onChange={e => { setTeamId(e.target.value); setOut(''); }} className="h-10 rounded-lg border border-line-700 bg-court-900 px-2 text-line-000">
          {t.teams.map(tm => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
        </select>
        <select value={out} onChange={e => setOut(e.target.value)} className="h-10 rounded-lg border border-line-700 bg-court-900 px-2 text-line-000">
          <option value="">out…</option>{roster.map(id => <option key={id} value={id}>{names[id] ?? id}</option>)}
        </select>
        <select value={inn} onChange={e => setInn(e.target.value)} className="h-10 rounded-lg border border-line-700 bg-court-900 px-2 text-line-000">
          <option value="">in…</option>{candidates.map(id => <option key={id} value={id}>{names[id] ?? id}</option>)}
        </select>
        <button disabled={busy || !out || !inn} onClick={() => { onSub({ action: 'substitute', teamId, out, in: inn }); setOpen(false); setOut(''); setInn(''); }}
          className={`h-10 rounded-lg border border-line-000 bg-line-000 px-4 font-medium text-court-900 disabled:opacity-40 ${TAP}`}>Log</button>
      </div>
    </section>
  );
}

export default function RunPage({ params }: { params: Promise<{ tid: string }> }) {
  const { tid } = use(params);
  return <AdminGate><Inner tid={tid} /></AdminGate>;
}
