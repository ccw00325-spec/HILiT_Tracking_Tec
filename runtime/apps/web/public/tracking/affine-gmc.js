/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·29ce69dd @license @preserve */
/* HILIT Affine GMC — packages/hilit-vision/src/affine-gmc.ts 의 브라우저 사본.
 * OpenCV·BoT-SORT 코드를 가져오지 않았다. 가중치가 없다.
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

export const IDENTITY_AFFINE = { a: 1, b: 0, tx: 0, c: 0, d: 1, ty: 0 };

export function identityGmc(reason, backgroundShare = 1) {
  return {
    diagnostics: { ...EMPTY_DIAGNOSTICS, backgroundShare },
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

export function downsampleGray(gray, srcW, srcH, dstW = GMC_GRID_W, dstH = GMC_GRID_H) {
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

export function personMask(boxes, srcW, srcH, dstW = GMC_GRID_W, dstH = GMC_GRID_H) {
  const mask = new Uint8Array(dstW * dstH);
  mask.fill(1);
  for (const box of boxes || []) {
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

function sample(img, w, h, x, y) {
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

function minEigen(img, w, h, x, y) {
  let ixx = 0, iyy = 0, ixy = 0, n = 0;
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

function patchSad(a, b, w, h, ax, ay, bx, by, rad = 2) {
  let sum = 0, n = 0;
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

function trackPoint(prev, next, w, h, x, y) {
  let bestX = x, bestY = y, best = Infinity;
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

function solve3(a00, a01, a02, a10, a11, a12, a20, a21, a22, b0, b1, b2) {
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

function solveAffine(pairs) {
  if (pairs.length < 3) return null;
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = pairs.length;
  let sux = 0, suy = 0, su = 0, svx = 0, svy = 0, sv = 0;
  for (const p of pairs) {
    sxx += p.x * p.x; sxy += p.x * p.y; sx += p.x;
    syy += p.y * p.y; sy += p.y;
    sux += p.u * p.x; suy += p.u * p.y; su += p.u;
    svx += p.v * p.x; svy += p.v * p.y; sv += p.v;
  }
  const rowX = solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n, sux, suy, su);
  const rowY = solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n, svx, svy, sv);
  if (!rowX || !rowY) return null;
  return { a: rowX[0], b: rowX[1], tx: rowX[2], c: rowY[0], d: rowY[1], ty: rowY[2] };
}

function applyPt(A, x, y) {
  return { x: A.a * x + A.b * y + A.tx, y: A.c * x + A.d * y + A.ty };
}

function residual(A, pairs) {
  let s = 0;
  for (const p of pairs) {
    const q = applyPt(A, p.x, p.y);
    s += Math.hypot(q.x - p.u, q.y - p.v);
  }
  return s / Math.max(1, pairs.length);
}

export function applyAffineToBox(box, A) {
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

export function affineToMotion(A, width, height) {
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

/* 근거 게이트 — packages/hilit-vision/src/gmc-verification.ts 와 같은 값이다.
   scripts/check-android-tracking-parity.mjs 가 세 사본을 기계로 맞춘다. */
export const GMC_MAX_RESIDUAL_P90 = 0.08;
export const GMC_MIN_GRID_CELLS = 9;
export const GMC_MIN_INLIER_RATIO = 0.9;
export const GMC_MIN_INLIER_COUNT = 12;
export const GMC_MAX_RIVAL_SUPPORT = 0.6;

const EMPTY_DIAGNOSTICS = {
  inlierCount: 0, candidatePairs: 0, inlierRatio: 0,
  gridCells: 0, gridCellsTotal: 12,
  residualP50: Infinity, residualP90: Infinity,
  rivalSupportRatio: 1, rivalDisagreementPx: Infinity, backgroundShare: 0,
};

/** 격자 9점에서 두 변환의 예측 차이(축소 좌표계 px). */
function transformGap(a, b) {
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

function describeEvidence(best, kept, pairs, candidates, share) {
  const errs = kept.map((p) => {
    const q = applyPt(best, p.x, p.y);
    return Math.hypot(q.x - p.u, q.y - p.v);
  }).sort((a, b) => a - b);
  const at = (f) => (errs.length
    ? errs[Math.min(errs.length - 1, Math.max(0, Math.ceil(f * (errs.length - 1))))]
    : Infinity);
  const cellsW = 4;
  const cellsH = 3;
  const seen = new Set();
  for (const p of kept) {
    const cx = Math.min(cellsW - 1, Math.floor((p.x / GMC_GRID_W) * cellsW));
    const cy = Math.min(cellsH - 1, Math.floor((p.y / GMC_GRID_H) * cellsH));
    seen.add(cy * cellsW + cx);
  }
  let rivalSupport = 0;
  let rivalGap = Infinity;
  for (const c of candidates) {
    const gap = transformGap(best, c.A);
    if (gap <= 2) continue;
    if (c.support > rivalSupport) { rivalSupport = c.support; rivalGap = gap; }
  }
  return {
    inlierCount: kept.length,
    candidatePairs: pairs.length,
    inlierRatio: pairs.length ? kept.length / pairs.length : 0,
    gridCells: seen.size,
    gridCellsTotal: cellsW * cellsH,
    residualP50: at(0.5),
    residualP90: at(0.9),
    rivalSupportRatio: Math.min(1, rivalSupport / Math.max(1, kept.length)),
    rivalDisagreementPx: rivalGap,
    backgroundShare: share,
  };
}

/** 잔차가 작다는 것만으로 변환을 믿지 않는다. TS 쪽 assessGmcEvidence 와 같은 규칙. */
export function assessGmcEvidence(result) {
  const reasons = [];
  if (!result.usable) reasons.push('not-usable');
  const d = result.diagnostics || EMPTY_DIAGNOSTICS;
  if (d.backgroundShare < 0.42) reasons.push('background-low');
  if (!(d.residualP90 <= GMC_MAX_RESIDUAL_P90)) reasons.push('residual-high');
  if (d.gridCells < GMC_MIN_GRID_CELLS) reasons.push('grid-sparse');
  if (d.inlierRatio < GMC_MIN_INLIER_RATIO) reasons.push('inlier-ratio-low');
  if (d.inlierCount < GMC_MIN_INLIER_COUNT) reasons.push('inlier-count-low');
  if (d.rivalSupportRatio > GMC_MAX_RIVAL_SUPPORT) reasons.push('rival-transform');
  return { evidenceOk: reasons.length === 0, reasons };
}

export function estimateAffineGmc(input) {
  const { width, height } = input;
  if (width < 16 || height < 16) return identityGmc('frame-too-small');
  const prev = downsampleGray(input.prevGray, width, height);
  const next = downsampleGray(input.nextGray, width, height);
  const mask = input.excludeBoxes?.length
    ? personMask(input.excludeBoxes, width, height)
    : null;
  let bg = 0;
  for (let i = 0; i < prev.length; i += 1) if (!mask || mask[i]) bg += 1;
  const share = bg / prev.length;
  if (share < 0.42) return identityGmc('person_fills', share);

  const pts = [];
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

  const pairs = [];
  for (const p of chosen) {
    const fwd = trackPoint(prev, next, GMC_GRID_W, GMC_GRID_H, p.x, p.y);
    if (!fwd) continue;
    const back = trackPoint(next, prev, GMC_GRID_W, GMC_GRID_H, fwd.x, fwd.y);
    if (!back) continue;
    if (Math.hypot(back.x - p.x, back.y - p.y) > GMC_FB_PX) continue;
    pairs.push({ x: p.x, y: p.y, u: fwd.x, v: fwd.y });
  }
  if (pairs.length < GMC_MIN_INLIERS) return identityGmc('too-few-inliers', share);

  let bestA = null;
  let bestRes = Infinity;
  let bestKept = [];
  const candidates = [];
  const trials = Math.min(24, pairs.length);
  for (let t = 0; t < trials; t += 1) {
    const sample3 = [];
    for (let k = 0; k < 3; k += 1) sample3.push(pairs[(t * 3 + k * 7) % pairs.length]);
    const A = solveAffine(sample3);
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
  const full = {
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
