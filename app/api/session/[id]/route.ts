import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { deleteSession } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';

// ADMIN-tier — "create/edit/delete sessions" per CLAUDE.md ROLES, not
// undoable. Works on any status (DRAFT/LIVE/DONE), unlike the
// DRAFT-only delete at /api/session/[id]/draft (which a different
// flow — fixing a wrong play date — still relies on).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const { id } = await params;
  await deleteSession(adminDb, id);
  return NextResponse.json({ ok: true });
}
