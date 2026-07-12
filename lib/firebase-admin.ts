// ============================================================
// firebase-admin.ts — Admin SDK, chỉ chạy server-side (Route Handlers).
// Bỏ qua firestore.rules — đây là nơi DUY NHẤT được phép ghi.
// ============================================================

import { cert, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Private key được lưu trong .env với \n đã escape thành literal "\n" —
// service account JSON gốc có xuống dòng thật, .env thì không cho phép.
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
