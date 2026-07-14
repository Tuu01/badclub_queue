import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { createTournament } from '@/lib/tournament';
import { requireRole } from '@/lib/auth';

// ADMIN — Phase 1. Idempotent by name+date (created:false if it exists).
export async function POST(req: NextRequest) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => null);
  const { name, date, venue, courtCount } = body ?? {};
  if (typeof name !== 'string' || !name.trim() || typeof date !== 'string' || !date.trim()
    || !Number.isInteger(courtCount) || courtCount < 1 || courtCount > 6) {
    return NextResponse.json({ error: 'need name, date, and courtCount (1-6)' }, { status: 400 });
  }
  const res = await createTournament(adminDb, { name, date, venue, courtCount });
  return NextResponse.json(res);
}
