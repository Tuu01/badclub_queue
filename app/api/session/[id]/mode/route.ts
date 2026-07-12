import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { setMode } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';

const MODES = ['OFF', 'RECORD', 'ASSIGN'] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'sai mã' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { mode } = body ?? {};
  if (!MODES.includes(mode)) {
    return NextResponse.json({ error: 'mode phải là OFF/RECORD/ASSIGN' }, { status: 400 });
  }

  await setMode(adminDb, id, mode);
  return NextResponse.json({ ok: true });
}
