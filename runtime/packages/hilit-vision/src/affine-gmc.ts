/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·307e7ca1 @license @preserve */
/* HILIT Affine GMC — 배경으로 카메라 아핀을 추정한다.

OpenCV·BoT-SORT 코드를 가져오지 않았다. 변환식(배경 점 대응 → 아핀)만
자체로 푼다. 가중치·학습 데이터가 없다.

카메라가 움직이면 화면의 모든 상자가 같이 밀린다. 그 밀림을 사람 이동으로
읽으면 옆 사람 자리와 IoU가 생기며 신원이 바뀐다. 이 모듈은 예측 상자를
배경 좌표로 옮길 뿐, 동일인을 확정하지 않는다.

사람이 화면을 많이 가리거나 대응이 빈약하면 usable=false 다. 틀린 변환이
상자를 더 밀어내는 편이, 안 쓰는 것보다 나쁘다.
*/

export const GMC_METHOD_ID = 'hilit-affine-gmc-v1';
export const GMC_GRID_W = 80;
export const GMC_GRID_H = 48;
export const GMC_SEARCH = 6;
export const GMC_MIN_INLIERS = 8;
export const GMC_FB_PX = 1.6;
export const GMC_MAX_SCALE = 1.18;
export const GMC_MIN_SCALE = 0.84;
export const GMC_MAX_ROT_RAD = 0.18;

export interface GmcBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** x' = a x + b y + tx,  y' = c x + d y + ty */
export interface Affine2D {
  a: number;
  b: number;
  tx: number;
  c: number;
  d: number;
  ty: number;
}

/* 변환을 믿어도 되는지 판단할 때 쓰는 근거들.

   잔차가 작다는 것만으로 변환을 확정하면 안 된다. 반복 무늬에서는 **틀린
   대응들도 서로 일관된 움직임을 만든다** — 잔차는 작고 인라이어는 많은데
   변환은 틀린 상태가 된다. 2026-09-22 합성 시험에서 반복 무늬 35쌍 전부가
   그렇게 통과했다. 그래서 지지도가 비슷하면서 서로 다른 후보 변환이 있었는지
   (rivalSupportRatio)를 같이 잰다.

   이 값들은 카메라 변환의 근거이지 동일인 판정 근거가 아니다. */
export interface GmcDiagnostics {
  /** RANSAC 최종 모델의 인라이어 수. */
  inlierCount: number;
  /** 왕복 검사를 통과해 RANSAC 에 들어간 후보 대응 수. */
  candidatePairs: number;
  /** inlierCount / candidatePairs. */
  inlierRatio: number;
  /** 인라이어가 들어 있는 격자 칸 수(4×3). */
  gridCells: number;
  gridCellsTotal: number;
  /** 인라이어 재투영 오차(축소 좌표계 px). */
  residualP50: number;
  residualP90: number;
  /**
   * 최선 모델과 **다른 변환인데도** 비슷한 지지를 받은 후보의 지지 비율.
   * 1 에 가까울수록 "이 변환이라고 말할 근거가 없다" 는 뜻이다.
   */
  rivalSupportRatio: number;
  /** 그 경쟁 모델이 격자에서 최선 모델과 얼마나 다른가(축소 좌표계 px). */
  rivalDisagreementPx: number;
  backgroundShare: number;
}

export interface AffineGmcResult {
  method: typeof GMC_METHOD_ID;
  usable: boolean;
  quality: number;
  reason: string;
  affine: Affine2D;
  dxPx: number;
  dyPx: number;
  scale: number;
  rotationRad: number;
  /**
   * 왕복 검사를 통과한 후보 대응 수.
   *
   * 🔴 RANSAC 인라이어 수가 아니다. 이름 때문에 인라이어 비율을 계산하면
   * 항상 1 이 된다. 인라이어 수는 diagnostics.inlierCount 를 쓴다.
   * 기존 소비자가 이 값을 쓰고 있어 의미를 바꾸지 않고 두었다.
   */
  inliers: number;
  backgroundShare: number;
  diagnostics: GmcDiagnostics;
}

export const EMPTY_GMC_DIAGNOSTICS: GmcDiagnostics = {
  inlierCount: 0,
  candidatePairs: 0,
  inlierRatio: 0,
  gridCells: 0,
  gridCellsTotal: 12,
  residualP50: Number.POSITIVE_INFINITY,
  residualP90: Number.POSITIVE_INFINITY,
  rivalSupportRatio: 1,
  rivalDisagreementPx: Number.POSITIVE_INFINITY,
  backgroundShare: 0,
};

export const IDENTITY_AFFINE: Affine2D = { a: 1, b: 0, tx: 0, c: 0, d: 1, ty: 0 };

export function identityGmc(reason: string, backgroundShare = 1): AffineGmcResult {
  return {
    diagnostics: { ...EMPTY_GMC_DIAGNOSTICS, backgroundShare },
    method: GMC_METHOD_ID,
    usable: false,
    quality: 0,
    reason,
    affine: { ...IDENTITY_AFFINE },
    dxPx: 0,
    dyPx: 0,
    scale: 1,
    rotationRad: 0,
    inliers: 0,
    backgroundShare,
  };
}

export function downsampleGray(
  gray: Uint8Array,
  srcW: number,
  srcH: number,
  dstW = GMC_GRID_W,
  dstH = GMC_GRID_H,
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
  boxes: readonly GmcBox[],
  srcW: number,
  srcH: number,
  dstW = GMC_GRID_W,
  dstH = GMC_GRID_H,
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

function sample(img: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const dx = x - x0;
  const dy = y - y0;
  const i = y0 * w + x0;
  return (1 - dx) * (1 - dy) * img[i]
    + dx * (1 - dy) * img[i + 1]
    + (1 - dx) * dy * img[i + w]
    + dx * dy * img[i + w + 1];
}

function minEigen(img: Uint8Array, w: number, h: number, x: number, y: number): number {
  let ixx = 0;
  let iyy = 0;
  let ixy = 0;
  let n = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const gx = sample(img, w, h, x + dx + 1, y + dy) - sample(img, w, h, x + dx - 1, y + dy);
      const gy = sample(img, w, h, x + dx, y + dy + 1) - sample(img, w, h, x + dx, y + dy - 1);
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
      ixx += gx * gx;
      iyy += gy * gy;
      ixy += gx * gy;
      n += 1;
    }
  }
  if (n < 8) return 0;
  const tr = ixx + iyy;
  const det = ixx * iyy - ixy * ixy;
  return 0.5 * (tr - Math.sqrt(Math.max(0, tr * tr - 4 * det)));
}

function patchSad(
  a: Uint8Array,
  b: Uint8Array,
  w: number,
  h: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rad = 2,
): number {
  let sum = 0;
  let n = 0;
  for (let dy = -rad; dy <= rad; dy += 1) {
    for (let dx = -rad; dx <= rad; dx += 1) {
      const va = sample(a, w, h, ax + dx, ay + dy);
      const vb = sample(b, w, h, bx + dx, by + dy);
      if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
      sum += Math.abs(va - vb);
      n += 1;
    }
  }
  return n < 9 ? Infinity : sum / n;
}

function trackPoint(
  prev: Uint8Array,
  next: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
): { x: number; y: number; err: number } | null {
  let bestX = x;
  let bestY = y;
  let best = Infinity;
  for (let oy = -GMC_SEARCH; oy <= GMC_SEARCH; oy += 1) {
    for (let ox = -GMC_SEARCH; ox <= GMC_SEARCH; ox += 1) {
      const sad = patchSad(prev, next, w, h, x, y, x + ox, y + oy);
      if (sad < best) {
        best = sad;
        bestX = x + ox;
        bestY = y + oy;
      }
    }
  }
  if (!Number.isFinite(best) || best > 48) return null;
  return { x: bestX, y: bestY, err: best };
}

function solveAffine(pairs: Array<{ x: number; y: number; u: number; v: number }>): Affine2D | null {
  if (pairs.length < 3) return null;
  /* 정규방정식 3x3 두 번(x', y'). */
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = pairs.length;
  let sux = 0, suy = 0, su = 0, svx = 0, svy = 0, sv = 0;
  for (const p of pairs) {
    sxx += p.x * p.x;
    sxy += p.x * p.y;
    sx += p.x;
    syy += p.y * p.y;
    sy += p.y;
    sux += p.u * p.x;
    suy += p.u * p.y;
    su += p.u;
    svx += p.v * p.x;
    svy += p.v * p.y;
    sv += p.v;
  }
  const rowX = solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n, sux, suy, su);
  const rowY = solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n, svx, svy, sv);
  if (!rowX || !rowY) return null;
  return { a: rowX[0], b: rowX[1], tx: rowX[2], c: rowY[0], d: rowY[1], ty: rowY[2] };
}

function solve3(
  a00: number, a01: number, a02: number,
  a10: number, a11: number, a12: number,
  a20: number, a21: number, a22: number,
  b0: number, b1: number, b2: number,
): [number, number, number] | null {
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-8) return null;
  const inv = 1 / det;
  const c00 = (a11 * a22 - a12 * a21) * inv;
  const c01 = (a02 * a21 - a01 * a22) * inv;
  const c02 = (a01 * a12 - a02 * a11) * inv;
  const c10 = (a12 * a20 - a10 * a22) * inv;
  const c11 = (a00 * a22 - a02 * a20) * inv;
  const c12 = (a02 * a10 - a00 * a12) * inv;
  const c20 = (a10 * a21 - a11 * a20) * inv;
  const c21 = (a01 * a20 - a00 * a21) * inv;
  const c22 = (a00 * a11 - a01 * a10) * inv;
  return [
    c00 * b0 + c01 * b1 + c02 * b2,
    c10 * b0 + c11 * b1 + c12 * b2,
    c20 * b0 + c21 * b1 + c22 * b2,
  ];
}

function applyPt(A: Affine2D, x: number, y: number): { x: number; y: number } {
  return { x: A.a * x + A.b * y + A.tx, y: A.c * x + A.d * y + A.ty };
}

function residual(A: Affine2D, pairs: Array<{ x: number; y: number; u: number; v: number }>): number {
  let s = 0;
  for (const p of pairs) {
    const q = applyPt(A, p.x, p.y);
    s += Math.hypot(q.x - p.u, q.y - p.v);
  }
  return s / Math.max(1, pairs.length);
}

export function applyAffineToBox(box: GmcBox, A: Affine2D): GmcBox {
  const c = applyPt(A, box.x + box.width / 2, box.y + box.height / 2);
  const scale = Math.sqrt(Math.abs(A.a * A.d - A.b * A.c));
  const s = Number.isFinite(scale) && scale > 0.2 ? scale : 1;
  return {
    x: c.x - (box.width * s) / 2,
    y: c.y - (box.height * s) / 2,
    width: box.width * s,
    height: box.height * s,
  };
}

export function affineToMotion(A: Affine2D, width: number, height: number): {
  dxPx: number; dyPx: number; scale: number; rotationRad: number;
} {
  const mid = applyPt(A, width / 2, height / 2);
  const scale = Math.sqrt(Math.abs(A.a * A.d - A.b * A.c));
  const rotationRad = Math.atan2(A.c, A.a);
  return {
    dxPx: mid.x - width / 2,
    dyPx: mid.y - height / 2,
    scale: Number.isFinite(scale) && scale > 0.2 ? scale : 1,
    rotationRad: Number.isFinite(rotationRad) ? rotationRad : 0,
  };
}

export function estimateAffineGmc(input: {
  prevGray: Uint8Array;
  nextGray: Uint8Array;
  width: number;
  height: number;
  excludeBoxes?: readonly GmcBox[];
  /**
   * 선택. 80×48 격자에서 1 = 배경으로 써도 되는 칸. 선수 마스크를 넓혀 만든다.
   * 상자보다 좁게 빼므로 배경 특징점을 덜 잃는다. 주면 excludeBoxes 대신 쓴다.
   * 넘기지 않으면 예전과 똑같이 동작한다.
   */
  backgroundMask?: Uint8Array | null;
}): AffineGmcResult {
  const { width, height } = input;
  if (width < 16 || height < 16) return identityGmc('frame-too-small');
  const prev = downsampleGray(input.prevGray, width, height);
  const next = downsampleGray(input.nextGray, width, height);
  const mask = input.backgroundMask && input.backgroundMask.length === GMC_GRID_W * GMC_GRID_H
    ? input.backgroundMask
    : input.excludeBoxes?.length
      ? personMask(input.excludeBoxes, width, height)
      : null;
  let bg = 0;
  for (let i = 0; i < prev.length; i += 1) if (!mask || mask[i]) bg += 1;
  const share = bg / prev.length;
  if (share < 0.42) return identityGmc('person_fills', share);

  const pts: Array<{ x: number; y: number; score: number }> = [];
  for (let y = 6; y < GMC_GRID_H - 6; y += 5) {
    for (let x = 6; x < GMC_GRID_W - 6; x += 5) {
      if (mask && !mask[y * GMC_GRID_W + x]) continue;
      const score = minEigen(prev, GMC_GRID_W, GMC_GRID_H, x, y);
      if (score < 18) continue;
      pts.push({ x, y, score });
    }
  }
  pts.sort((a, b) => b.score - a.score);
  const chosen = pts.slice(0, 48);
  if (chosen.length < GMC_MIN_INLIERS) return identityGmc('too-few-corners', share);

  const pairs: Array<{ x: number; y: number; u: number; v: number }> = [];
  for (const p of chosen) {
    const fwd = trackPoint(prev, next, GMC_GRID_W, GMC_GRID_H, p.x, p.y);
    if (!fwd) continue;
    const back = trackPoint(next, prev, GMC_GRID_W, GMC_GRID_H, fwd.x, fwd.y);
    if (!back) continue;
    if (Math.hypot(back.x - p.x, back.y - p.y) > GMC_FB_PX) continue;
    pairs.push({ x: p.x, y: p.y, u: fwd.x, v: fwd.y });
  }
  if (pairs.length < GMC_MIN_INLIERS) return identityGmc('too-few-inliers', share);

  let bestA: Affine2D | null = null;
  let bestRes = Infinity;
  let bestKept: typeof pairs = [];
  /* 채택된 모델 말고도 지지를 받은 후보를 남긴다. 반복 무늬에서는 서로 다른
     변환이 비슷한 지지를 받는데, 그걸 보지 않으면 "잔차가 작으니 맞다" 로
     넘어간다. */
  const candidates: Array<{ A: Affine2D; support: number }> = [];
  const trials = Math.min(24, pairs.length);
  for (let t = 0; t < trials; t += 1) {
    const sample: typeof pairs = [];
    for (let k = 0; k < 3; k += 1) {
      sample.push(pairs[(t * 3 + k * 7) % pairs.length]);
    }
    const A = solveAffine(sample);
    if (!A) continue;
    const kept = pairs.filter((p) => {
      const q = applyPt(A, p.x, p.y);
      return Math.hypot(q.x - p.u, q.y - p.v) < 2.2;
    });
    if (kept.length < GMC_MIN_INLIERS) continue;
    const refined = solveAffine(kept);
    if (!refined) continue;
    candidates.push({ A: refined, support: kept.length });
    const res = residual(refined, kept);
    if (res < bestRes) {
      bestRes = res;
      bestA = refined;
      bestKept = kept;
    }
  }
  if (!bestA) return identityGmc('affine-unstable', share);

  const diagnostics = describeEvidence(bestA, bestKept, pairs, candidates, share);

  const sx = width / GMC_GRID_W;
  const sy = height / GMC_GRID_H;
  const full: Affine2D = {
    a: bestA.a,
    b: bestA.b * (sx / sy),
    tx: bestA.tx * sx,
    c: bestA.c * (sy / sx),
    d: bestA.d,
    ty: bestA.ty * sy,
  };
  const motion = affineToMotion(full, width, height);
  if (motion.scale < GMC_MIN_SCALE || motion.scale > GMC_MAX_SCALE) {
    return identityGmc('scale-out-of-range', share);
  }
  if (Math.abs(motion.rotationRad) > GMC_MAX_ROT_RAD) {
    return identityGmc('rotation-out-of-range', share);
  }
  const quality = Math.max(0, Math.min(1, 1 - bestRes / 3));
  if (quality < 0.18) return identityGmc('low-quality', share);
  return {
    method: GMC_METHOD_ID,
    usable: true,
    quality,
    reason: 'affine-background',
    affine: full,
    dxPx: motion.dxPx,
    dyPx: motion.dyPx,
    scale: motion.scale,
    rotationRad: motion.rotationRad,
    inliers: pairs.length,
    backgroundShare: share,
    diagnostics,
  };
}

interface EvidencePair { x: number; y: number; u: number; v: number }

/** 격자 8점에서 두 변환이 얼마나 다르게 예측하는지(축소 좌표계 px). */
function transformGap(a: Affine2D, b: Affine2D): number {
  let worst = 0;
  for (let gy = 0; gy < 3; gy += 1) {
    for (let gx = 0; gx < 3; gx += 1) {
      const x = (GMC_GRID_W * (gx + 0.5)) / 3;
      const y = (GMC_GRID_H * (gy + 0.5)) / 3;
      const p = applyPt(a, x, y);
      const q = applyPt(b, x, y);
      worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
    }
  }
  return worst;
}

function describeEvidence(
  best: Affine2D,
  kept: readonly EvidencePair[],
  pairs: readonly EvidencePair[],
  candidates: ReadonlyArray<{ A: Affine2D; support: number }>,
  share: number,
): GmcDiagnostics {
  const errs = kept.map((p) => {
    const q = applyPt(best, p.x, p.y);
    return Math.hypot(q.x - p.u, q.y - p.v);
  }).sort((a, b) => a - b);
  const at = (f: number): number => (errs.length
    ? errs[Math.min(errs.length - 1, Math.max(0, Math.ceil(f * (errs.length - 1))))]
    : Number.POSITIVE_INFINITY);

  const cellsW = 4;
  const cellsH = 3;
  const seen = new Set<number>();
  for (const p of kept) {
    const cx = Math.min(cellsW - 1, Math.floor((p.x / GMC_GRID_W) * cellsW));
    const cy = Math.min(cellsH - 1, Math.floor((p.y / GMC_GRID_H) * cellsH));
    seen.add(cy * cellsW + cx);
  }

  /* 최선 모델과 뚜렷이 다른 변환 중 가장 많은 지지를 받은 것.
     "뚜렷이 다르다" 는 격자 예측이 2px 넘게 벌어지는 것으로 본다. */
  let rivalSupport = 0;
  let rivalGap = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const gap = transformGap(best, c.A);
    if (gap <= 2) continue;
    if (c.support > rivalSupport) {
      rivalSupport = c.support;
      rivalGap = gap;
    }
  }
  const bestSupport = Math.max(1, kept.length);
  return {
    inlierCount: kept.length,
    candidatePairs: pairs.length,
    inlierRatio: pairs.length ? kept.length / pairs.length : 0,
    gridCells: seen.size,
    gridCellsTotal: cellsW * cellsH,
    residualP50: at(0.5),
    residualP90: at(0.9),
    rivalSupportRatio: Math.min(1, rivalSupport / bestSupport),
    rivalDisagreementPx: rivalGap,
    backgroundShare: share,
  };
}
