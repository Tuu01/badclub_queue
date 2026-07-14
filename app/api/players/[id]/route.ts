import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { updatePlayer } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { name, gender, active } = body ?? {};

  const patch: Partial<{ name: string; gender: 'M' | 'F'; active: boolean }> = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim();
  if (gender === 'M' || gender === 'F') patch.gender = gender;
  if (typeof active === 'boolean') patch.active = active;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }

  await updatePlayer(adminDb, CLUB_ID, id, patch);
  return NextResponse.json({ ok: true });
}
