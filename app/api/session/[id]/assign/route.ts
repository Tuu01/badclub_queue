import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { assignCourt, ConflictError } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import type { PlayerId } from '@/lib/types';

// Dùng cho cả xếp trận thủ công (RECORD mode, "Bắt đầu sân") lẫn xếp trận
// theo gợi ý (ASSIGN mode, Step 5) — client luôn gửi four/teamA/teamB,
// server luôn kiểm tra lại trong transaction. Xem ARCHITECTURE.md §3.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'sai mã' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { courtIdx, four, teamA, teamB, predictedProbA, accepted, suggested, reason, assignedByApp, actor } = body ?? {};

  if (
    !Number.isInteger(courtIdx) ||
    !Array.isArray(four) || four.length !== 4 ||
    !Array.isArray(teamA) || teamA.length !== 2 ||
    !Array.isArray(teamB) || teamB.length !== 2 ||
    typeof actor !== 'string'
  ) {
    return NextResponse.json({ error: 'thiếu courtIdx/four/teamA/teamB/actor hợp lệ' }, { status: 400 });
  }

  try {
    const result = await assignCourt(adminDb, id, {
      courtIdx,
      four: four as [PlayerId, PlayerId, PlayerId, PlayerId],
      teamA: teamA as [PlayerId, PlayerId],
      teamB: teamB as [PlayerId, PlayerId],
      predictedProbA: typeof predictedProbA === 'number' ? predictedProbA : null,
      accepted: !!accepted,
      suggested: Array.isArray(suggested) ? suggested : undefined,
      reason: typeof reason === 'string' ? reason : undefined,
      assignedByApp: !!assignedByApp,
      actor,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ConflictError) {
      // Bình thường — hai sân cùng lấy trùng người. Không phải lỗi.
      return NextResponse.json({ error: 'đã bị lấy', taken: err.taken }, { status: 409 });
    }
    throw err;
  }
}
