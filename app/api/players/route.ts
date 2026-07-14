import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { createPlayer } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

export async function POST(req: NextRequest) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const body = await req.json().catch(() => null);
  const { name, gender, div } = body ?? {};
  if (typeof name !== 'string' || !name.trim() || (gender !== 'M' && gender !== 'F') || (div !== 1 && div !== 2)) {
    return NextResponse.json({ error: 'missing valid name/gender/div' }, { status: 400 });
  }

  const player = await createPlayer(adminDb, CLUB_ID, { name: name.trim(), gender, div });
  return NextResponse.json(player);
}
