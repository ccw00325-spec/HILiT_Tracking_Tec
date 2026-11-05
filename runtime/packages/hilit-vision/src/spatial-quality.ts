/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·08c01bc9 @license @preserve */
/* 공간 예측 품질과 마할라노비스 거리.

위치 예측의 오차 범위 안에서 후보가 얼마나 일관적인지만 본다.
종목별 대기시간·이상행동 탐지가 아니다.
큰 공분산은 "같은 사람일 가능성이 커졌다"가 아니라
위치로 배제하기 어려워졌다는 뜻이다. 그때 r_space 를 낮춘다.

Q·R 초기값은 합성·가정이다. 실사 궤적 오차로 보정하기 전이다.
*/

import type { CameraMotionStatus } from './analysis-contract';
import { TRACK_REGION_POLICY } from './track-region-prediction';

export type SpatialSituation = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export const SPATIAL_ASSUMPTIONS = Object.freeze({
  /** px/s². TrackRegionPredictor 와 같은 가정. 실사 보정 전. */
  processAccel: TRACK_REGION_POLICY.processAccel,
  /** px. 검출 confidence 를 확률로 바꾸지 않는다. */
  measureNoisePx: TRACK_REGION_POLICY.measureNoisePx,
  origin: 'initial-assumption' as const,
  measuredOnRealVideo: false,
});

export interface SpatialCovariance {
  stdX: number;
  stdY: number;
  bodyHeight: number;
  coastSec: number;
}

export interface CameraQualityInput {
  status: CameraMotionStatus | 'absent';
  usable: boolean;
  quality: number;
  backgroundShare: number;
  /** 특징점/격자 대응이 충분한가. 부족하면 정지가 아니다. */
  featureSupport: boolean | null;
  residual?: number | null;
  inlierRatio?: number | null;
}

export interface SpatialQualityInput {
  camera: CameraQualityInput | null;
  covariance: SpatialCovariance | null;
  predictionUsable: boolean;
  sceneCut: boolean;
  subjectTurning?: boolean;
  lastObservationQuality?: number | null;
  /** 낮을수록 외형 비중을 줄이고 공간이 살아 있으면 0.55/0.45 쪽으로 민다. */
  appearanceReliability?: number | null;
}

export interface SpatialQuality {
  rSpace: number;
  situation: SpatialSituation;
  wSpace: number;
  wAppearance: number;
  reason: string;
  covarianceTooLarge: boolean;
  spaceInformative: boolean;
  scoreIsProbability: false;
}

export interface MahalanobisResult {
  d2: number | null;
  valid: boolean;
  reason: string;
  /** 공분산이 커져 거리가 작아진 경우. 동일인 확신으로 읽지 않는다. */
  inflatedCovariance: boolean;
}

const W_SPACE_MAX = 0.30;

export function mahalanobis2d(input: {
  ex: number;
  ey: number;
  stdX: number;
  stdY: number;
  measureNoisePx?: number;
}): MahalanobisResult {
  const r = input.measureNoisePx ?? SPATIAL_ASSUMPTIONS.measureNoisePx;
  const sx2 = input.stdX * input.stdX + r * r;
  const sy2 = input.stdY * input.stdY + r * r;
  if (!(sx2 > 1e-8) || !(sy2 > 1e-8) || !Number.isFinite(sx2) || !Number.isFinite(sy2)) {
    return { d2: null, valid: false, reason: 'singular-covariance', inflatedCovariance: false };
  }
  if (!Number.isFinite(input.ex) || !Number.isFinite(input.ey)) {
    return { d2: null, valid: false, reason: 'nonfinite-residual', inflatedCovariance: false };
  }
  const d2 = (input.ex * input.ex) / sx2 + (input.ey * input.ey) / sy2;
  if (!Number.isFinite(d2) || d2 < 0) {
    return { d2: null, valid: false, reason: 'nonfinite-d2', inflatedCovariance: false };
  }
  const inflated = Math.hypot(input.stdX, input.stdY) > 40;
  return { d2, valid: true, reason: 'ok', inflatedCovariance: inflated };
}

function cameraRaw(cam: CameraQualityInput | null, sceneCut: boolean): { r: number; reason: string } {
  if (sceneCut) return { r: 0, reason: 'scene-cut' };
  if (!cam) return { r: 0, reason: 'camera-unmeasured' };
  if (cam.status === 'scene_cut' || cam.status === 'inconsistent' || cam.status === 'reset') {
    return { r: 0, reason: `camera-${cam.status}` };
  }
  if (cam.featureSupport === false || cam.status === 'low_texture' || cam.status === 'person_fills') {
    /* 특징 부족 ≠ 카메라 정지. unknown 으로 공간을 끈다. */
    return { r: 0, reason: 'camera-quality-unknown' };
  }
  if (!cam.usable) return { r: 0, reason: 'camera-unusable' };
  let r = Math.max(0, Math.min(1, cam.quality));
  if (cam.residual != null && Number.isFinite(cam.residual)) {
    r *= Math.max(0, 1 - Math.min(1, cam.residual / 18));
  }
  if (cam.inlierRatio != null && Number.isFinite(cam.inlierRatio)) {
    r *= Math.max(0.15, Math.min(1, cam.inlierRatio));
  }
  if (cam.backgroundShare < 0.25) r *= 0.4;
  return { r, reason: 'camera-ok' };
}

export function situationOf(input: {
  rSpace: number;
  sceneCut: boolean;
  spaceInformative: boolean;
  turning: boolean;
  cameraMovingSoft?: boolean;
}): SpatialSituation {
  if (input.sceneCut) return 'G';
  if (!input.spaceInformative) return 'E';
  if (input.turning && input.rSpace >= 0.45) return 'F';
  if (input.rSpace >= 0.75) return input.cameraMovingSoft ? 'B' : 'A';
  if (input.rSpace >= 0.45) return 'C';
  if (input.rSpace >= 0.18) return 'D';
  return 'E';
}

/** 표 8의 초기 비율. 제품 최적값이 아니다. */
export function tableWeights(situation: SpatialSituation): { wAppearance: number; wSpace: number } {
  switch (situation) {
    case 'A':
      return { wAppearance: 0.70, wSpace: 0.30 };
    case 'B':
      return { wAppearance: 0.75, wSpace: 0.25 };
    case 'C':
      return { wAppearance: 0.90, wSpace: 0.10 };
    case 'D':
      return { wAppearance: 0.90, wSpace: 0.10 };
    case 'E':
    case 'G':
      return { wAppearance: 1, wSpace: 0 };
    case 'F':
      return { wAppearance: 0.85, wSpace: 0.15 };
    default:
      return { wAppearance: 1, wSpace: 0 };
  }
}

export function assessSpatialQuality(input: SpatialQualityInput): SpatialQuality {
  const cam = cameraRaw(input.camera, input.sceneCut);
  let r = cam.r;
  let covarianceTooLarge = false;
  if (!input.predictionUsable) r = 0;
  if (input.covariance) {
    const body = Math.max(1, input.covariance.bodyHeight);
    const stdBodies = Math.hypot(input.covariance.stdX, input.covariance.stdY) / body;
    if (stdBodies > 0.85) {
      covarianceTooLarge = true;
      r *= 0.15;
    } else if (stdBodies > 0.45) {
      r *= 0.55;
    }
    if (input.covariance.coastSec > TRACK_REGION_POLICY.maxCoastSec) r = 0;
    else if (input.covariance.coastSec > 0.4) r *= Math.max(0, 1 - (input.covariance.coastSec - 0.4) / 0.8);
  } else {
    r *= 0.25;
  }
  if (input.lastObservationQuality != null && input.lastObservationQuality < 0.35) r *= 0.5;
  r = Math.max(0, Math.min(1, r));
  const spaceInformative = r > 0.05 && !input.sceneCut;
  const situation = situationOf({
    rSpace: r,
    sceneCut: input.sceneCut,
    spaceInformative,
    turning: input.subjectTurning === true,
    cameraMovingSoft: input.camera?.usable === true && (input.camera.quality ?? 0) >= 0.55
      && input.camera.status === 'ok',
  });
  let wSpace = W_SPACE_MAX * r;
  let wAppearance = 1 - wSpace;
  const ar = input.appearanceReliability;
  if (ar != null && Number.isFinite(ar) && ar < 0.5 && r >= 0.45 && spaceInformative) {
    const t = Math.max(0, Math.min(1, (0.5 - ar) / 0.5));
    wAppearance = (1 - t) * wAppearance + t * 0.55;
    wSpace = 1 - wAppearance;
  }
  return {
    rSpace: r,
    situation,
    wSpace,
    wAppearance,
    reason: cam.reason,
    covarianceTooLarge,
    spaceInformative,
    scoreIsProbability: false,
  };
}

/** 품질 악화는 빠르게, 회복은 느리게. 장면 전환·보정 실패는 즉시 0. */
export class SpatialWeightSmoother {
  private value = 0;
  update(raw: number, invalidate: boolean): number {
    if (invalidate) {
      this.value = 0;
      return 0;
    }
    const target = Math.max(0, Math.min(1, raw));
    if (target < this.value) this.value = 0.35 * this.value + 0.65 * target;
    else this.value = 0.88 * this.value + 0.12 * target;
    return this.value;
  }
  reset(): void {
    this.value = 0;
  }
}

/**
 * 브라우저 CameraMotion.update 결과를 공간 품질 입력으로 바꾼다.
 * SAD 이득이 낮다고 카메라를 정지라고 단정하지 않는다.
 * 대응 화소가 부족하면 unknown 으로 공간을 끈다. 정지 가정값 0.78 은 실사 보정이 아니다.
 */
export function browserCameraToQuality(drift: {
  status?: CameraMotionStatus | 'absent' | string | null;
  usable?: boolean;
  confidence?: number;
  dx?: number;
  dy?: number;
  backgroundShare?: number;
  comparedCells?: number | null;
  residual?: number | null;
  inlierRatio?: number | null;
} | null): CameraQualityInput | null {
  if (!drift) return null;
  const status = (drift.status as CameraMotionStatus | 'absent' | undefined) ?? 'absent';
  const cells = drift.comparedCells;
  const featureSupport = status === 'person_fills' || status === 'low_texture' || status === 'inconsistent'
    ? false
    : cells == null
      ? status === 'ok' || status === 'first_frame'
      : cells >= 40;
  const translation = Math.hypot(drift.dx ?? 0, drift.dy ?? 0);
  const stillOk = status === 'ok'
    && drift.usable !== false
    && featureSupport
    && translation < 2
    && (drift.confidence ?? 0) < 0.12;
  const quality = stillOk
    ? 0.78
    : Math.max(0, Math.min(1, drift.confidence ?? 0));
  return {
    status: status === 'absent' ? 'absent' : status,
    usable: drift.usable === true && featureSupport,
    quality,
    backgroundShare: drift.backgroundShare ?? 0.5,
    featureSupport,
    residual: drift.residual ?? null,
    inlierRatio: drift.inlierRatio ?? null,
  };
}
