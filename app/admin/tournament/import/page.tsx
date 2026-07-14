'use client';

import { useState } from 'react';
import Link from 'next/link';
import { writeFetch } from '@/lib/client-code';
import { useActor } from '@/lib/client-identity';
import { WhoAmI } from '../../../shared-ui';
import { AdminGate } from '../../admin-gate';
import type { ImportPreview } from '@/lib/tournament';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

// Historical tournament import — paste the JSON, PREVIEW (what it would
// create, and any unknown names), then Import. Preview always runs
// first; the Import button only enables once a clean preview came back.
function ImportInner() {
  const actor = useActor();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportPreview | null>(null);

  function parse(): unknown | null {
    try { return JSON.parse(text); } catch { setError('That is not valid JSON.'); return null; }
  }

  async function run(dryRun: boolean) {
    const input = parse();
    if (!input) return;
    setBusy(true); setError(null);
    try {
      const res = await writeFetch('/api/admin/tournament/import', {
        method: 'POST', body: JSON.stringify({ input, dryRun }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? `Error ${res.status}`); return; }
      if (dryRun) { setPreview(body); setDone(null); }
      else if (body.wrote) { setDone(body); setPreview(body); }
      else { setPreview(body); setError('Not written — resolve the unknown names first.'); }
    } finally { setBusy(false); }
  }

  const canImport = preview && preview.unknownNames.length === 0 && !done;

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-court-900 p-4 text-line-000">
      <div className="flex items-center justify-between">
        {actor && <WhoAmI name={actor.name} short />}
        <Link href="/admin" className="text-[13px] text-line-400">← Back to admin</Link>
      </div>
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Import tournament</p>
      <p className="text-[13px] text-line-400">
        Paste the exported JSON. Preview shows exactly what it will create. Import is idempotent by
        name + date — running it twice won&apos;t duplicate. Tournament data never affects skill ratings.
      </p>

      <textarea
        value={text}
        onChange={e => { setText(e.target.value); setPreview(null); setDone(null); setError(null); }}
        rows={10}
        placeholder="Paste vlong-clean.json here…"
        className="w-full rounded-lg border border-line-700 bg-transparent p-3 font-mono text-[12px] text-line-000"
      />

      <div className="flex gap-2">
        <button
          disabled={busy || !text.trim()}
          onClick={() => run(true)}
          className={`min-h-[44px] flex-1 rounded-lg border border-line-000 bg-line-000 text-[14px] font-medium text-court-900 disabled:opacity-40 ${TAP}`}
        >
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button
          disabled={busy || !canImport}
          onClick={() => run(false)}
          className={`min-h-[44px] flex-1 rounded-lg border text-[14px] font-medium disabled:opacity-40 ${TAP} ${
            canImport ? 'border-signal bg-signal text-court-900' : 'border-line-700 text-line-400'
          }`}
        >
          Import
        </button>
      </div>

      {error && <p className="text-[13px] text-signal">{error}</p>}

      {preview && (
        <div className="space-y-2 rounded-xl border border-line-700 p-4 text-[13px]">
          <p className="font-medium text-line-000">
            {done ? '✓ Imported' : 'Preview'} — {preview.tournamentId}
            {preview.alreadyExists && !done ? ' (already exists — will overwrite)' : ''}
          </p>
          <p className="text-line-400">Teams: {preview.teamCount} · Games: {preview.gameCount}</p>
          <p className="text-line-400">
            Players to create: <span className="text-line-000">{preview.playersToCreate.length}</span>
            {preview.playersMatched.length > 0 ? ` · matched existing: ${preview.playersMatched.length}` : ''}
          </p>
          {preview.playersToCreate.length > 0 && (
            <p className="text-line-400">{preview.playersToCreate.map(p => `${p.name} (d${p.div}/${p.gender})`).join(', ')}</p>
          )}
          {preview.unknownNames.length > 0 && (
            <p className="text-signal">
              ⚠ Unknown names (not in club or file) — resolve before importing: {preview.unknownNames.join(', ')}
            </p>
          )}
          {preview.warnings.map((w, i) => <p key={i} className="text-line-400">• {w}</p>)}
          {done && (
            <Link href={`/tournament/${preview.tournamentId}`} className="inline-block pt-1 text-line-000 underline">
              View tournament →
            </Link>
          )}
        </div>
      )}
    </main>
  );
}

export default function ImportPage() {
  return <AdminGate><ImportInner /></AdminGate>;
}
