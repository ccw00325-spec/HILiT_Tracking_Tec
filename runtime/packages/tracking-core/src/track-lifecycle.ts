/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·8aa02dab @license @preserve */
/* 편집기 추적 상태 — 검출기가 없어도 흐름이 끊기지 않게.

검출기 없음과 사람 없음을 한 말로 묶으면, 화면에 사람이 있어도
"찾지 못했다"고 나온다. 1×1 상자를 성공으로 넘기면 카메라는
화면 구석을 따라간다. 빈 궤적을 성공으로 넘기면 확인 단계가
"다 됐다"고 시작한다.
*/

import type { TrackingPoint } from '@hilit/shared-types';

export type TrackLifeState =
  | 'user_anchored'
  | 'observation_valid'
  | 'observation_degraded'
  | 'target_lost'
  | 'reassign_needed'
  | 'feature_unavailable'
  | 'processing_failed';

export type DetectorLookup =
  | { kind: 'detector_absent'; reason: string }
  | { kind: 'no_person' }
  | { kind: 'candidates'; count: number };

export function detectorLookup(
  detectorAvailable: boolean,
  hits: readonly unknown[],
  reason = 'detector-removed',
): DetectorLookup {
  if (!detectorAvailable) return { kind: 'detector_absent', reason };
  if (!hits.length) return { kind: 'no_person' };
  return { kind: 'candidates', count: hits.length };
}

/** 화소 상자. 1×1 이나 NaN 은 관측이 아니다. */
export function isValidPixelBox(box: {
  x?: number; y?: number; width?: number; height?: number; w?: number; h?: number;
} | null | undefined): boolean {
  if (!box) return false;
  const w = Number(box.width ?? box.w);
  const h = Number(box.height ?? box.h);
  const x = Number(box.x);
  const y = Number(box.y);
  if (![x, y, w, h].every(Number.isFinite)) return false;
  if (!(w > 2) || !(h > 2)) return false;
  return true;
}

export function classifyObservation(input: {
  initialized: boolean;
  observed: boolean;
  status?: string | null;
  confidence?: number;
  box?: { width?: number; height?: number; w?: number; h?: number; x?: number; y?: number } | null;
  failed?: boolean;
  detectorUnavailable?: boolean;
}): TrackLifeState {
  if (input.failed) return 'processing_failed';
  if (!input.initialized) return 'processing_failed';
  if (!isValidPixelBox(input.box)) return 'target_lost';
  const status = (input.status ?? '').toLowerCase();
  if (status === 'lost' || !input.observed) return 'target_lost';
  if (status === 'degraded' || (input.confidence ?? 1) < 0.22) return 'observation_degraded';
  return 'observation_valid';
}

export function needsReassign(state: TrackLifeState): boolean {
  return state === 'target_lost' || state === 'reassign_needed';
}

/**
 * at 이전 궤적은 그대로 두고, 그 시각부터는 새 추적만 붙인다.
 * 전체를 다시 돌리면 잘 되던 앞부분까지 사라진다.
 */
export function spliceTrajectory<T extends { timestamp: number }>(
  previous: readonly T[],
  fromTime: number,
  next: readonly T[],
): T[] {
  const head = previous.filter((point) => point.timestamp < fromTime);
  return [...head, ...next].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * 구간 안만 갈아 끼운다 — 3단계에서 여러 장면을 한 번에 다시 추적할 때(2026-09-25).
 *
 * spliceTrajectory 는 fromTime 뒤를 통째로 바꾼다. 장면 다섯 곳을 고치면서 그렇게 하면
 * 두 번째 장면을 고치는 순간 첫 번째 고친 결과 뒤쪽이 다시 사라진다. 여기서는
 * [fromTime, toTime) 안의 점만 새 점으로 바꾸고 바깥은 그대로 둔다.
 */
export function spliceTrajectoryWindow<T extends { timestamp: number }>(
  previous: readonly T[],
  fromTime: number,
  toTime: number,
  next: readonly T[],
): T[] {
  const keep = previous.filter((point) => point.timestamp < fromTime || point.timestamp >= toTime);
  const inside = next.filter((point) => point.timestamp >= fromTime && point.timestamp < toTime);
  return [...keep, ...inside].sort((a, b) => a.timestamp - b.timestamp);
}

/** 중단한 실행의 결과를 현재 편집에 넣지 않는다. */
export function shouldApplyRun(generation: number, current: number, aborted: boolean): boolean {
  return !aborted && generation === current;
}

export function emptyTrajectoryIsNotSuccess(points: readonly TrackingPoint[]): boolean {
  return points.length > 0;
}
