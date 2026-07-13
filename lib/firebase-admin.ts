// ============================================================
// firebase-admin.ts — Admin SDK, server-side only (Route Handlers).
// Bypasses firestore.rules — this is the ONLY place allowed to write.
// ============================================================

import { cert, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// The private key is stored in .env with \n escaped as the literal "\n" —
// the original service account JSON has real newlines, which .env doesn't allow.
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

const app = getApps().length
  ? getApp()
  : initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });

export const adminDb = getFirestore(app);
