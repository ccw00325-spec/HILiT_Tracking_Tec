/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·a9d1fa08 @license @preserve */
/* DCT·SVD 품질 특징 — 추적 결함 위험 분류기의 입력.

이 값들은 신원 특징이 아니다. 영상이 흐린지, 압축으로 깨졌는지, 마스크가
찌그러졌는지 같은 "지금 판단을 믿어도 되는가" 를 숫자로 만든 것이다.

  - Re-ID embedding·외곽선·HSV 벡터와 이어 붙이지 않는다 (family 가 다르다).
  - 장기 저장하지 않는다. RAM 에서 짧게 쓰고 버린다.
  - LightGlue 같은 정합기에 넣지 않는다.

수치 일관성을 위해 고정한 것 (플랫폼을 옮길 때 그대로 따라야 한다):
  - 회색조: 0.299 R + 0.587 G + 0.114 B, 0~1 로 나눔
  - 크기 조정: 쌍선형(bilinear), 화소 중심 정렬 ((x+0.5)·s − 0.5), 가장자리 복제
  - 마스크 크기 조정: 최근접(nearest), 화소 중심 정렬
  - DCT: 정규직교 DCT-II (행 → 열 순서), 평균을 빼지 않는다(DC 가 밝기를 담는다)
  - 주파수 띠: r = u/W + v/H (u, v 는 0 부터). 저 r<0.25, 중 0.25≤r<0.75, 고 r≥0.75, DC 제외
  - SVD: 입력 행렬에서 전체 평균을 뺀 뒤 AᵀA 의 Jacobi 고유값 → 특이값 = √λ
  - 정밀도: float64 로 계산하고, 내보낼 때 소수 6자리로 반올림
*/

export const DEFECT_FEATURE_FAMILY = 'tracking-defect-quality' as const;
export const DEFECT_FEATURE_SCHEMA_VERSION = 'defect-features-v1';

export const DCT_GLOBAL_SIZE = Object.freeze({ w: 64, h: 36 });
export const DCT_ROI_SIZE = Object.freeze({ w: 32, h: 64 });
export const SVD_ROI_SIZE = Object.freeze({ w: 16, h: 32 });
export const SVD_MASK_SIZE = Object.freeze({ w: 16, h: 32 });
export const DCT_BLOCK = 8;
export const SVD_TOP_K = 4;

export function round6(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : Number.NaN;
}

export function rgbToGray01(rgb: ArrayLike<number>, w: number, h: number, stride = 3): Float64Array {
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const j = i * stride;
    out[i] = (0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2]) / 255;
  }
  return out;
}

export interface Rect { x: number; y: number; width: number; height: number }

/** 쌍선형 크기 조정. rect 는 원본 좌표. 화소 중심 정렬, 가장자리 복제. */
export function resizeBilinear(src: ArrayLike<number>, sw: number, sh: number, rect: Rect, ow: number, oh: number): Float64Array {
  const out = new Float64Array(ow * oh);
  const sx = rect.width / ow;
  const sy = rect.height / oh;
  for (let y = 0; y < oh; y += 1) {
    const fy = rect.y + (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(fy);
    const dy = fy - y0;
    const ya = Math.min(sh - 1, Math.max(0, y0));
    const yb = Math.min(sh - 1, Math.max(0, y0 + 1));
    for (let x = 0; x < ow; x += 1) {
      const fx = rect.x + (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(fx);
      const dx = fx - x0;
      const xa = Math.min(sw - 1, Math.max(0, x0));
      const xb = Math.min(sw - 1, Math.max(0, x0 + 1));
      out[y * ow + x] = (1 - dy) * ((1 - dx) * src[ya * sw + xa] + dx * src[ya * sw + xb])
        + dy * ((1 - dx) * src[yb * sw + xa] + dx * src[yb * sw + xb]);
    }
  }
  return out;
}

/** 최근접 크기 조정 (마스크용). */
export function resizeNearest(src: ArrayLike<number>, sw: number, sh: number, rect: Rect, ow: number, oh: number): Float64Array {
  const out = new Float64Array(ow * oh);
  for (let y = 0; y < oh; y += 1) {
    const yy = Math.min(sh - 1, Math.max(0, Math.floor(rect.y + (y + 0.5) * rect.height / oh)));
    for (let x = 0; x < ow; x += 1) {
      const xx = Math.min(sw - 1, Math.max(0, Math.floor(rect.x + (x + 0.5) * rect.width / ow)));
      out[y * ow + x] = src[yy * sw + xx] ? 1 : 0;
    }
  }
  return out;
}

/* ---------- DCT ---------- */

const cosCache = new Map<number, Float64Array>();

function cosTable(n: number): Float64Array {
  let t = cosCache.get(n);
  if (t) return t;
  t = new Float64Array(n * n);
  for (let k = 0; k < n; k += 1) {
    const a = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    for (let i = 0; i < n; i += 1) t[k * n + i] = a * Math.cos((Math.PI * (2 * i + 1) * k) / (2 * n));
  }
  cosCache.set(n, t);
  return t;
}

/** 정규직교 2D DCT-II. 행 방향 먼저, 그다음 열 방향. */
export function dct2(img: ArrayLike<number>, w: number, h: number): Float64Array {
  const cw = cosTable(w);
  const ch = cosTable(h);
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let u = 0; u < w; u += 1) {
      let s = 0;
      for (let x = 0; x < w; x += 1) s += cw[u * w + x] * img[y * w + x];
      tmp[y * w + u] = s;
    }
  }
  const out = new Float64Array(w * h);
  for (let v = 0; v < h; v += 1) {
    for (let u = 0; u < w; u += 1) {
      let s = 0;
      for (let y = 0; y < h; y += 1) s += ch[v * h + y] * tmp[y * w + u];
      out[v * w + u] = s;
    }
  }
  return out;
}

export const DCT_FEATURE_NAMES = [
  'dcLogEnergy', 'acLogEnergy', 'dcAcRatio', 'lowRatio', 'midRatio', 'highRatio',
  'horizRatio', 'vertRatio', 'diagRatio', 'spectralEntropy', 'highAttenuation',
  'blockBoundaryRatio', 'hvAsymmetry', 'lowConcentration', 'coefKurtosis',
] as const;
export type DctFeatureName = typeof DCT_FEATURE_NAMES[number];

export interface DctFeatures {
  values: Record<DctFeatureName, number>;
  reliability: number;
}

function emptyDct(): DctFeatures {
  const values = {} as Record<DctFeatureName, number>;
  for (const n of DCT_FEATURE_NAMES) values[n] = Number.NaN;
  return { values, reliability: 0 };
}

/**
 * 블록 경계 에너지: 8화소 경계를 가로지르는 차이 / 블록 안쪽 차이.
 * 압축 블록 현상이 있으면 1 보다 커진다. 크기가 조정된 입력이 아니라
 * 원본 좌표 격자에서 재야 하므로 따로 받는다.
 */
export function blockBoundaryRatio(img: ArrayLike<number>, w: number, h: number, block = DCT_BLOCK, offX = 0, offY = 0): number {
  let bSum = 0;
  let bN = 0;
  let iSum = 0;
  let iN = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 1; x < w; x += 1) {
      const d = Math.abs(img[y * w + x] - img[y * w + x - 1]);
      if ((x + offX) % block === 0) {
        bSum += d;
        bN += 1;
      } else {
        iSum += d;
        iN += 1;
      }
    }
  }
  for (let y = 1; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.abs(img[y * w + x] - img[(y - 1) * w + x]);
      if ((y + offY) % block === 0) {
        bSum += d;
        bN += 1;
      } else {
        iSum += d;
        iN += 1;
      }
    }
  }
  if (!bN || !iN) return Number.NaN;
  const b = bSum / bN;
  const i = iSum / iN;
  return (b + 1e-4) / (i + 1e-4);
}

/**
 * 크기를 맞춘 회색조 입력의 DCT 품질 특징. mask 가 있으면 mask 밖은 입력 평균으로 채운다
 * (배경 혼입을 줄이되 경계가 인공 고주파를 만들지 않게).
 */
export function dctQualityFeatures(img: ArrayLike<number>, w: number, h: number, opts: {
  mask?: ArrayLike<number> | null;
  blockBoundary?: number | null;
} = {}): DctFeatures {
  if (w < 4 || h < 4 || img.length < w * h) return emptyDct();
  let x = img as ArrayLike<number>;
  if (opts.mask) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < w * h; i += 1) if (opts.mask[i]) {
      s += img[i];
      n += 1;
    }
    if (n < 8) return emptyDct();
    const m = s / n;
    const f = new Float64Array(w * h);
    for (let i = 0; i < w * h; i += 1) f[i] = opts.mask[i] ? img[i] : m;
    x = f;
  }
  for (let i = 0; i < w * h; i += 1) if (!Number.isFinite(x[i])) return emptyDct();
  const c = dct2(x, w, h);
  const dc = c[0] * c[0];
  let ac = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  let hor = 0;
  let ver = 0;
  let diag = 0;
  let m2 = 0;
  let m4 = 0;
  let nAc = 0;
  const e: number[] = [];
  for (let v = 0; v < h; v += 1) {
    for (let u = 0; u < w; u += 1) {
      if (u === 0 && v === 0) continue;
      const k = c[v * w + u];
      const p = k * k;
      ac += p;
      e.push(p);
      const r = u / w + v / h;
      if (r < 0.25) low += p;
      else if (r < 0.75) mid += p;
      else high += p;
      // 수평 주파수(세로 무늬 = 가로 방향 변화)는 v 가 작고 u 가 큰 쪽
      if (u > 2 * v) hor += p;
      else if (v > 2 * u) ver += p;
      else diag += p;
      m2 += k * k;
      m4 += k * k * k * k;
      nAc += 1;
    }
  }
  if (ac <= 1e-12) {
    const vals = emptyDct().values;
    vals.dcLogEnergy = round6(Math.log10(dc + 1e-9));
    vals.acLogEnergy = round6(Math.log10(1e-9));
    return { values: vals, reliability: 0 };
  }
  let ent = 0;
  for (const p of e) {
    const q = p / ac;
    if (q > 0) ent -= q * Math.log(q);
  }
  ent /= Math.log(nAc);
  const variance = m2 / nAc;
  const kurt = variance > 1e-12 ? (m4 / nAc) / (variance * variance) : Number.NaN;
  const values: Record<DctFeatureName, number> = {
    dcLogEnergy: round6(Math.log10(dc + 1e-9)),
    acLogEnergy: round6(Math.log10(ac + 1e-9)),
    dcAcRatio: round6(Math.log10((dc + 1e-9) / (ac + 1e-9))),
    lowRatio: round6(low / ac),
    midRatio: round6(mid / ac),
    highRatio: round6(high / ac),
    horizRatio: round6(hor / ac),
    vertRatio: round6(ver / ac),
    diagRatio: round6(diag / ac),
    spectralEntropy: round6(ent),
    highAttenuation: round6(Math.log10((high + 1e-9) / (mid + 1e-9))),
    blockBoundaryRatio: round6(opts.blockBoundary ?? Number.NaN),
    hvAsymmetry: round6((hor - ver) / (hor + ver + 1e-12)),
    lowConcentration: round6(low / (low + mid + high)),
    coefKurtosis: round6(Math.log10(Math.max(1e-6, kurt))),
  };
  return { values, reliability: 1 };
}

/* ---------- SVD ---------- */

/** 대칭 행렬(n×n)의 고유값. 순환 Jacobi. 작은 n 에서만 쓴다. */
export function symmetricEigenvalues(a: Float64Array, n: number, maxSweeps = 30): Float64Array {
  const m = Float64Array.from(a);
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) for (let q = p + 1; q < n; q += 1) off += m[p * n + q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = m[p * n + q];
        if (Math.abs(apq) < 1e-15) continue;
        const app = m[p * n + p];
        const aqq = m[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        for (let k = 0; k < n; k += 1) {
          const akp = m[k * n + p];
          const akq = m[k * n + q];
          m[k * n + p] = cs * akp - sn * akq;
          m[k * n + q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = m[p * n + k];
          const aqk = m[q * n + k];
          m[p * n + k] = cs * apk - sn * aqk;
          m[q * n + k] = sn * apk + cs * aqk;
        }
      }
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = m[i * n + i];
  return out;
}

/** rows×cols 행렬의 특이값(내림차순). 전체 평균을 먼저 뺀다(center=true). */
export function singularValues(mat: ArrayLike<number>, rows: number, cols: number, center = true): Float64Array | null {
  if (rows < 2 || cols < 2 || mat.length < rows * cols) return null;
  let mean = 0;
  for (let i = 0; i < rows * cols; i += 1) {
    if (!Number.isFinite(mat[i])) return null;
    mean += mat[i];
  }
  mean = center ? mean / (rows * cols) : 0;
  // 작은 쪽 차원으로 Gram 행렬을 만든다
  const n = Math.min(rows, cols);
  const g = new Float64Array(n * n);
  if (cols <= rows) {
    for (let i = 0; i < cols; i += 1) for (let j = i; j < cols; j += 1) {
      let s = 0;
      for (let r = 0; r < rows; r += 1) s += (mat[r * cols + i] - mean) * (mat[r * cols + j] - mean);
      g[i * n + j] = s;
      g[j * n + i] = s;
    }
  } else {
    for (let i = 0; i < rows; i += 1) for (let j = i; j < rows; j += 1) {
      let s = 0;
      for (let c = 0; c < cols; c += 1) s += (mat[i * cols + c] - mean) * (mat[j * cols + c] - mean);
      g[i * n + j] = s;
      g[j * n + i] = s;
    }
  }
  const ev = symmetricEigenvalues(g, n);
  const sv = Array.from(ev, (v) => Math.sqrt(Math.max(0, v))).sort((a, b) => b - a);
  return Float64Array.from(sv);
}

export const SVD_FEATURE_NAMES = [
  's1Energy', 's1s2Ratio', 'topKEnergy', 'rank90', 'effectiveRank', 'svEntropy',
  'lowRankResidual', 'spectrumSlope', 'sv1', 'sv2', 'sv3', 'sv4',
] as const;
export type SvdFeatureName = typeof SVD_FEATURE_NAMES[number];

export interface SvdFeatures {
  values: Record<SvdFeatureName, number>;
  reliability: number;
  spectrum: Float64Array | null;
}

export function emptySvd(): SvdFeatures {
  const values = {} as Record<SvdFeatureName, number>;
  for (const n of SVD_FEATURE_NAMES) values[n] = Number.NaN;
  return { values, reliability: 0, spectrum: null };
}

/** 특이값 스펙트럼 → 구조 특징. 에너지가 0 이면(평평한 입력) 신뢰도 0. */
export function svdFeaturesFromSpectrum(sv: Float64Array | null, topK = SVD_TOP_K): SvdFeatures {
  if (!sv || !sv.length) return emptySvd();
  const e = Array.from(sv, (s) => s * s);
  const total = e.reduce((a, b) => a + b, 0);
  if (!(total > 1e-12)) return { ...emptySvd(), spectrum: sv };
  let cum = 0;
  let rank90 = e.length;
  for (let i = 0; i < e.length; i += 1) {
    cum += e[i];
    if (cum >= 0.9 * total) {
      rank90 = i + 1;
      break;
    }
  }
  let ent = 0;
  const sSum = sv.reduce((a, b) => a + b, 0);
  for (const s of sv) {
    const p = s / sSum;
    if (p > 0) ent -= p * Math.log(p);
  }
  const k = Math.min(topK, e.length);
  let topE = 0;
  for (let i = 0; i < k; i += 1) topE += e[i];
  // 로그 특이값의 기울기 (상위 8개)
  const m = Math.min(8, sv.length);
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let cnt = 0;
  for (let i = 0; i < m; i += 1) {
    if (sv[i] <= 1e-12) continue;
    const y = Math.log(sv[i]);
    sx += i;
    sy += y;
    sxx += i * i;
    sxy += i * y;
    cnt += 1;
  }
  const slope = cnt >= 2 ? (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx) : Number.NaN;
  const norm = Math.sqrt(total);
  const values: Record<SvdFeatureName, number> = {
    s1Energy: round6(e[0] / total),
    s1s2Ratio: round6(Math.log10((sv[0] + 1e-9) / ((sv[1] ?? 0) + 1e-9))),
    topKEnergy: round6(topE / total),
    rank90: round6(rank90 / e.length),
    effectiveRank: round6(Math.exp(ent) / e.length),
    svEntropy: round6(ent / Math.log(Math.max(2, sv.length))),
    lowRankResidual: round6(Math.sqrt(Math.max(0, total - topE) / total)),
    spectrumSlope: round6(slope),
    sv1: round6((sv[0] ?? 0) / norm),
    sv2: round6((sv[1] ?? 0) / norm),
    sv3: round6((sv[2] ?? 0) / norm),
    sv4: round6((sv[3] ?? 0) / norm),
  };
  return { values, reliability: 1, spectrum: sv };
}

export function svdFeatures(mat: ArrayLike<number>, rows: number, cols: number, center = true): SvdFeatures {
  return svdFeaturesFromSpectrum(singularValues(mat, rows, cols, center));
}

/** 두 스펙트럼(정규화 후)의 L1 차이. 시간 변화·mask 대 ROI 불일치에 쓴다. */
export function spectrumDistance(a: Float64Array | null, b: Float64Array | null, k = 8): number {
  if (!a || !b) return Number.NaN;
  const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (!(na > 1e-12) || !(nb > 1e-12)) return Number.NaN;
  let d = 0;
  for (let i = 0; i < k; i += 1) d += Math.abs((a[i] ?? 0) / na - (b[i] ?? 0) / nb);
  return round6(d);
}

/** 크기 맞춘 입력의 기울기 크기(중앙 차분). */
export function gradientMagnitude(img: ArrayLike<number>, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const gx = img[y * w + Math.min(w - 1, x + 1)] - img[y * w + Math.max(0, x - 1)];
      const gy = img[Math.min(h - 1, y + 1) * w + x] - img[Math.max(0, y - 1) * w + x];
      out[y * w + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/**
 * 시간 특징 행렬(최근 T 프레임 × F 특징, 열마다 표준화)에서 마지막 행이
 * 앞 행들의 상위 r 성분 공간에서 얼마나 벗어났는지. 앞 행만으로 기준을 만든다(미래 없음).
 */
export function temporalOutlierResidual(rows: ReadonlyArray<ArrayLike<number>>, rank = 2): number {
  const T = rows.length;
  if (T < 4) return Number.NaN;
  const F = rows[0].length;
  const past = rows.slice(0, T - 1);
  const mean = new Float64Array(F);
  const std = new Float64Array(F);
  for (let f = 0; f < F; f += 1) {
    let s = 0;
    let n = 0;
    for (const r of past) if (Number.isFinite(r[f])) {
      s += r[f];
      n += 1;
    }
    mean[f] = n ? s / n : 0;
    let v = 0;
    for (const r of past) if (Number.isFinite(r[f])) v += (r[f] - mean[f]) ** 2;
    std[f] = n > 1 ? Math.sqrt(v / (n - 1)) || 1 : 1;
  }
  const z = (r: ArrayLike<number>) => Array.from({ length: F }, (_, f) => (Number.isFinite(r[f]) ? (r[f] - mean[f]) / std[f] : 0));
  const P = past.map(z);
  // Fᵀ F 공분산의 주성분을 거듭제곱법으로 r 개
  const cov = new Float64Array(F * F);
  for (const r of P) for (let i = 0; i < F; i += 1) for (let j = 0; j < F; j += 1) cov[i * F + j] += r[i] * r[j];
  const comps: number[][] = [];
  const work = Float64Array.from(cov);
  for (let c = 0; c < Math.min(rank, F); c += 1) {
    let v = Array.from({ length: F }, (_, i) => 1 / Math.sqrt(F) + i * 1e-3);
    let lambda = 0;
    for (let it = 0; it < 50; it += 1) {
      const nv = new Array(F).fill(0);
      for (let i = 0; i < F; i += 1) for (let j = 0; j < F; j += 1) nv[i] += work[i * F + j] * v[j];
      const nn = Math.hypot(...nv);
      if (nn < 1e-12) break;
      lambda = nn;
      v = nv.map((x) => x / nn);
    }
    if (lambda < 1e-9) break;
    comps.push(v);
    for (let i = 0; i < F; i += 1) for (let j = 0; j < F; j += 1) work[i * F + j] -= lambda * v[i] * v[j];
  }
  const last = z(rows[T - 1]);
  const proj = new Array(F).fill(0);
  for (const v of comps) {
    const d = v.reduce((s, x, i) => s + x * last[i], 0);
    for (let i = 0; i < F; i += 1) proj[i] += d * v[i];
  }
  let res = 0;
  for (let i = 0; i < F; i += 1) res += (last[i] - proj[i]) ** 2;
  return round6(Math.sqrt(res / F));
}
