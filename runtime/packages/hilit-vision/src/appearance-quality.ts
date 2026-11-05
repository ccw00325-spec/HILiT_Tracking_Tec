/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·8bc59596 @license @preserve */
/* 관측 품질. 흐리거나 겹친 프레임을 좋은 앵커처럼 쓰지 않는다.

학습된 품질 모델이 아니다. 상자 크기·겹침·표본·믿음도로 가른다.
*/

import type { IdentityJudgeState, TrackMotionState } from './track-identity-report';
import { mayUpdateAppearanceMemory } from './track-identity-report';
import type { MemoryKind } from './appearance-memory';

export interface ObservationQuality {
  sharpness: number;
  occlusion: number;
  overlap: number;
  boxShare: number;
  samples: number;
  trust: number;
  score: number;
}

export interface QualityInput {
  samples: number;
  trust: number;
  box: { width: number; height: number };
  frame: { width: number; height: number };
  overlapOther?: number;
  visibleRatio?: number;
  lumaVariance?: number;
}

export function scoreObservationQuality(input: QualityInput): ObservationQuality {
  const frameArea = Math.max(1, input.frame.width * input.frame.height);
  const boxShare = Math.max(0, Math.min(1, (input.box.width * input.box.height) / frameArea));
  const overlap = Math.max(0, Math.min(1, input.overlapOther ?? 0));
  const visible = Math.max(0, Math.min(1, input.visibleRatio ?? 1));
  const occlusion = 1 - visible;
  const sharpness = Math.max(0, Math.min(1, (input.lumaVariance ?? 0.08) / 0.12));
  const sampleScore = Math.max(0, Math.min(1, input.samples / 400));
  const trust = Math.max(0, Math.min(1, input.trust));
  const sizeScore = boxShare < 0.004 ? boxShare / 0.004 : boxShare > 0.45 ? Math.max(0, 1 - (boxShare - 0.45) / 0.4) : 1;
  const score = Math.max(0, Math.min(1,
    0.28 * trust
    + 0.22 * sampleScore
    + 0.18 * sizeScore
    + 0.16 * sharpness
    + 0.16 * (1 - Math.max(overlap, occlusion))));
  return { sharpness, occlusion, overlap, boxShare, samples: input.samples, trust, score };
}

export function boxOverlapRatio(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const area = Math.max(1e-9, a.width * a.height);
  return inter / area;
}

export const MIN_MEMORY_QUALITY = 0.35;
export const MAX_MEMORY_OVERLAP = 0.35;

export function mayCommitAppearanceObservation(input: {
  quality: ObservationQuality;
  trackState: TrackMotionState;
  identityState: IdentityJudgeState;
  doubtOpen: boolean;
  kind: MemoryKind;
  userConfirmed: boolean;
}): boolean {
  if (input.userConfirmed && input.kind === 'user_anchor') return true;
  if (!mayUpdateAppearanceMemory({
    trackState: input.trackState,
    identityState: input.identityState,
    doubtOpen: input.doubtOpen,
  })) return false;
  if (input.quality.score < MIN_MEMORY_QUALITY) return false;
  if (input.quality.overlap >= MAX_MEMORY_OVERLAP) return false;
  if (input.quality.occlusion >= 0.45) return false;
  if (input.kind === 'tentative') return false;
  return true;
}
