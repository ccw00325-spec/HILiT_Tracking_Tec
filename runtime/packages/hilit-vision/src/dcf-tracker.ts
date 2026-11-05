/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·3acc1211 @license @preserve */
/* HILIT DCF Tracker — 가중치 없는 판별형 상관필터 위치 추적.
 *
 * 논문 알고리즘을 이 파일에서 직접 구현했다. 외부 코드·외부 가중치·학습
 * 데이터를 쓰지 않는다. OpenCV 코드를 옮기지 않았다(비교 실행만 했다).
 *
 *   - 커널 상관필터(KCF): Henriques, Caseiro, Martins, Batista,
 *     "High-Speed Tracking with Kernelized Correlation Filters", TPAMI 2015
 *     (arXiv 2014). 가우시안 커널, 순환 행렬의 푸리에 대각화, 선형 보간 갱신.
 *   - 여러 크기 탐색: Li & Zhu, "A Scale Adaptive Kernel Correlation Filter
 *     Tracker with Feature Integration"(SAMF), ECCV-W 2014 의 발상.
 *   - 가림 판정: Bolme et al., "Visual Object Tracking using Adaptive
 *     Correlation Filters"(MOSSE), CVPR 2010 의 PSR(peak-to-sidelobe ratio).
 *   - 특징: Dalal & Triggs 2005 의 기울기 방향 칸 누적(HOG) 을 단순화한 것 +
 *     칸 평균 밝기 + 반대색 두 채널. 학습된 색 사전(Color Names)은 쓰지
 *     않는다 — 그것은 외부 데이터로 학습된 표다.
 *
 *
 * confidence 는 상관 응답의 날카로움(PSR)을 0~1 로 옮긴 위치 관측 품질이다.
 * 동일인 확률이 아니다.
 */

export interface DcfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 캔버스 한 조각. ox/oy 는 전체 프레임 안에서 이 조각의 왼쪽 위다. */
export interface DcfRgbaFrame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  ox?: number;
  oy?: number;
  /** 전체 프레임 크기. 없으면 조각 크기를 쓴다. */
  frameWidth?: number;
  frameHeight?: number;
}

export type DcfStatus = 'tracked' | 'degraded' | 'lost';

export interface DcfTrackResult {
  box: DcfBox;
  /** 위치 관측 품질 0~1. 동일인 확률이 아니다. */
  confidence: number;
  status: DcfStatus;
  observed: boolean;
  psr: number;
  peak: number;
  scale: number;
  modelUpdated: boolean;
  reason: string | null;
  frameTimestamp: number | null;
  referenceTimestamp: number | null;
}

export interface DcfParams {
  /** 대상 둘레로 더 보는 배수. 창 = 대상 × (1 + padding). */
  padding: number;
  /** 특징 칸 한 변(화소, 표본화한 조각 기준). */
  cell: number;
  /** 특징 격자 칸 수의 기준(가로×세로 ≈ baseCells²). */
  baseCells: number;
  lambda: number;
  kernelSigma: number;
  outputSigmaFactor: number;
  /** 모델 보간 비율(프레임당). */
  interp: number;
  /** 크기 후보. 1 은 반드시 들어간다. */
  scales: number[];
  /** 크기가 1 이 아닐 때 응답에 곱하는 벌점. */
  scalePenalty: number;
  /** 이 PSR 이상이면 관측으로 쓴다. */
  psrTracked: number;
  /** 이 PSR 미만이면 놓침. 상자를 옮기지 않는다. */
  psrLost: number;
  /** 이 PSR 이상일 때만 모델을 갱신한다(배경 흡수 방지). */
  psrUpdate: number;
  /** 첫 크기 대비 허용 범위. */
  minScale: number;
  maxScale: number;
}

export const DCF_PARAMS: Readonly<DcfParams> = Object.freeze({
  padding: 1.5,
  cell: 4,
  baseCells: 32,
  lambda: 1e-4,
  kernelSigma: 0.5,
  outputSigmaFactor: 0.1,
  interp: 0.02,
  scales: [0.96, 0.98, 1, 1.02, 1.04],
  scalePenalty: 0.985,
  psrTracked: 10,
  psrLost: 3.5,
  psrUpdate: 7,
  minScale: 0.2,
  maxScale: 3,
});

export const DCF_HOG_BINS = 9;
/** HOG 9 + 밝기 1 + 반대색 2. */
export const DCF_CHANNELS = DCF_HOG_BINS + 3;

/* ------------------------------------------------------------------
 * FFT — 길이 2의 거듭제곱, 제자리 반복형 Cooley–Tukey.
 * ------------------------------------------------------------------ */

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  twiddleCache.set(n, t);
  return t;
}

export function isPow2(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

/** 1차원 FFT. stride 로 떨어진 원소에 제자리로 적용한다. inverse 는 1/n 을 곱한다. */
function fft1(re: Float64Array, im: Float64Array, offset: number, stride: number, n: number,
  inverse: boolean, bufRe: Float64Array, bufIm: Float64Array): void {
  const { cos, sin, rev } = twiddles(n);
  for (let i = 0; i < n; i += 1) {
    const j = rev[i];
    bufRe[j] = re[offset + i * stride];
    bufIm[j] = im[offset + i * stride];
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = bufRe[b] * wr - bufIm[b] * wi;
        const ti = bufRe[b] * wi + bufIm[b] * wr;
        bufRe[b] = bufRe[a] - tr;
        bufIm[b] = bufIm[a] - ti;
        bufRe[a] += tr;
        bufIm[a] += ti;
      }
    }
  }
  const scale = inverse ? 1 / n : 1;
  for (let i = 0; i < n; i += 1) {
    re[offset + i * stride] = bufRe[i] * scale;
    im[offset + i * stride] = bufIm[i] * scale;
  }
}

/** 2차원 FFT(행 우선, 가로 w · 세로 h). 제자리. */
export function fft2(re: Float64Array, im: Float64Array, w: number, h: number, inverse = false): void {
  if (!isPow2(w) || !isPow2(h)) throw new Error(`fft2: 2의 거듭제곱이 아닙니다 ${w}x${h}`);
  const n = Math.max(w, h);
  const bufRe = new Float64Array(n);
  const bufIm = new Float64Array(n);
  for (let y = 0; y < h; y += 1) fft1(re, im, y * w, 1, w, inverse, bufRe, bufIm);
  for (let x = 0; x < w; x += 1) fft1(re, im, x, w, h, inverse, bufRe, bufIm);
}

/* ------------------------------------------------------------------
 * 특징
 * ------------------------------------------------------------------ */

function nearestPow2(v: number, lo: number, hi: number): number {
  const p = 2 ** Math.round(Math.log2(Math.max(1, v)));
  return Math.min(hi, Math.max(lo, p));
}

/** 창 가로세로 비로 특징 격자를 정한다. 칸이 대략 정사각형이 되게. */
export function gridFor(windowW: number, windowH: number, baseCells = DCF_PARAMS.baseCells): { fw: number; fh: number } {
  const aspect = Math.max(1e-3, windowW) / Math.max(1e-3, windowH);
  const s = Math.sqrt(aspect);
  return {
    fw: nearestPow2(baseCells * s, 8, 64),
    fh: nearestPow2(baseCells / s, 8, 64),
  };
}

function hann(n: number): Float64Array {
  const out = new Float64Array(n);
  if (n === 1) { out[0] = 1; return out; }
  for (let i = 0; i < n; i += 1) out[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return out;
}

/**
 * 프레임에서 (cx, cy) 를 중심으로 winW×winH 창을 떼어 pw×ph 로 표본화한다.
 * 조각 밖은 가장자리 화소를 늘려 쓴다. 결과는 R,G,B 세 판.
 */
export function samplePatch(frame: DcfRgbaFrame, cx: number, cy: number, winW: number, winH: number,
  pw: number, ph: number): { r: Float32Array; g: Float32Array; b: Float32Array } {
  const r = new Float32Array(pw * ph);
  const g = new Float32Array(pw * ph);
  const b = new Float32Array(pw * ph);
  const ox = frame.ox ?? 0;
  const oy = frame.oy ?? 0;
  const W = frame.width;
  const H = frame.height;
  const d = frame.data;
  const sx = winW / pw;
  const sy = winH / ph;
  const x0 = cx - winW / 2 - ox;
  const y0 = cy - winH / 2 - oy;
  for (let y = 0; y < ph; y += 1) {
    let fy = y0 + (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0; else if (fy > H - 1) fy = H - 1;
    const iy = Math.min(H - 2, Math.floor(fy));
    const ty = H > 1 ? fy - iy : 0;
    const row0 = Math.max(0, iy) * W;
    const row1 = Math.min(H - 1, iy + 1) * W;
    for (let x = 0; x < pw; x += 1) {
      let fx = x0 + (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0; else if (fx > W - 1) fx = W - 1;
      const ix = Math.min(W - 2, Math.floor(fx));
      const tx = W > 1 ? fx - ix : 0;
      const ix0 = Math.max(0, ix);
      const ix1 = Math.min(W - 1, ix + 1);
      const p00 = (row0 + ix0) * 4;
      const p01 = (row0 + ix1) * 4;
      const p10 = (row1 + ix0) * 4;
      const p11 = (row1 + ix1) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty;
      const w11 = tx * ty;
      const o = y * pw + x;
      r[o] = w00 * d[p00] + w01 * d[p01] + w10 * d[p10] + w11 * d[p11];
      g[o] = w00 * d[p00 + 1] + w01 * d[p01 + 1] + w10 * d[p10 + 1] + w11 * d[p11 + 1];
      b[o] = w00 * d[p00 + 2] + w01 * d[p01 + 2] + w10 * d[p10 + 2] + w11 * d[p11 + 2];
    }
  }
  return { r, g, b };
}

/** 방향(0~π) 근사. 최대 오차 약 0.0015 rad — 9칸 방향 누적에는 충분하다. */
export function unsignedAngle(gx: number, gy: number): number {
  let x = gx;
  let y = gy;
  if (y < 0 || (y === 0 && x < 0)) { x = -x; y = -y; }
  const ax = Math.abs(x);
  if (ax < 1e-12 && y < 1e-12) return 0;
  /* atan(t), t ∈ [0,1] 의 다항 근사 후 사분면 보정. */
  const swap = y > ax;
  const t = swap ? ax / y : y / ax;
  const t2 = t * t;
  let a = t * (0.9998660 + t2 * (-0.3302995 + t2 * (0.1801410 + t2 * (-0.0851330 + t2 * 0.0208351))));
  if (swap) a = Math.PI / 2 - a;
  if (x < 0) a = Math.PI - a;
  return a >= Math.PI ? 0 : a;
}

/**
 * 조각 → 칸 특징(채널 우선, 각 fw×fh). 코사인 창을 곱해 돌려준다.
 * 채널: 방향 9 · 밝기 · 반대색(R−G) · 반대색(R+G−2B).
 */
export function extractFeatures(patch: { r: Float32Array; g: Float32Array; b: Float32Array },
  fw: number, fh: number, cell: number, winX: Float64Array, winY: Float64Array): Float64Array[] {
  const pw = fw * cell;
  const ph = fh * cell;
  const nCells = fw * fh;
  const hog = new Float64Array(nCells * DCF_HOG_BINS);
  const gray = new Float32Array(pw * ph);
  const lum = new Float64Array(nCells);
  const opp1 = new Float64Array(nCells);
  const opp2 = new Float64Array(nCells);
  for (let i = 0; i < pw * ph; i += 1) {
    gray[i] = 0.299 * patch.r[i] + 0.587 * patch.g[i] + 0.114 * patch.b[i];
  }
  const binScale = DCF_HOG_BINS / Math.PI;
  for (let y = 0; y < ph; y += 1) {
    const cy = Math.min(fh - 1, Math.floor(y / cell));
    const yU = y > 0 ? y - 1 : y;
    const yD = y < ph - 1 ? y + 1 : y;
    for (let x = 0; x < pw; x += 1) {
      const cx = Math.min(fw - 1, Math.floor(x / cell));
      const c = cy * fw + cx;
      const o = y * pw + x;
      const xL = x > 0 ? x - 1 : x;
      const xR = x < pw - 1 ? x + 1 : x;
      const gx = gray[y * pw + xR] - gray[y * pw + xL];
      const gy = gray[yD * pw + x] - gray[yU * pw + x];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > 1e-6) {
        const ang = unsignedAngle(gx, gy);
        const fb = ang * binScale - 0.5;
        let b0 = Math.floor(fb);
        const t = fb - b0;
        let b1 = b0 + 1;
        if (b0 < 0) b0 += DCF_HOG_BINS;
        if (b1 >= DCF_HOG_BINS) b1 -= DCF_HOG_BINS;
        hog[c * DCF_HOG_BINS + b0] += mag * (1 - t);
        hog[c * DCF_HOG_BINS + b1] += mag * t;
      }
      lum[c] += gray[o];
      opp1[c] += patch.r[o] - patch.g[o];
      opp2[c] += patch.r[o] + patch.g[o] - 2 * patch.b[o];
    }
  }
  /* 칸 에너지를 이웃 3×3 평균으로 나눈다(HOG 블록 정규화의 단순형). */
  const energy = new Float64Array(nCells);
  for (let c = 0; c < nCells; c += 1) {
    let e = 0;
    for (let k = 0; k < DCF_HOG_BINS; k += 1) e += hog[c * DCF_HOG_BINS + k] ** 2;
    energy[c] = e;
  }
  const out: Float64Array[] = [];
  for (let k = 0; k < DCF_CHANNELS; k += 1) out.push(new Float64Array(nCells));
  const px = cell * cell;
  for (let y = 0; y < fh; y += 1) {
    for (let x = 0; x < fw; x += 1) {
      const c = y * fw + x;
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= fh) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= fw) continue;
          s += energy[yy * fw + xx];
          n += 1;
        }
      }
      const norm = 1 / Math.sqrt(s / n + 1e-4);
      const wgt = winX[x] * winY[y];
      for (let k = 0; k < DCF_HOG_BINS; k += 1) {
        const v = Math.min(0.2, hog[c * DCF_HOG_BINS + k] * norm);
        out[k][c] = v * wgt;
      }
      out[DCF_HOG_BINS][c] = (lum[c] / px / 255 - 0.5) * wgt;
      out[DCF_HOG_BINS + 1][c] = (opp1[c] / px / 255) * wgt;
      out[DCF_HOG_BINS + 2][c] = (opp2[c] / px / 510) * wgt;
    }
  }
  return out;
}

/* ------------------------------------------------------------------
 * 커널 상관
 * ------------------------------------------------------------------ */

interface Spectrum {
  re: Float64Array[];
  im: Float64Array[];
  /** 공간 영역 제곱합(채널 합). */
  energy: number;
}

function toSpectrum(feats: Float64Array[], fw: number, fh: number): Spectrum {
  const re: Float64Array[] = [];
  const im: Float64Array[] = [];
  let energy = 0;
  for (const f of feats) {
    const r = Float64Array.from(f);
    const i = new Float64Array(f.length);
    for (let k = 0; k < f.length; k += 1) energy += f[k] * f[k];
    fft2(r, i, fw, fh, false);
    re.push(r);
    im.push(i);
  }
  return { re, im, energy };
}

/**
 * 가우시안 커널 상관 k^{xz} 의 스펙트럼(KCF 식 31).
 * cross = F⁻¹( Σ_c X̂_c ⊙ conj(Ẑ_c) ) 을 거쳐 exp 를 취한다.
 */
function gaussianCorrelation(x: Spectrum, z: Spectrum, fw: number, fh: number, sigma: number,
  channels: number): { re: Float64Array; im: Float64Array } {
  const n = fw * fh;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let c = 0; c < x.re.length; c += 1) {
    const xr = x.re[c], xi = x.im[c], zr = z.re[c], zi = z.im[c];
    for (let k = 0; k < n; k += 1) {
      re[k] += xr[k] * zr[k] + xi[k] * zi[k];
      im[k] += xi[k] * zr[k] - xr[k] * zi[k];
    }
  }
  fft2(re, im, fw, fh, true);
  const denom = n * channels;
  const inv = 1 / (sigma * sigma);
  for (let k = 0; k < n; k += 1) {
    const d = Math.max(0, (x.energy + z.energy - 2 * re[k]) / denom);
    re[k] = Math.exp(-inv * d);
    im[k] = 0;
  }
  fft2(re, im, fw, fh, false);
  return { re, im };
}

/** 원점에 봉우리가 있는 가우시안 목표(순환 이동). */
function gaussianLabelSpectrum(fw: number, fh: number, sigma: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(fw * fh);
  const im = new Float64Array(fw * fh);
  const s2 = 2 * sigma * sigma;
  for (let y = 0; y < fh; y += 1) {
    const dy = y <= fh / 2 ? y : y - fh;
    for (let x = 0; x < fw; x += 1) {
      const dx = x <= fw / 2 ? x : x - fw;
      re[y * fw + x] = Math.exp(-(dx * dx + dy * dy) / s2);
    }
  }
  fft2(re, im, fw, fh, false);
  return { re, im };
}

/** 응답 지도에서 봉우리·부분화소 위치·PSR. */
export function analyzeResponse(resp: Float64Array, fw: number, fh: number): { peak: number; dx: number; dy: number; psr: number } {
  let best = -Infinity;
  let bi = 0;
  for (let k = 0; k < resp.length; k += 1) if (resp[k] > best) { best = resp[k]; bi = k; }
  const px = bi % fw;
  const py = Math.floor(bi / fw);
  const at = (x: number, y: number) => resp[((y + fh) % fh) * fw + ((x + fw) % fw)];
  const sub = (l: number, c: number, r: number) => {
    const den = l - 2 * c + r;
    if (!(Math.abs(den) > 1e-12)) return 0;
    return Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den));
  };
  let dx = px + sub(at(px - 1, py), best, at(px + 1, py));
  let dy = py + sub(at(px, py - 1), best, at(px, py + 1));
  if (dx > fw / 2) dx -= fw;
  if (dy > fh / 2) dy -= fh;
  /* 봉우리 둘레(격자의 약 1/8)를 빼고 나머지로 PSR. */
  const rx = Math.max(2, Math.round(fw / 8));
  const ry = Math.max(2, Math.round(fh / 8));
  let sum = 0, sq = 0, n = 0;
  for (let y = 0; y < fh; y += 1) {
    let ddy = Math.abs(y - py);
    ddy = Math.min(ddy, fh - ddy);
    for (let x = 0; x < fw; x += 1) {
      let ddx = Math.abs(x - px);
      ddx = Math.min(ddx, fw - ddx);
      if (ddx <= rx && ddy <= ry) continue;
      const v = resp[y * fw + x];
      sum += v; sq += v * v; n += 1;
    }
  }
  const mean = n ? sum / n : 0;
  const sd = n ? Math.sqrt(Math.max(1e-12, sq / n - mean * mean)) : 1;
  return { peak: best, dx, dy, psr: (best - mean) / sd };
}

/** PSR → 0~1 관측 품질. psrLost 에서 0.12, psrTracked 에서 0.5, 그 위로 포화. */
export function psrToConfidence(psr: number, p: Pick<DcfParams, 'psrLost' | 'psrTracked'> = DCF_PARAMS): number {
  if (!Number.isFinite(psr)) return 0;
  if (psr <= p.psrLost) return Math.max(0, Math.min(0.12, 0.12 * psr / Math.max(1e-6, p.psrLost)));
  if (psr <= p.psrTracked) return 0.12 + 0.38 * (psr - p.psrLost) / Math.max(1e-6, p.psrTracked - p.psrLost);
  return Math.min(1, 0.5 + 0.5 * (1 - Math.exp(-(psr - p.psrTracked) / 5)));
}

/* ------------------------------------------------------------------
 * 추적기
 * ------------------------------------------------------------------ */

export class HilitDcfTrackerCore {
  readonly params: DcfParams;
  private cx = 0;
  private cy = 0;
  private tw = 0;
  private th = 0;
  /** 첫 상자(크기 범위 기준). */
  w0 = 0;
  h0 = 0;
  /** 창 기준 크기(첫 창). 크기 변화는 scale 로만 표현한다. */
  private baseWinW = 0;
  private baseWinH = 0;
  private scale = 1;
  private fw = 0;
  private fh = 0;
  private winX: Float64Array = new Float64Array(0);
  private winY: Float64Array = new Float64Array(0);
  private yf: { re: Float64Array; im: Float64Array } | null = null;
  private modelX: Spectrum | null = null;
  private alphaRe: Float64Array | null = null;
  private alphaIm: Float64Array | null = null;
  private refTime: number | null = null;
  private lastSig = NaN;
  private blankInit = false;
  private updatesSinceInit = 0;
  private lastPatchStd = 0;

  constructor(params: Partial<DcfParams> = {}) {
    this.params = { ...DCF_PARAMS, ...params, scales: [...(params.scales ?? DCF_PARAMS.scales)] };
    if (!this.params.scales.includes(1)) this.params.scales.push(1);
  }

  get initialized(): boolean {
    return this.modelX !== null;
  }

  current(): DcfBox | null {
    if (!this.initialized) return null;
    return { x: this.cx - this.tw / 2, y: this.cy - this.th / 2, width: this.tw, height: this.th };
  }

  /** 다음 update 에 필요한 프레임 영역(가장 큰 크기 후보 창 + 여유). */
  searchRegion(frameW: number, frameH: number, box: DcfBox | null = this.current()): { x: number; y: number; width: number; height: number } {
    if (!box) return { x: 0, y: 0, width: frameW, height: frameH };
    const maxS = Math.max(...this.params.scales) * 1.05;
    const ww = box.width * (1 + this.params.padding) * maxS;
    const wh = box.height * (1 + this.params.padding) * maxS;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const x0 = Math.max(0, Math.floor(cx - ww / 2) - 2);
    const y0 = Math.max(0, Math.floor(cy - wh / 2) - 2);
    const x1 = Math.min(frameW, Math.ceil(cx + ww / 2) + 2);
    const y1 = Math.min(frameH, Math.ceil(cy + wh / 2) + 2);
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      /* 창이 통째로 화면 밖이면 가장 가까운 가장자리 조각을 준다. */
      const ex = Math.min(Math.max(0, x0), Math.max(0, frameW - 2));
      const ey = Math.min(Math.max(0, y0), Math.max(0, frameH - 2));
      return { x: ex, y: ey, width: Math.min(2, frameW), height: Math.min(2, frameH) };
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  private features(frame: DcfRgbaFrame, cx: number, cy: number, s: number): Float64Array[] {
    const c = this.params.cell;
    const patch = samplePatch(frame, cx, cy, this.baseWinW * s, this.baseWinH * s, this.fw * c, this.fh * c);
    this.lastPatchStd = patchStd(patch);
    return extractFeatures(patch, this.fw, this.fh, c, this.winX, this.winY);
  }

  private train(feats: Float64Array[], rate: number): void {
    const xf = toSpectrum(feats, this.fw, this.fh);
    const kf = gaussianCorrelation(xf, xf, this.fw, this.fh, this.params.kernelSigma, DCF_CHANNELS);
    const yf = this.yf!;
    const n = this.fw * this.fh;
    const aRe = new Float64Array(n);
    const aIm = new Float64Array(n);
    const lam = this.params.lambda;
    for (let k = 0; k < n; k += 1) {
      const dr = kf.re[k] + lam;
      const di = kf.im[k];
      const den = dr * dr + di * di;
      aRe[k] = (yf.re[k] * dr + yf.im[k] * di) / den;
      aIm[k] = (yf.im[k] * dr - yf.re[k] * di) / den;
    }
    if (!this.modelX || rate >= 1) {
      this.modelX = xf;
      this.alphaRe = aRe;
      this.alphaIm = aIm;
      return;
    }
    const m = this.modelX;
    for (let c = 0; c < m.re.length; c += 1) {
      const mr = m.re[c], mi = m.im[c], xr = xf.re[c], xi = xf.im[c];
      for (let k = 0; k < n; k += 1) {
        mr[k] += rate * (xr[k] - mr[k]);
        mi[k] += rate * (xi[k] - mi[k]);
      }
    }
    m.energy += rate * (xf.energy - m.energy);
    const ar = this.alphaRe!, ai = this.alphaIm!;
    for (let k = 0; k < n; k += 1) {
      ar[k] += rate * (aRe[k] - ar[k]);
      ai[k] += rate * (aIm[k] - ai[k]);
    }
  }

  init(frame: DcfRgbaFrame, box: DcfBox, timeSec: number | null = null): void {
    const w = Math.max(4, box.width);
    const h = Math.max(4, box.height);
    this.cx = box.x + box.width / 2;
    this.cy = box.y + box.height / 2;
    this.tw = w;
    this.th = h;
    this.w0 = w;
    this.h0 = h;
    this.scale = 1;
    this.baseWinW = w * (1 + this.params.padding);
    this.baseWinH = h * (1 + this.params.padding);
    const g = gridFor(this.baseWinW, this.baseWinH, this.params.baseCells);
    this.fw = g.fw;
    this.fh = g.fh;
    this.winX = hann(this.fw);
    this.winY = hann(this.fh);
    const sigma = Math.sqrt((this.fw / (1 + this.params.padding)) * (this.fh / (1 + this.params.padding)))
      * this.params.outputSigmaFactor;
    this.yf = gaussianLabelSpectrum(this.fw, this.fh, sigma);
    this.modelX = null;
    this.train(this.features(frame, this.cx, this.cy, 1), 1);
    /* 탐색 직후 한 장이 아직 안 그려진 빈 화면일 수 있다(0초 시작 클립에서 실측).
     * 빈 화면으로 배운 모델은 영원히 응답이 없으므로, 다음 프레임에서 다시 배운다. */
    this.blankInit = this.lastPatchStd < BLANK_PATCH_STD;
    this.updatesSinceInit = 0;
    this.refTime = timeSec;
    this.lastSig = regionSignature(frame);
  }

  reset(): void {
    this.modelX = null;
    this.alphaRe = null;
    this.alphaIm = null;
    this.yf = null;
    this.w0 = 0;
    this.h0 = 0;
    this.refTime = null;
    this.lastSig = NaN;
  }

  private respond(frame: DcfRgbaFrame, s: number): { resp: Float64Array; z: Spectrum } {
    const feats = this.features(frame, this.cx, this.cy, s);
    const z = toSpectrum(feats, this.fw, this.fh);
    const kz = gaussianCorrelation(z, this.modelX!, this.fw, this.fh, this.params.kernelSigma, DCF_CHANNELS);
    const n = this.fw * this.fh;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const ar = this.alphaRe!, ai = this.alphaIm!;
    for (let k = 0; k < n; k += 1) {
      re[k] = ar[k] * kz.re[k] - ai[k] * kz.im[k];
      im[k] = ar[k] * kz.im[k] + ai[k] * kz.re[k];
    }
    fft2(re, im, this.fw, this.fh, true);
    return { resp: re, z };
  }

  update(frame: DcfRgbaFrame, timeSec: number | null = null, options?: { learn?: boolean }): DcfTrackResult {
    const base = (reason: string | null, extra: Partial<DcfTrackResult>): DcfTrackResult => ({
      box: this.current() ?? { x: 0, y: 0, width: 1, height: 1 },
      confidence: 0,
      status: 'lost',
      observed: false,
      psr: 0,
      peak: 0,
      scale: this.scale,
      modelUpdated: false,
      reason,
      frameTimestamp: timeSec,
      referenceTimestamp: this.refTime,
      ...extra,
    });
    if (!this.initialized) return base('not_initialized', {});
    if (this.blankInit) {
      const box = this.current()!;
      this.init(frame, box, timeSec);
      return base(this.blankInit ? 'reference_blank' : 'reference_adopted', {
        box, confidence: 0.35, status: 'degraded', observed: false,
      });
    }
    const sig = regionSignature(frame);
    const duplicate = sig === this.lastSig;
    let best: { s: number; score: number; peak: number; dx: number; dy: number; psr: number } | null = null;
    for (const f of this.params.scales) {
      const s = this.scale * f;
      if (s < this.params.minScale || s > this.params.maxScale) continue;
      const { resp } = this.respond(frame, s);
      const a = analyzeResponse(resp, this.fw, this.fh);
      const score = a.peak * (f === 1 ? 1 : this.params.scalePenalty);
      if (!best || score > best.score) best = { s, score, peak: a.peak, dx: a.dx, dy: a.dy, psr: a.psr };
    }
    if (!best) return base('scale_out_of_range', {});
    const confidence = psrToConfidence(best.psr, this.params);
    this.refTime = timeSec;
    this.lastSig = sig;
    this.updatesSinceInit += 1;
    if (best.psr < this.params.psrLost && this.updatesSinceInit <= EARLY_REINIT_UPDATES) {
      /* 사용자가 막 고른 상자인데 첫 몇 장에서 응답이 없다 — 첫 장이 이전
       * 프레임이었거나 덜 그려졌던 경우다. 상자는 사용자 것이므로 믿고
       * 이 프레임으로 다시 배운다. 점 추적기의 참조 다시 붙이기와 같은 자리다. */
      const box = this.current()!;
      const n = this.updatesSinceInit;
      this.init(frame, box, timeSec);
      this.updatesSinceInit = n;
      return base('reference_adopted', { box, confidence: 0.35, status: 'degraded', psr: best.psr, peak: best.peak });
    }
    if (best.psr < this.params.psrLost) {
      /* 놓침. 상자·모델을 그대로 둔다 — 배경을 배우지 않는다. */
      return base('weak_response', { confidence, psr: best.psr, peak: best.peak });
    }
    const cellW = (this.baseWinW * best.s) / this.fw;
    const cellH = (this.baseWinH * best.s) / this.fh;
    this.cx += best.dx * cellW;
    this.cy += best.dy * cellH;
    this.scale = best.s;
    this.tw = this.w0 * this.scale;
    this.th = this.h0 * this.scale;
    const fw = frame.frameWidth ?? ((frame.ox ?? 0) + frame.width);
    const fh = frame.frameHeight ?? ((frame.oy ?? 0) + frame.height);
    this.cx = Math.min(Math.max(this.cx, -this.tw * 0.05), fw + this.tw * 0.05);
    this.cy = Math.min(Math.max(this.cy, -this.th * 0.05), fh + this.th * 0.05);
    const tracked = best.psr >= this.params.psrTracked;
    let modelUpdated = false;
    if (options?.learn !== false && best.psr >= this.params.psrUpdate && !duplicate) {
      this.train(this.features(frame, this.cx, this.cy, this.scale), this.params.interp);
      modelUpdated = true;
    }
    return {
      box: this.current()!,
      confidence,
      status: tracked ? 'tracked' : 'degraded',
      observed: tracked,
      psr: best.psr,
      peak: best.peak,
      scale: this.scale,
      modelUpdated,
      reason: duplicate ? 'duplicate_frame' : (tracked ? null : 'weak_observation'),
      frameTimestamp: timeSec,
      referenceTimestamp: this.refTime,
    };
  }

  /** 바깥(필터·가림 예측)이 정한 자리로 옮긴다. 모델은 그대로다. */
  reposition(box: DcfBox, { trustSize = false } = {}): void {
    if (!this.initialized) return;
    this.cx = box.x + box.width / 2;
    this.cy = box.y + box.height / 2;
    if (trustSize && this.w0 > 0 && this.h0 > 0) {
      const s = Math.sqrt((box.width / this.w0) * (box.height / this.h0));
      if (Number.isFinite(s) && s > 0) {
        this.scale = Math.min(this.params.maxScale, Math.max(this.params.minScale, s));
      }
    }
    this.tw = this.w0 * this.scale;
    this.th = this.h0 * this.scale;
  }

  /** 확인된 자리에서 모델을 한 번 더 세게 배운다. */
  refresh(frame: DcfRgbaFrame, box: DcfBox, timeSec: number | null = null, rate = 0.1): void {
    if (!this.initialized) return;
    this.reposition(box, { trustSize: true });
    this.train(this.features(frame, this.cx, this.cy, this.scale), rate);
    this.refTime = timeSec;
    this.lastSig = regionSignature(frame);
  }
}

/** 초기화 뒤 이 횟수 안에 응답이 없으면 그 프레임으로 다시 배운다. */
export const EARLY_REINIT_UPDATES = 2;
/** 이보다 밝기 표준편차가 작은 조각은 아직 안 그려진 화면으로 본다. */
export const BLANK_PATCH_STD = 1.5;

function patchStd(p: { r: Float32Array; g: Float32Array; b: Float32Array }): number {
  const n = p.r.length;
  if (!n) return 0;
  let s = 0, sq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = 0.299 * p.r[i] + 0.587 * p.g[i] + 0.114 * p.b[i];
    s += v; sq += v * v;
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

/** 같은 프레임이 두 번 들어왔는지 보는 싼 서명. */
function regionSignature(frame: DcfRgbaFrame): number {
  let s = frame.width * 1e6 + frame.height + (frame.ox ?? 0) * 7 + (frame.oy ?? 0) * 13;
  const stepX = Math.max(1, Math.floor(frame.width / 32));
  const stepY = Math.max(1, Math.floor(frame.height / 32));
  for (let y = 0; y < frame.height; y += stepY) {
    for (let x = 0; x < frame.width; x += stepX) {
      const p = (y * frame.width + x) * 4;
      s += frame.data[p] * (x + 1) + frame.data[p + 1] * 0.37 + (y + 1) * 0.013;
    }
  }
  return s;
}
