'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { writeFetch } from '@/lib/client-code';
import { usePlayers } from '@/lib/use-players';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../../../shared-ui';
import { AdminGate } from '../../../admin/admin-gate';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';
interface Team { id: string; name: string; playerIds: string[]; }

// PHASE 2 — the one-time gate. The admin drew teams on paper; this is
// data entry. TAP-TO-SELECT, not drag-and-drop (phone-friendly, pure
// onClick): pick a team, then tap players in/out of it. Finalize freezes
// it forever and this screen never returns.
function Inner({ tid }: { tid: string }) {
  const router = useRouter();
  const actor = useActor();
  const { players, loading } = usePlayers();
  const [teams, setTeams] = useState<Team[]>([
    { id: 't1', name: 'Team 1', playerIds: [] },
    { id: 't2', name: 'Team 2', playerIds: [] },
  ]);
  const [activeTeam, setActiveTeam] = useState('t1');
  const [status, setStatus] = useState<'loading' | 'ready' | 'gone'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load any teams already saved; if finalized, this screen is closed.
  useEffect(() => {
    fetch(`/api/tournament/${tid}`).then(r => (r.ok ? r.json() : null)).then(d => {
      if (!d) { setStatus('gone'); return; }
      if (d.tournament.teamsFinalized) { router.replace(`/tournament/${tid}/run`); return; }
      if (d.tournament.teams?.length) setTeams(d.tournament.teams.map((t: Team) => ({ id: t.id, name: t.name, playerIds: t.playerIds })));
      setStatus('ready');
    });
  }, [tid, router]);

  const active = useMemo(
    () => players.filter(p => p.active && !p.isGuest).sort((a, b) => a.div - b.div || a.seedRank - b.seedRank),
    [players],
  );
  const teamOf = (pid: string) => teams.find(t => t.playerIds.includes(pid));

  function tapPlayer(pid: string) {
    setTeams(prev => {
      const onActive = prev.find(t => t.id === activeTeam)?.playerIds.includes(pid);
      return prev.map(t => {
        if (onActive) return t.id === activeTeam ? { ...t, playerIds: t.playerIds.filter(x => x !== pid) } : t;
        // move to active team (remove from any other)
        if (t.id === activeTeam) return { ...t, playerIds: [...t.playerIds.filter(x => x !== pid), pid] };
        return { ...t, playerIds: t.playerIds.filter(x => x !== pid) };
      });
    });
  }
  function addTeam() {
    if (teams.length >= 6) return;
    const n = teams.length + 1;
    setTeams(t => [...t, { id: `t${n}`, name: `Team ${n}`, playerIds: [] }]);
  }

  async function save(thenFinalize: boolean) {
    setBusy(true); setError(null);
    try {
      const res = await writeFetch(`/api/tournament/${tid}`, { method: 'POST', body: JSON.stringify({ action: 'saveTeams', teams }) });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? 'Save failed'); return; }
      if (!thenFinalize) { setError(null); return; }
      const fin = await writeFetch(`/api/tournament/${tid}`, { method: 'POST', body: JSON.stringify({ action: 'finalize' }) });
      if (!fin.ok) { setError((await fin.json().catch(() => null))?.error ?? 'Finalize failed'); return; }
      router.replace(`/tournament/${tid}/run`);
    } finally { setBusy(false); }
  }

  if (status === 'gone') return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Tournament not found.</main>;
  if (status === 'loading' || loading) return <main className="flex min-h-dvh items-center justify-center bg-court-900 text-line-400">Loading…</main>;

  const TEAM_COLORS = ['text-signal', 'text-live', 'text-line-000', 'text-line-400', 'text-signal', 'text-live'];
  const badge = (pid: string) => {
    const t = teamOf(pid); if (!t) return null;
    const i = teams.findIndex(x => x.id === t.id);
    return <span className={`ml-1 text-[11px] ${TEAM_COLORS[i]}`}>{t.name.replace('Team ', 'T')}</span>;
  };
  const byDiv = (d: 1 | 2) => active.filter(p => p.div === d);

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-5 bg-court-900 p-4 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/admin/tournament" className="text-[13px] text-line-400">← Tournaments</Link>
      </div>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Set up teams</p>
      <p className="text-[13px] text-line-400">
        Pick a team, then tap players into it. Tap again to remove. Draw the teams yourself — the app doesn&apos;t.
      </p>

      {/* team selector */}
      <div className="flex flex-wrap gap-2">
        {teams.map(t => (
          <button key={t.id} onClick={() => setActiveTeam(t.id)}
            className={`min-h-[44px] rounded-lg border px-4 text-[14px] font-medium ${TAP} ${
              activeTeam === t.id ? 'border-line-000 bg-line-000 text-court-900' : 'border-line-700 text-line-400'
            }`}>
            {t.name} · {t.playerIds.length}
          </button>
        ))}
        {teams.length < 6 && (
          <button onClick={addTeam} className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] text-line-400 ${TAP}`}>+ team</button>
        )}
      </div>

      {/* roster by division */}
      {([1, 2] as const).map(d => (
        <section key={d}>
          <p className="mb-2 text-[11px] font-medium text-line-400">DIV {d}</p>
          <div className="grid grid-cols-2 gap-2">
            {byDiv(d).map(p => {
              const t = teamOf(p.id);
              const onActive = t?.id === activeTeam;
              return (
                <button key={p.id} onClick={() => tapPlayer(p.id)}
                  className={`min-h-[48px] rounded-lg border px-3 text-left font-display text-[16px] ${TAP} ${
                    onActive ? 'border-line-000 bg-line-000 text-court-900' : t ? 'border-line-700 text-line-400' : 'border-line-700 text-line-000'
                  }`} style={{ fontStretch: '105%' }}>
                  {p.name}{!onActive && badge(p.id)}
                </button>
              );
            })}
            {byDiv(d).length === 0 && <p className="col-span-2 text-[13px] text-line-400">No players in this division.</p>}
          </div>
        </section>
      ))}

      {error && <p className="text-[13px] text-signal">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => save(false)}
          className={`min-h-[48px] flex-1 rounded-lg border border-line-700 text-[15px] font-medium text-line-000 disabled:opacity-40 ${TAP}`}>Save</button>
        <button disabled={busy} onClick={() => save(true)}
          className={`min-h-[48px] flex-1 rounded-lg border border-signal bg-signal text-[15px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}>
          Finalize teams (freezes)
        </button>
      </div>
      <p className="pb-8 text-[12px] text-line-700">
        Finalize is one-way — teams freeze for the whole tournament. A no-show is handled by a logged substitution during play, not by redrawing.
      </p>
    </main>
  );
}

export default function SetupPage({ params }: { params: Promise<{ tid: string }> }) {
  const { tid } = use(params);
  return <AdminGate><Inner tid={tid} /></AdminGate>;
}
