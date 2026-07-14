import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { reorderDivision } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

export async function POST(req: NextRequest) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const body = await req.json().catch(() => null);
  const { div, orderedIds } = body ?? {};
  if ((div !== 1 && div !== 2) || !Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ error: 'missing valid div/orderedIds' }, { status: 400 });
  }

  await reorderDivision(adminDb, CLUB_ID, div, orderedIds);
  return NextResponse.json({ ok: true });
}
