'use client';

import Link from 'next/link';
import { useRole } from '@/lib/client-role';
import { enterCode } from '@/lib/client-code';

// /admin is create/edit/delete sessions + CRUD players — ADMIN-tier, not
// MANAGER (see CLAUDE.md "ROLES"). The link here is already hidden from
// non-admins on `/`, but this gates every /admin/* page directly too, in
// case someone lands here via a bookmark or typed URL — same "hide, not
// grey" rule, just applied at the page level instead of the button level.
export function AdminGate({ children }: { children: React.ReactNode }) {
  const role = useRole();
  if (role !== 'ADMIN') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-court-900 px-4 text-center text-line-000">
        <p className="text-line-400">This needs the admin code.</p>
        <button
          type="button"
          onClick={() => void enterCode()}
          className="min-h-[44px] text-[13px] text-line-000 underline"
        >
          Enter admin code
        </button>
        <Link href="/" className="min-h-[44px] text-[13px] text-line-400 underline">← Home</Link>
      </main>
    );
  }
  return <>{children}</>;
}
