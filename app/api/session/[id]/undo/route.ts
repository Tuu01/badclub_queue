import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { undoResult } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'MANAGER');
  if (roleErr) return roleErr;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { auditLogId } = body ?? {};
  if (typeof auditLogId !== 'string') {
    return NextResponse.json({ error: 'missing auditLogId' }, { status: 400 });
  }

  const result = await undoResult(adminDb, id, CLUB_ID, auditLogId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
