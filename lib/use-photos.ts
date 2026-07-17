'use client';

// Reads player avatars through /api/photos (server-mediated, so no
// firestore.rules change is needed). Photos change rarely, so a one-shot
// fetch on mount is enough — no live listener. `setLocal` lets a screen
// that just uploaded reflect the change immediately, without a refetch.

import { useEffect, useState, useCallback } from 'react';

export function usePhotos() {
  const [photos, setPhotos] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    fetch('/api/photos')
      .then(r => r.json())
      .then(b => setPhotos(b.photos ?? {}))
      .catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const setLocal = useCallback((id: string, thumb: string | null) => {
    setPhotos(prev => {
      const next = { ...prev };
      if (thumb) next[id] = thumb; else delete next[id];
      return next;
    });
  }, []);

  return { photos, setLocal, refresh };
}
