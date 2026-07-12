import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { addGuest } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'sai mã' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { name, gender } = body ?? {};
  if (typeof name !== 'string' || !name.trim() || (gender !== 'M' && gender !== 'F')) {
    return NextResponse.json({ error: 'thiếu name/gender hợp lệ' }, { status: 400 });
  }

  const result = await addGuest(adminDb, id, { name: name.trim(), gender });
  return NextResponse.json(result);
}
