// ============================================================
// auth.ts — không tài khoản, không phân quyền. Một mã dùng chung.
// Xem PROMPT.md "THREE NON-NEGOTIABLE PRINCIPLES #3".
// ============================================================

import { NextRequest } from 'next/server';

/** true nếu request mang đúng mã trong header `x-app-code`. */
export function hasValidCode(req: NextRequest): boolean {
  const code = req.headers.get('x-app-code');
  return !!code && code === process.env.APP_CODE;
}
