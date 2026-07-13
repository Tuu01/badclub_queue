import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { updatePlayer } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

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
