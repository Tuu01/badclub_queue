'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useActiveSession } from '@/lib/use-active-session';
import { writeFetch } from '@/lib/client-code';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../shared-ui';
import { AdminGate } from './admin-gate';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

// "Recalculate everything" — replays every non-VOID session from seed.
// Idempotent, so safe to run any time. This is the escape hatch for
// UC-2 (VOID a game someone says they didn't play) and for changing the
// rating maths later: fix the formula, press this, all history recomputes.
function RecalculateCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await writeFetch('/api/admin/recalculate', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setResult(`Recomputed ${body.replayedGames} games across ${body.replayedSessions} sessions.` +
          (body.warnings?.length ? ` ⚠ ${body.warnings.length} warning(s).` : ''));
        setConfirming(false);
      } else {
        setResult(`Error: ${body?.error ?? res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line-700 p-4">
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Recalculate everything</p>
      <p className="mt-1 text-[13px] text-line-400">
        Replays every non-VOID session from each player&apos;s seed and rewrites all ratings and pair
        history. Use after VOIDing a session, or after a rating-formula change. Safe to run any time.
      </p>
      {!confirming ? (
        <button
          onClick={() => { setConfirming(true); setResult(null); }}
          className={`mt-3 min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-000 ${TAP}`}
        >
          Recalculate everything
        </button>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={run}
            className={`min-h-[44px] flex-1 rounded-lg border border-line-000 bg-line-000 text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
          >
            {busy ? 'Recomputing…' : 'Yes, recompute all history'}
          </button>
          <button
            onClick={() => setConfirming(false)}
            className={`min-h-[44px] rounded-lg border border-line-700 px-4 text-[14px] font-medium text-line-400 ${TAP}`}
          >
            Cancel
          </button>
        </div>
      )}
      {result && <p className="mt-3 text-[13px] text-line-000">{result}</p>}
    </div>
  );
}

function Card({ href, title, subtitle }: { href: string; title: string; subtitle: string }) {
  return (
    <Link
      href={href}
      className={`block rounded-xl border border-line-700 p-4 text-line-000 ${TAP}`}
    >
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>{title}</p>
      <p className="mt-1 text-[13px] text-line-400">{subtitle}</p>
    </Link>
  );
}

function nCr(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  r = Math.min(r, n - r);
  let result = 1;
  for (let i = 0; i < r; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

// Odds that, at a random moment, EVERY manager-code holder happens to be
// on court and nobody is free to tap a result. Hypergeometric: choose
// `playing` of `present` people to be on court; what's the chance all
// `managers` of them land in that group?
function riskNobodyFree(present: number, courts: number, managers: number): number {
  const playing = courts * 4;
  if (managers <= 0 || present <= 0 || managers > present) return managers > present ? 0 : 1;
  return nCr(present - managers, playing - managers) / nCr(present, playing);
}

// "Hand the manager code to 8 people, not 2" — see CLAUDE.md "ROLES".
// Self-reported N (codes aren't tied to identities, so this can't be
// counted automatically) against the CURRENT session's real size, so
// the number is always live, not a hardcoded example.
function ManagerRiskCalculator() {
  const { session } = useActiveSession();
  const [managers, setManagers] = useState(4);

  const present = session
    ? session.status === 'LIVE'
      ? Object.values(session.attendance).filter(a => a.status !== 'LEFT').length
      : session.targetHeadcount
    : 22;
  const courts = session?.courtCount ?? 3;

  const risk = useMemo(() => riskNobodyFree(present, courts, managers), [present, courts, managers]);
  const pct = (risk * 100).toFixed(risk * 100 < 1 ? 2 : 1);

  return (
    <div className="rounded-xl border border-line-700 p-4">
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Manager code</p>
      <p className="mt-1 text-[13px] text-line-400">
        The code isn&apos;t tied to a person — there&apos;s no way to count who actually holds it.
        Enter how many people you&apos;ve given it to.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <input
          type="number"
          min={0}
          value={managers}
          onChange={e => setManagers(Math.max(0, Number(e.target.value) || 0))}
          className="h-12 w-20 rounded-lg border border-line-700 bg-transparent px-3 text-[16px] text-line-000"
        />
        <p className="text-[13px] text-line-400">people have the manager code</p>
      </div>
      <p className="mt-3 text-[13px] text-line-000">
        With {present} people and {courts} court{courts === 1 ? '' : 's'} ({courts * 4} playing at once):
        at any moment there&apos;s a <span className="font-medium">{pct}%</span> chance every manager is on
        court and nobody can record a result.
      </p>
      <p className="mt-1 text-[13px] text-line-400">Aim for 6+.</p>
    </div>
  );
}

export default function AdminHubPage() {
  const actor = useActor();

  return (
    <AdminGate>
      <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-court-900 p-4 text-line-000">
        <div className="flex items-center justify-between">
          {actor && <WhoAmI name={actor.name} short />}
          <Link href="/" className="text-[13px] text-line-400">← Home</Link>
        </div>
        <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Admin</p>

        <Card href="/admin/sessions" title="Sessions" subtitle="Create a session, or view every session by date." />
        <Card href="/admin/players" title="Players" subtitle="Manage the club roster and seed ranking." />
        <Card href="/admin/tournament" title="Tournaments" subtitle="Create and run a tournament, or import history." />

        <ManagerRiskCalculator />
        <RecalculateCard />
      </main>
    </AdminGate>
  );
}
