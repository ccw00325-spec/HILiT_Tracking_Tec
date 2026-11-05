/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c6853a14 @license @preserve */
/* OcclusionCrop — 겹친 몸을 당기지 않는다.

신원을 바꾸지 않는다. 크롭 비율만 넓힌다.
두 상자가 많이 겹치면 주인공만 확대하면 등짝 두 개가 화면을 채운다.
*/

export const OCCLUSION_IOU_WIDEN = 0.22;
export const OCCLUSION_MAX_WIDEN = 1.32;

export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boxIou(a: FrameBox, b: FrameBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

export function maxOverlap(subject: FrameBox, others: readonly FrameBox[]): number {
  let best = 0;
  for (const other of others) best = Math.max(best, boxIou(subject, other));
  return best;
}

export function occlusionWidenFactor(overlap: number): number {
  if (!(overlap > OCCLUSION_IOU_WIDEN)) return 1;
  const t = Math.min(1, (overlap - OCCLUSION_IOU_WIDEN) / 0.45);
  return 1 + (OCCLUSION_MAX_WIDEN - 1) * t;
}

export function applyOcclusionCrop(input: {
  cropShare: number;
  maxCropShare: number;
  subject: FrameBox;
  others?: readonly FrameBox[];
}): { cropShare: number; overlap: number; widened: boolean } {
  const overlap = input.others?.length ? maxOverlap(input.subject, input.others) : 0;
  const factor = occlusionWidenFactor(overlap);
  const cropShare = Math.min(input.maxCropShare, input.cropShare * factor);
  return { cropShare, overlap, widened: factor > 1.001 };
}
