/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c1476e0e @license @preserve */
import type { NormalizedBBox, TrackingPoint } from '@hilit/shared-types';
import { FollowCamera, type HighlightWindow, type OutputAspect } from './follow-camera';
import { holdSegments } from './trajectory';

/* 편집기의 따라가기 카메라를 만드는 **단 하나의** 자리 (구도 v2, 2026-09-27).
 *
 * 미리보기(follow-preview.tsx)·저장본(video-export.ts)·화면의 품질 표시가 각자 FollowCamera 를
 * 만들면 옵션이나 순서가 하나만 달라져도 본 것과 저장된 것이 갈라진다. 실제로 갈라진 적이 있다
 * (저장본만 원본 그대로, 회원별 저장본만 다른 궤적). 그래서 설정 → 고정 구간 → 클립 구간 → 경로 계획을
 * 여기서 한 번에 한다. 같은 입력이면 같은 카메라가 나온다(follow-plan.test.ts 가 크롭을 대조한다).
 */

export interface EditorCameraSettings {
  sourceWidth: number;
  sourceHeight: number;
  aspect: OutputAspect;
  /** 「화면 크기」 — 움직이는 장면에서 대상이 출력 높이에서 차지할 목표 비율. 없으면 카메라 기본값. */
  zoom?: number;
  /** 「확대 한계」 — 원본을 늘릴 수 있는 최대 배율. 없으면 카메라 바닥(HARD_MAX_UPSCALE). */
  maxUpscale?: number;
  /** 가장자리 확대(실험, 기본 꺼짐 — FollowCameraOptions.edgeZoomTolerance). 편집기는 아직 넘기지 않는다. */
  edgeZoomTolerance?: number;
}

export function plannedFollowCamera(
  settings: EditorCameraSettings,
  tracking: TrackingPoint[],
  windows: readonly HighlightWindow[],
): FollowCamera {
  const cam = new FollowCamera({
    sourceWidth: settings.sourceWidth,
    sourceHeight: settings.sourceHeight,
    aspect: settings.aspect,
    ...(settings.zoom ? { subjectShare: settings.zoom } : {}),
    ...(typeof settings.maxUpscale === 'number' && Number.isFinite(settings.maxUpscale)
      ? { maxUpscale: settings.maxUpscale } : {}),
    /* 화면 크기를 화질 하한보다 우선한다 — 대신 maxUpscale 을 넘지는 않는다(upscaleLimit). */
    zoomFirst: true,
    ...(settings.edgeZoomTolerance ? { edgeZoomTolerance: settings.edgeZoomTolerance } : {}),
  });
  cam.setHoldSegments(tracking, holdSegments(tracking));
  cam.setHighlightWindows(windows);
  /* 궤적 전체를 알고 있으므로 실시간 필터 대신 경로를 미리 계획한다. 점이 3개 미만이면 계획하지 않고
   * 실시간 필터로 돈다(예전 동작). */
  cam.plan(tracking);
  return cam;
}

function iou(a: NormalizedBBox, b: NormalizedBBox): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 이 궤적이 그 사람의 것인가 — 회원별 내보내기 전에 본다.
 *
 * 회원별 작업 공간은 사람마다 처음 고른 상자(seedBox)와 시각만 들고 있고, 궤적은 편집기에 하나뿐이다.
 * 그래서 예전에는 A 를 추적해 둔 채 B 의 영상을 만들면 **A 를 따라간 영상이 B 이름으로** 나왔다.
 * 처음 고른 시각에 궤적 상자가 그 사람의 상자와 겹치는지(IoU ≥ 0.5) 확인한다. 겹치지 않으면 만들지 않는다.
 * 신원 판정이 아니다 — "이 궤적이 그 상자에서 시작했나" 만 본다.
 */
export function trackingStartsAtSeed(
  tracking: readonly TrackingPoint[],
  seed: { box: NormalizedBBox; timeSec: number },
  { maxGapSec = 0.5, minIou = 0.5 } = {},
): { ok: true } | { ok: false; reason: 'no-tracking' | 'seed-not-covered' | 'different-box' } {
  if (!tracking.length) return { ok: false, reason: 'no-tracking' };
  let best: TrackingPoint | null = null;
  let gap = Infinity;
  for (const p of tracking) {
    const d = Math.abs(p.timestamp - seed.timeSec);
    if (d < gap) { gap = d; best = p; }
  }
  if (!best || gap > maxGapSec) return { ok: false, reason: 'seed-not-covered' };
  return iou(best.bbox, seed.box) >= minIou ? { ok: true } : { ok: false, reason: 'different-box' };
}
