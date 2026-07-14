// ============================================================
// skill-band.ts — coarse skill BANDS for /board + /me
//
// A deliberate, documented override of LEADERBOARD.md §5's "no skill
// display before convergence" — for a BAND only, never a number. See
// the §5 decision note.
//
// Why a band and not the rating: publishing a precise number early is
// the one thing the leaderboard must never do — it will be wrong by ±8
// and someone ranks visibly last and quits. A BROAD band stays correct
// even while the number is still noisy (a genuinely mid player lands in
// the middle band whether the estimate reads 47 or 55), so it's honest
// to show from the first few games.
//
// This module is PURE: no Firestore, no React, no Date.now/Math.random.
// It read-imports isConverged from the protected core (rating.ts) but
// never modifies it. CRITICAL: `mu` is an INPUT ONLY — it must never
// appear in any returned object, so the raw rating never leaves the
// server (mirrors the guarantee in firestore.ts#getBoardData).
// ============================================================

import { isConverged } from './rating';
import type { ClubPlayer } from './types';

export type SkillBand = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

// Thresholds on mu (seeds span ~32–72; see rating.ts#seedMu). These
// split the 22 seeds roughly 8/7/7 with no empty band. The WIDE
// Intermediate band (45–60) is load-bearing: the docs stress the div
// boundary is fuzzy (best-D2 ≈ 52, weakest-D1 ≈ 55), so both of those
// adjacent seeds must land in the SAME band — a tighter boundary near
// 53 would assert a gap the project explicitly says isn't real.
export const BAND_MIN = 45; // Intermediate floor
export const BAND_MAX = 60; // Advanced floor

// Minimum games before ANY band shows. Below this the band would be
// almost entirely the admin's seed with no match evidence — the exact
// "publishing my guess" fear. 3 games is ~1.5 weeks of play, nowhere
// near the 6-month convergence wall, but enough that the rating has
// moved off the pure seed a few times.
export const BAND_MIN_GAMES = 3;

// Display names only — the internal band codes stay BEGINNER/INTERMEDIATE/
// ADVANCED (so logic, stored values, and tests are unchanged); these are
// what players see. Tier 1 = the top.
const LABEL: Record<SkillBand, string> = {
  BEGINNER: 'Tier 3 · Bronze',
  INTERMEDIATE: 'Tier 2 · Silver',
  ADVANCED: 'Tier 1 · Gold',
};

export interface SkillBandResult {
  /** null = not enough signal yet (no rating, or < BAND_MIN_GAMES games). */
  band: SkillBand | null;
  label: string | null;
  /** !isConverged — the band can still move; shown as "provisional". */
  provisional: boolean;
  /** The 1σ uncertainty interval crosses a band boundary. */
  settling: boolean;
  /** The band it's leaning toward when settling, else null. */
  adjacentBand: SkillBand | null;
}

export function bandForMu(mu: number): SkillBand {
  if (mu >= BAND_MAX) return 'ADVANCED';
  if (mu >= BAND_MIN) return 'INTERMEDIATE';
  return 'BEGINNER';
}

export function labelForBand(band: SkillBand): string {
  return LABEL[band];
}

/**
 * `mu` is INPUT ONLY and never returned. Pass `null` when the player
 * has no rating doc yet (0 games) — yields `band: null`.
 */
export function computeSkillBand(
  mu: number | null | undefined,
  sigma: number,
  gamesTotal: number,
): SkillBandResult {
  const provisional = !isConverged({ sigma, gamesTotal } as ClubPlayer);

  if (mu == null || gamesTotal < BAND_MIN_GAMES) {
    return { band: null, label: null, provisional, settling: false, adjacentBand: null };
  }

  const band = bandForMu(mu);
  const low = bandForMu(mu - sigma);
  const high = bandForMu(mu + sigma);
  const settling = low !== band || high !== band;
  // Lean toward whichever side of the interval left this band.
  const adjacentBand = !settling ? null : high !== band ? high : low;

  return { band, label: labelForBand(band), provisional, settling, adjacentBand };
}
