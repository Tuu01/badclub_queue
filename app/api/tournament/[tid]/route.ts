import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import {
  getTournamentView, saveTeams, finalizeTeams, endTournament, addSubstitution,
  scheduleGame, startClock, recordTournamentResult, undoTournamentResult, deleteTournament,
} from '@/lib/tournament';
import type { PublicPlayerDoc } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// PLAYER-tier — view-only, public read (same as /board). Winrates are
// computed on read inside getTournamentView. Adds an id→name map so the
// client can render without a second round-trip.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const view = await getTournamentView(adminDb, tid);
  if (!view) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const names: Record<string, string> = {};
  const playersSnap = await adminDb.collection(`clubs/${CLUB_ID}/players`).get();
  for (const d of playersSnap.docs) {
    const p = d.data() as PublicPlayerDoc;
    names[p.id] = p.name;
  }
  return NextResponse.json({ ...view, names });
}

// ADMIN — delete a tournament outright (doc + games + audit). Same as
// the session delete; the UI gates it behind a type-"delete" confirm.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ tid: string }> }) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;
  const { tid } = await params;
  await deleteTournament(adminDb, tid);
  return NextResponse.json({ ok: true });
}

// One POST endpoint, action-discriminated. Structural actions (setup,
// finalize, schedule) are ADMIN; courtside operations (substitute, start
// clock, record, undo) are MANAGER+ so helpers can run a court.
export async function POST(req: NextRequest, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  const ADMIN = ['saveTeams', 'finalize', 'schedule', 'end'];
  const roleErr = requireRole(req, ADMIN.includes(action ?? '') ? 'ADMIN' : 'MANAGER');
  if (roleErr) return roleErr;

  try {
    switch (action) {
      case 'saveTeams':
        await saveTeams(adminDb, tid, body.teams);
        return NextResponse.json({ ok: true });
      case 'finalize':
        await finalizeTeams(adminDb, tid);
        return NextResponse.json({ ok: true });
      case 'end':
        await endTournament(adminDb, tid);
        return NextResponse.json({ ok: true });
      case 'substitute':
        await addSubstitution(adminDb, tid, body.teamId, { out: body.out, in: body.in });
        return NextResponse.json({ ok: true });
      case 'schedule': {
        const res = await scheduleGame(adminDb, tid, {
          round: body.round ?? '', courtIdx: body.courtIdx,
          teamA: body.teamA, teamB: body.teamB, pairA: body.pairA, pairB: body.pairB,
        });
        return NextResponse.json(res);
      }
      case 'start':
        await startClock(adminDb, tid, body.gid);
        return NextResponse.json({ ok: true });
      case 'result': {
        const res = await recordTournamentResult(adminDb, tid, body.gid, {
          winner: body.winner, scoreLoser: body.scoreLoser ?? null, actor: body.actor,
        });
        return NextResponse.json(res);
      }
      case 'undo': {
        const res = await undoTournamentResult(adminDb, tid, body.auditLogId);
        return NextResponse.json(res, { status: res.ok ? 200 : 400 });
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
