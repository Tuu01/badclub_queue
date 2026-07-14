'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { subscribeCodeModal, submitCode, cancelCodeEntry, getCode } from '@/lib/client-code';
import { refreshRole } from '@/lib/client-role';

const TAP = 'transition-transform duration-75 active:scale-[0.98]';

export function CodeModal() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [value, setValue] = useState('');

  // A code from a previous visit persists in localStorage, but the cached
  // role doesn't survive a fresh page load — re-derive it once on mount so
  // hide/show state is right before the user does anything.
  useEffect(() => {
    if (getCode()) void refreshRole();
  }, []);

  useEffect(() => subscribeCodeModal((isOpen, msg) => {
    setOpen(isOpen);
    setMessage(msg);
    setValue('');
  }), []);

  if (!open) return null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    submitCode(value.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-court-900/80 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-xl border border-line-700 bg-court-800 p-4">
        <p className="text-[16px] font-medium text-line-000">{message}</p>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          className="h-14 w-full rounded-xl border border-line-700 bg-transparent px-3 text-[16px] text-line-000"
        />
        <div className="flex gap-2">
          <button type="submit" className={`min-h-[48px] flex-1 rounded-xl border border-line-000 bg-line-000 text-[16px] font-medium text-court-900 ${TAP}`}>
            OK
          </button>
          <button
            type="button"
            onClick={cancelCodeEntry}
            className={`min-h-[48px] rounded-xl border border-line-700 px-4 text-[16px] font-medium text-line-400 ${TAP}`}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
