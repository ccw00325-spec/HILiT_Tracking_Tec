/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·9bb12135 @license @preserve */
/* 최소 검출 스케줄. Tracking 엔진을 다시 쓰지 않는다.

기본 경로는 운동 예측과 가벼운 추적이다. 검출은 관측 보정용이며
매 프레임을 강제하지 않는다. 검출 상자가 있다고 해서 신뢰할 수 있는
사람 관측이 아니다 — `detectorObservationTrust` 가 연결·가중치·출처를
먼저 본다.
놓치면 예측 주변 → 확장 → 전체. 작은 창에만 갇혀
다시 들어온 사람을 영구히 잃지 않는다.
*/

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DetectorTrigger = 'interval' | 'lost' | 'degraded';
export type SearchScope =
  | 'skip'
  | 'region'
  | 'full'
  | 'region-then-full'
  | 'near-then-expand-then-full';

export const DETECTOR_INTERVAL_FRAMES = 8;
export const NEAR_PAD = 0.15;
export const REGION_PAD = 0.35;

export interface SearchPlan {
  run: boolean;
  scope: SearchScope;
  region: PixelRect | null;
  near: PixelRect | null;
  reason: string;
}

export function padSearchRegion(
  box: PixelRect,
  frameW: number,
  frameH: number,
  pad = REGION_PAD,
): PixelRect {
  const w = Math.min(frameW, Math.max(8, box.width * (1 + pad)));
  const h = Math.min(frameH, Math.max(8, box.height * (1 + pad)));
  return {
    x: Math.max(0, Math.min(frameW - w, box.x - box.width * pad / 2)),
    y: Math.max(0, Math.min(frameH - h, box.y - box.height * pad / 2)),
    width: w,
    height: h,
  };
}

export function planDetectorSearch(input: {
  trigger: DetectorTrigger;
  framesSinceDetector: number;
  intervalFrames?: number;
  lastBox: PixelRect | null;
  frameW: number;
  frameH: number;
  stdX?: number | null;
  stdY?: number | null;
  roiWiden?: number;
  subjectHeightPx?: number | null;
}): SearchPlan {
  const interval = input.intervalFrames ?? DETECTOR_INTERVAL_FRAMES;
  const widen = input.roiWiden ?? 1;
  const covPad = input.stdX != null && input.lastBox
    ? Math.max(NEAR_PAD, (2.2 * input.stdX * widen) / Math.max(8, input.lastBox.width))
    : NEAR_PAD * widen;
  const expandPad = input.stdY != null && input.lastBox
    ? Math.max(REGION_PAD, (3.2 * input.stdY * widen) / Math.max(8, input.lastBox.height))
    : REGION_PAD * widen;
  const small = input.subjectHeightPx != null && input.subjectHeightPx < 32;
  if (input.trigger === 'lost') {
    if (input.lastBox && input.frameW > 0 && input.frameH > 0) {
      return {
        run: true,
        scope: 'near-then-expand-then-full',
        near: padSearchRegion(input.lastBox, input.frameW, input.frameH, covPad),
        region: padSearchRegion(input.lastBox, input.frameW, input.frameH, expandPad),
        reason: small ? 'lost-near-expand-full-small' : 'lost-near-expand-full',
      };
    }
    return { run: true, scope: 'full', region: null, near: null, reason: 'lost-full' };
  }
  const need = input.trigger === 'degraded' ? Math.max(2, Math.floor(interval / 2)) : interval;
  if (input.framesSinceDetector < need) {
    return { run: false, scope: 'skip', region: null, near: null, reason: 'interval-wait' };
  }
  if (input.lastBox && (input.trigger === 'degraded' || small)) {
    return {
      run: true,
      scope: 'region-then-full',
      near: padSearchRegion(input.lastBox, input.frameW, input.frameH, covPad),
      region: padSearchRegion(input.lastBox, input.frameW, input.frameH, expandPad),
      reason: small ? 'interval-region-small' : `interval-${input.trigger}-region`,
    };
  }
  return { run: true, scope: 'full', region: null, near: null, reason: `interval-${input.trigger}` };
}
