'use client';

// ============================================================
// client-code.ts — "không tài khoản, không phân quyền, một mã dùng chung"
// Nhập mã một lần → localStorage → gắn vào mọi request GHI.
// ============================================================

const KEY = 'appCode';

export function getCode(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(KEY);
}

export function setCode(code: string): void {
  window.localStorage.setItem(KEY, code);
}

export function clearCode(): void {
  window.localStorage.removeItem(KEY);
}

/**
 * fetch() cho các request GHI. Nếu chưa có mã → hỏi qua prompt().
 * Nếu server trả 401 (sai mã) → xoá mã cũ, hỏi lại, thử lại một lần.
 */
export async function writeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let code = getCode();
  if (!code) {
    code = window.prompt('Nhập mã vào cửa của nhóm:');
    if (!code) throw new Error('cần mã để ghi');
    setCode(code);
  }

  const doFetch = (c: string) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-app-code': c, 'content-type': 'application/json' },
    });

  let res = await doFetch(code);
  if (res.status === 401) {
    clearCode();
    const retry = window.prompt('Sai mã. Nhập lại:');
    if (!retry) return res;
    setCode(retry);
    res = await doFetch(retry);
  }
  return res;
}
