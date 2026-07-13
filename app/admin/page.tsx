'use client';

import Link from 'next/link';
import { useActiveSession } from '@/lib/use-active-session';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

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

export default function AdminHubPage() {
  const { session, loading } = useActiveSession();

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-court-900 p-4 text-line-000">
      <p className="font-display text-xl" style={{ fontStretch: '115%' }}>Admin</p>

      <Card href="/admin/session/new" title="New session" subtitle="Set the play date and roster." />
      <Card href="/admin/players" title="Players" subtitle="Manage the club roster and seed ranking." />
      {!loading && session && (
        <Card
          href="/"
          title="Go to session"
          subtitle={session.status === 'LIVE' ? 'Session is live.' : `Upcoming — ${session.date}.`}
        />
      )}
    </main>
  );
}
