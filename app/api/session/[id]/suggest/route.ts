import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { getSuggestion } from '@/lib/firestore';
import { CLUB_ID } from '@/lib/constants';

// KHÔNG gác mã — gợi ý + câu giải thích phải "ai cũng xem được" như
// hàng chờ (xem PROMPT.md "Read: wide open"). Đi qua Vercel không phải
// vì cần mã, mà vì suggestMatch() cần pairStats — dữ liệu private,
// client không đọc trực tiếp được (firestore.rules).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const court = req.nextUrl.searchParams.get('court');
  if (court === null || Number.isNaN(Number(court))) {
    return NextResponse.json({ error: 'thiếu ?court=N hợp lệ' }, { status: 400 });
  }

  // suggestMatch() không cần biết sân số mấy — một gợi ý không khoá ai,
  // xem ARCHITECTURE.md §5. `court` chỉ để client biết gắn vào ô nào.
  const suggestion = await getSuggestion(adminDb, id, CLUB_ID);
  return NextResponse.json({ suggestion });
}
