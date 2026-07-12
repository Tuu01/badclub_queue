import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { createPlayer } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

export async function POST(req: NextRequest) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'sai mã' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const { name, gender, div } = body ?? {};
  if (typeof name !== 'string' || !name.trim() || (gender !== 'M' && gender !== 'F') || (div !== 1 && div !== 2)) {
    return NextResponse.json({ error: 'thiếu name/gender/div hợp lệ' }, { status: 400 });
  }

  const player = await createPlayer(adminDb, CLUB_ID, { name: name.trim(), gender, div });
  return NextResponse.json(player);
}
