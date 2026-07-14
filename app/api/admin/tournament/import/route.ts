import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { importTournament, type TournamentImportInput } from '@/lib/tournament';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// ADMIN only. Body: { input: <vlong-clean.json shape>, dryRun: boolean }.
// dryRun true → returns the preview (what it WOULD create) without
// writing. dryRun false → writes, but STILL returns wrote:false if any
// referenced name is unknown (nothing is written in that case).
export async function POST(req: NextRequest) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const body = await req.json().catch(() => null);
  const input = body?.input as TournamentImportInput | undefined;
  const dryRun = body?.dryRun !== false; // default to the SAFE side

  if (!input?.tournament?.name || !input?.tournament?.date || !Array.isArray(input?.games)) {
    return NextResponse.json({ error: 'input needs tournament.name, tournament.date, and games[]' }, { status: 400 });
  }

  const preview = await importTournament(adminDb, CLUB_ID, input, { dryRun });
  return NextResponse.json(preview);
}
