import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { addGuest } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'MANAGER');
  if (roleErr) return roleErr;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { name, gender } = body ?? {};
  if (typeof name !== 'string' || !name.trim() || (gender !== 'M' && gender !== 'F')) {
    return NextResponse.json({ error: 'missing valid name/gender' }, { status: 400 });
  }

  const result = await addGuest(adminDb, id, { name: name.trim(), gender });
  return NextResponse.json(result);
}
