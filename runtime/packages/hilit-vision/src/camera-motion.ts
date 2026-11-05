/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·7dbb7586 @license @preserve */
/* 카메라 움직임 추정.

전역 평행이동(SAD)과 인물 박스를 뺀 배경 SAD를 같이 잰다.
전경 사람 이동을 카메라로 쓰지 않는다. 배경이 부족하면 보정 불가다.
회전·줌은 단순 스케일 탐색이 평행이동보다 분명히 나을 때만 적는다.
단일 변환으로 안 맞으면 inconsistent / scene_cut 이다.
*/

import {
  MOTION_ANALYSIS_VERSION,
  type AnalysisRef,
  type CameraMotionStatus,
} from './analysis-contract';
import {
  GMC_METHOD_ID,
  estimateAffineGmc,
  type Affine2D,
} from './affine-gmc';
import { assessGmcEvidence } from './gmc-verification';

export const CAMERA_GRID_W = 40;
export const CAMERA_GRID_H = 24;
export const CAMERA_RANGE = 5;
export const CAMERA_MIN_CONFIDENCE = 0.12;
export const CAMERA_MAX_PERSON_SHARE = 0.55;
export const CAMERA_MIN_TEXTURE = 12;
export const CAMERA_CUT_SAD = 42;
export const CAMERA_METHOD_ID = 'masked-sad-trans-v1';
export const CAMERA_BASELINE_METHOD_ID = 'global-sad-trans-v1';

export interface CameraBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraEstimate extends AnalysisRef {
  status: CameraMotionStatus;
  usable: boolean;
  dxPx: number | null;
  dyPx: number | null;
  scale: number | null;
  rotationRad: number | null;
  quality: number;
  method: typeof CAMERA_METHOD_ID | typeof CAMERA_BASELINE_METHOD_ID | typeof GMC_METHOD_ID;
  affine?: Affine2D | null;
  reason: string;
  backgroundShare: number;
  gridDx: number | null;
  gridDy: number | null;
}

export interface CameraCompareRow {
  global: CameraEstimate;
  masked: CameraEstimate;
  chose: 'masked' | 'unavailable' | 'global-only';
}

export function rgbaToGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

export function downsampleGray(
  gray: Uint8Array,
  srcW: number,
  srcH: number,
  dstW = CAMERA_GRID_W,
  dstH = CAMERA_GRID_H,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y += 1) {
    const y0 = Math.floor((y * srcH) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x += 1) {
      const x0 = Math.floor((x * srcW) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let sum = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < srcH; sy += 1) {
        const row = sy * srcW;
        for (let sx = x0; sx < x1 && sx < srcW; sx += 1) {
          sum += gray[row + sx];
          n += 1;
        }
      }
      out[y * dstW + x] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

export function personMask(
  boxes: readonly CameraBox[],
  srcW: number,
  srcH: number,
  dstW = CAMERA_GRID_W,
  dstH = CAMERA_GRID_H,
): Uint8Array {
  const mask = new Uint8Array(dstW * dstH);
  mask.fill(1);
  for (const box of boxes) {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
    const x0 = Math.max(0, Math.floor((box.x / srcW) * dstW));
    const y0 = Math.max(0, Math.floor((box.y / srcH) * dstH));
    const x1 = Math.min(dstW, Math.ceil(((box.x + box.width) / srcW) * dstW));
    const y1 = Math.min(dstH, Math.ceil(((box.y + box.height) / srcH) * dstH));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) mask[y * dstW + x] = 0;
    }
  }
  return mask;
}

function backgroundShare(mask: Uint8Array): number {
  let bg = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) bg += 1;
  return bg / Math.max(1, mask.length);
}

function textureVar(gray: Uint8Array, mask: Uint8Array | null): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < gray.length; i += 1) {
    if (mask && !mask[i]) continue;
    sum += gray[i];
    n += 1;
  }
  if (n < 8) return 0;
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < gray.length; i += 1) {
    if (mask && !mask[i]) continue;
    const d = gray[i] - mean;
    v += d * d;
  }
  return Math.sqrt(v / n);
}

function sadAt(
  prev: Uint8Array,
  next: Uint8Array,
  ox: number,
  oy: number,
  mask: Uint8Array | null,
  w: number,
  h: number,
): { mean: number; n: number } {
  let sum = 0;
  let n = 0;
  for (let y = CAMERA_RANGE; y < h - CAMERA_RANGE; y += 1) {
    const row = y * w;
    const srow = (y + oy) * w;
    for (let x = CAMERA_RANGE; x < w - CAMERA_RANGE; x += 1) {
      const i = row + x;
      const j = srow + x + ox;
      if (mask && (!mask[i] || !mask[j])) continue;
      sum += Math.abs(next[j] - prev[i]);
      n += 1;
    }
  }
  return { mean: sum / Math.max(n, 1), n };
}

function searchTranslation(
  prev: Uint8Array,
  next: Uint8Array,
  mask: Uint8Array | null,
  w = CAMERA_GRID_W,
  h = CAMERA_GRID_H,
): { dx: number; dy: number; best: number; baseline: number; n: number } {
  let bestX = 0;
  let bestY = 0;
  let best = Infinity;
  let baseline = 0;
  let bestN = 0;
  for (let oy = -CAMERA_RANGE; oy <= CAMERA_RANGE; oy += 1) {
    for (let ox = -CAMERA_RANGE; ox <= CAMERA_RANGE; ox += 1) {
      const { mean, n } = sadAt(prev, next, ox, oy, mask, w, h);
      if (ox === 0 && oy === 0) baseline = mean;
      if (mean < best) {
        best = mean;
        bestX = ox;
        bestY = oy;
        bestN = n;
      }
    }
  }
  return { dx: bestX, dy: bestY, best, baseline, n: bestN };
}

function shiftGray(src: Uint8Array, w: number, h: number, sx: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const mid = (w - 1) / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const srcX = Math.round(mid + (x - mid) / sx);
      const clamped = Math.max(0, Math.min(w - 1, srcX));
      out[y * w + x] = src[y * w + clamped];
    }
  }
  return out;
}

function maybeScale(
  prev: Uint8Array,
  next: Uint8Array,
  mask: Uint8Array | null,
  transSad: number,
): number | null {
  const scales = [0.94, 1.06];
  let bestScale: number | null = null;
  let best = transSad * 0.82;
  for (const s of scales) {
    const warped = shiftGray(next, CAMERA_GRID_W, CAMERA_GRID_H, s);
    const { best: sad } = searchTranslation(prev, warped, mask);
    if (sad < best) {
      best = sad;
      bestScale = s;
    }
  }
  return bestScale;
}

function finish(
  ref: AnalysisRef,
  status: CameraMotionStatus,
  reason: string,
  extra: Partial<CameraEstimate> = {},
): CameraEstimate {
  return {
    ...ref,
    analysisVersion: MOTION_ANALYSIS_VERSION,
    provenance: 'local',
    timeBase: 'source',
    status,
    usable: extra.usable === true && status === 'ok',
    dxPx: extra.dxPx ?? null,
    dyPx: extra.dyPx ?? null,
    scale: extra.scale ?? null,
    rotationRad: extra.rotationRad ?? null,
    quality: extra.quality ?? 0,
    method: extra.method ?? CAMERA_METHOD_ID,
    affine: extra.affine ?? null,
    reason,
    backgroundShare: extra.backgroundShare ?? 1,
    gridDx: extra.gridDx ?? null,
    gridDy: extra.gridDy ?? null,
  };
}

export function estimateCameraOnGrids(input: {
  prevGrid: Uint8Array;
  nextGrid: Uint8Array;
  srcW: number;
  srcH: number;
  mask?: Uint8Array | null;
  method: CameraEstimate['method'];
  videoId: string;
  subjectId?: string | null;
  t0Sec: number;
  t1Sec: number;
}): CameraEstimate {
  const ref: AnalysisRef = {
    videoId: input.videoId,
    subjectId: input.subjectId ?? null,
    t0Sec: input.t0Sec,
    t1Sec: input.t1Sec,
    timeBase: 'source',
    analysisVersion: MOTION_ANALYSIS_VERSION,
    provenance: 'local',
  };
  const mask = input.mask ?? null;
  const share = mask ? backgroundShare(mask) : 1;
  if (mask && share < 1 - CAMERA_MAX_PERSON_SHARE) {
    return finish(ref, 'person_fills', '화면 대부분을 사람이 차지해 배경 특징이 부족합니다.', {
      method: input.method,
      backgroundShare: share,
    });
  }
  const tex = textureVar(input.prevGrid, mask);
  if (tex < CAMERA_MIN_TEXTURE) {
    return finish(ref, 'low_texture', '배경 텍스처가 부족해 카메라 보정을 쓰지 않습니다.', {
      method: input.method,
      backgroundShare: share,
      quality: tex / CAMERA_MIN_TEXTURE,
    });
  }
  const found = searchTranslation(input.prevGrid, input.nextGrid, mask);
  if (found.n < 40) {
    return finish(ref, 'low_texture', '비교할 배경 화소가 부족합니다.', {
      method: input.method,
      backgroundShare: share,
    });
  }
  if (found.best >= CAMERA_CUT_SAD && found.baseline >= CAMERA_CUT_SAD) {
    return finish(ref, 'scene_cut', '한 장의 평행이동으로 설명되지 않습니다. 장면 전환으로 둡니다.', {
      method: input.method,
      backgroundShare: share,
      quality: 0,
    });
  }
  const gain = found.baseline > 1e-6 ? (found.baseline - found.best) / found.baseline : 0;
  const quality = Math.max(0, Math.min(1, gain));
  if (quality < CAMERA_MIN_CONFIDENCE) {
    return finish(ref, 'ok', '카메라 이동이 거의 없거나 이득이 작습니다.', {
      usable: true,
      dxPx: 0,
      dyPx: 0,
      quality,
      method: input.method,
      backgroundShare: share,
      gridDx: 0,
      gridDy: 0,
    });
  }
  const scale = maybeScale(input.prevGrid, input.nextGrid, mask, found.best);
  return finish(ref, 'ok', scale ? '평행이동에 약한 크기 변화가 같이 있습니다.' : '배경 평행이동만 썼습니다.', {
    usable: true,
    dxPx: found.dx * (input.srcW / CAMERA_GRID_W),
    dyPx: found.dy * (input.srcH / CAMERA_GRID_H),
    scale,
    quality,
    method: input.method,
    backgroundShare: share,
    gridDx: found.dx,
    gridDy: found.dy,
  });
}

/** 배경 아핀이 안정되면 그걸 쓰고, 아니면 기존 평행이동으로 내려간다. */
export function estimateCameraPreferAffine(input: {
  prevGray: Uint8Array;
  nextGray: Uint8Array;
  width: number;
  height: number;
  excludeBoxes?: readonly CameraBox[];
  videoId: string;
  subjectId?: string | null;
  t0Sec: number;
  t1Sec: number;
  /** false 로 주면 근거 게이트를 끄고 예전 동작으로 돌아간다(비교 실험용). */
  gateAffine?: boolean;
}): CameraEstimate {
  const { gateAffine } = input;
  const gmc = estimateAffineGmc({
    prevGray: input.prevGray,
    nextGray: input.nextGray,
    width: input.width,
    height: input.height,
    excludeBoxes: input.excludeBoxes,
  });
  /* 잔차가 작다는 것만으로 아핀을 쓰지 않는다.
   *
   * 틀린 대응들도 서로 일관된 움직임을 만든다. 그러면 잔차는 작고 인라이어는
   * 많은데 변환은 틀린 상태가 된다. 2026-09-22 합성 315쌍에서 추정기가 채택한
   * 208개 중 111개가 그랬다. 잘못된 아핀은 상자를 엉뚱한 자리로 밀어 옆 사람과
   * IoU 를 만든다 — 안 쓰는 것보다 나쁘다.
   *
   * 근거가 모자라면 아핀을 버리고 기존 평행이동 경로로 내려간다. 예전에도
   * usable=false 면 그 길로 갔으므로 새 위험을 만들지 않는다. */
  const evidence = gateAffine === false
    ? { evidenceOk: true, reasons: [] as string[] }
    : assessGmcEvidence(gmc);
  if (gmc.usable && evidence.evidenceOk) {
    const ref: AnalysisRef = {
      videoId: input.videoId,
      subjectId: input.subjectId ?? null,
      t0Sec: input.t0Sec,
      t1Sec: input.t1Sec,
      timeBase: 'source',
      analysisVersion: MOTION_ANALYSIS_VERSION,
      provenance: 'local',
    };
    return finish(ref, 'ok', gmc.reason, {
      usable: true,
      dxPx: gmc.dxPx,
      dyPx: gmc.dyPx,
      scale: gmc.scale,
      rotationRad: gmc.rotationRad,
      quality: gmc.quality,
      method: GMC_METHOD_ID,
      backgroundShare: gmc.backgroundShare,
      affine: gmc.affine,
    });
  }
  const fallback = estimateCameraTranslation(input);
  return { ...fallback, affine: null };
}

export function estimateCameraTranslation(input: {
  prevGray: Uint8Array;
  nextGray: Uint8Array;
  width: number;
  height: number;
  excludeBoxes?: readonly CameraBox[];
  videoId: string;
  subjectId?: string | null;
  t0Sec: number;
  t1Sec: number;
}): CameraEstimate {
  const prevGrid = downsampleGray(input.prevGray, input.width, input.height);
  const nextGrid = downsampleGray(input.nextGray, input.width, input.height);
  const mask = input.excludeBoxes?.length
    ? personMask(input.excludeBoxes, input.width, input.height)
    : null;
  return estimateCameraOnGrids({
    prevGrid,
    nextGrid,
    srcW: input.width,
    srcH: input.height,
    mask,
    method: mask ? CAMERA_METHOD_ID : CAMERA_BASELINE_METHOD_ID,
    videoId: input.videoId,
    subjectId: input.subjectId,
    t0Sec: input.t0Sec,
    t1Sec: input.t1Sec,
  });
}

export function compareCameraMethods(input: {
  prevGray: Uint8Array;
  nextGray: Uint8Array;
  width: number;
  height: number;
  excludeBoxes: readonly CameraBox[];
  videoId: string;
  t0Sec: number;
  t1Sec: number;
}): CameraCompareRow {
  const prevGrid = downsampleGray(input.prevGray, input.width, input.height);
  const nextGrid = downsampleGray(input.nextGray, input.width, input.height);
  const mask = personMask(input.excludeBoxes, input.width, input.height);
  const global = estimateCameraOnGrids({
    prevGrid, nextGrid, srcW: input.width, srcH: input.height, mask: null,
    method: CAMERA_BASELINE_METHOD_ID, videoId: input.videoId, t0Sec: input.t0Sec, t1Sec: input.t1Sec,
  });
  const masked = estimateCameraOnGrids({
    prevGrid, nextGrid, srcW: input.width, srcH: input.height, mask,
    method: CAMERA_METHOD_ID, videoId: input.videoId, t0Sec: input.t0Sec, t1Sec: input.t1Sec,
  });
  const chose = masked.usable ? 'masked' : mask && backgroundShare(mask) < 1 - CAMERA_MAX_PERSON_SHARE
    ? 'unavailable'
    : masked.status === 'ok' ? 'masked' : 'unavailable';
  return { global, masked, chose };
}
