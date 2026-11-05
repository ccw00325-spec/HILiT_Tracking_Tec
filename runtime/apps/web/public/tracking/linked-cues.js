/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·0f799860 @license @preserve */
/* 검출 연결 추적(linked-v1)의 겉모습 단서 — 색만이 아니라 밝기·윤곽까지, 장면마다 무게를 다시 고른다(2026-10-27).
 *
 * 2026-10-27 사용자 지시(제안 1·2번 승인):
 *   「사람의 특징과 뒷 배경이 비슷한 경우, 해당 특징 외 다른 특징으로 사람을 쫓아가는 방식」
 *
 * hilit-appearance.js 의 서술자(세 띠 HSV 색조)는 그대로 두고 — 줄 만들기(buildTracklets)와 다른 모듈이 그 값에 맞춰져
 * 있다 — 대상 잇기(linkTarget)에서만 이 단서로 점수를 고친다.
 *
 *   1. 띠(머리 25% · 상의 45% · 하의 30%)마다 세 갈래 단서를 센다.
 *        색조   hilit-appearance.js 와 같은 색조 12칸 + 무채색 밝기 4칸
 *        밝기   채도와 상관없는 밝기 4칸(검은 상의·흰 하의 같은 명암 짜임)
 *        윤곽   기울기 방향 4칸(세로 주름·가로 줄무늬·사선) + 평평한 화소 1칸
 *   2. 사람 모양 마스크(person-mask, 0~1)가 있으면 사람 화소만 센다(제안 1번). 상자 안에 들어온 배경·LED 화면 색이
 *      빠진다. 마스크가 없으면 가운데 종 모양 가중(hilit-appearance.js 와 같음)으로 센다.
 *   3. 사용자가 고른 직후 대상과 「대상 둘레 배경」·「같은 화면의 다른 사람」을 단서마다 비교해, 대상끼리는 닮고
 *      배경·남과는 다른 단서에 무게를 더 준다(제안 2번). 옷 색이 배경과 같으면 색조 무게가 내려가고 밝기·윤곽이 오른다.
 *      생각은 Collins·Liu·Leordeanu, "Online Selection of Discriminative Tracking Features"(TPAMI 2005)의 것을 빌렸고
 *      코드는 여기서 직접 썼다. 학습된 가중치·외부 데이터는 없다.
 *
 * 🔴 점수는 같은 영상 안에서 사용자가 고른 사람이 맞는지 가르는 보조 근거다. 신원 확률이 아니다. 단서는 영상 한 편
 *    분석 중 메모리에만 있고 저장·전송하지 않는다. 체형 비율 같은 생체 특징은 쓰지 않는다.
 */

export const CUE_BANDS = [0.25, 0.45, 0.30];
const HUE_BINS = 12;
const GRAY_BINS = 4;
const GRAY_SAT = 0.18;
const LUM_BINS = 4;
/** 윤곽: 기울기 방향 4칸 + 평평한 화소 1칸(무늬 없는 옷과 줄무늬를 가른다). */
const TEX_BINS = 5;
const TEX_DIRS = 4;
const HUE_LEN = HUE_BINS + GRAY_BINS;
const BAND_LEN = HUE_LEN + LUM_BINS + TEX_BINS;
export const CUE_SIZE = CUE_BANDS.length * BAND_LEN;
/** 단서 무리 수 — 띠 셋 × (색조·밝기·윤곽). 순서: 색조0..2, 밝기0..2, 윤곽0..2. */
export const CUE_GROUPS = CUE_BANDS.length * 3;

/** 기본 무게. 색조는 hilit-appearance.js 의 띠 무게(0.8·2.0·1.0)와 같은 비율이다. 밝기·윤곽은 처음엔 작게 둔다. */
export const CUE_BASE = Object.freeze([0.8, 2.0, 1.0, 0.3, 0.6, 0.3, 0.3, 0.6, 0.3]);

export const CUE_POLICY = Object.freeze({
  /** 무게를 고를 때 대상과 배경·남의 차이를 얼마나 세게 반영하나. */
  gain: 3,
  /** 기본 무게 대비 한 무리가 가질 수 있는 배수 범위 — 한 단서가 판정을 혼자 쥐지 않게. */
  minFactor: 0.35,
  maxFactor: 2.5,
  /** 대상 표본이 하나뿐이면(같은 사람 사이 닮음을 잴 수 없으면) 이 값을 쓴다. */
  selfPrior: 0.75,
  /** 단서로 셀 화소 무게 합의 하한(48×96 기준). */
  minSamples: 60,
});

function toHsv(r, g, b) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
    else if (max === gg) h = ((bb - rr) / d + 2) / 6;
    else h = ((rr - gg) / d + 4) / 6;
  }
  return [h, max > 1e-6 ? d / max : 0, max];
}

/**
 * rgba(ImageData.data 모양) w×h 조각의 단서. 돌려주는 것 { v: Float32Array(CUE_SIZE), n, fg }.
 *
 * @param mask     w×h 의 0~1 사람 화소 확률(없으면 null). 주면 사람 화소만 센다.
 * @param uniform  true 면 가운데 가중 없이 고르게 센다(배경 띠를 셀 때).
 */
export function describeCues(data, w, h, mask = null, uniform = false) {
  const v = new Float32Array(CUE_SIZE);
  if (w < 4 || h < 8) return { v, n: 0, fg: false };
  const useMask = mask && mask.length === w * h;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const p = i * 4;
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  /* 마스크가 없을 때만 좌우 12% 를 자르고 가운데에 무게를 준다(hilit-appearance.js describeRgba 와 같은 모양). */
  const x0 = useMask || uniform ? 0 : Math.floor(w * 0.12);
  const x1 = useMask || uniform ? w : Math.ceil(w * 0.88);
  const cxm = (x0 + x1) / 2, halfW = Math.max(1, (x1 - x0) / 2), cym = h / 2, halfH = Math.max(1, h / 2);
  let n = 0, y0 = 0;
  for (let band = 0; band < CUE_BANDS.length; band += 1) {
    const y1 = band === CUE_BANDS.length - 1 ? h : Math.min(h, y0 + Math.round(h * CUE_BANDS[band]));
    const base = band * BAND_LEN;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = y * w + x, p = i * 4;
        if (data[p + 3] < 8) continue;
        let k;
        if (useMask) k = mask[i];
        else if (uniform) k = 1;
        else {
          const dx = (x - cxm) / halfW, dy = (y - cym) / halfH;
          const r2 = dx * dx + dy * dy * 0.35;
          k = r2 >= 1 ? 0 : 1 - r2;
        }
        if (!(k > 0.02)) continue;
        const [hue, sat, val] = toHsv(data[p], data[p + 1], data[p + 2]);
        if (sat < GRAY_SAT) v[base + HUE_BINS + Math.min(GRAY_BINS - 1, Math.floor(val * GRAY_BINS))] += k;
        else v[base + Math.min(HUE_BINS - 1, Math.floor(hue * HUE_BINS))] += sat * k;
        v[base + HUE_LEN + Math.min(LUM_BINS - 1, Math.floor(val * LUM_BINS))] += k;
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
          const gx = gray[i + 1] - gray[i - 1];
          const gy = gray[i + w] - gray[i - w];
          const mag = Math.hypot(gx, gy);
          let bin = TEX_DIRS;
          if (mag > 12) {
            let ang = Math.atan2(gy, gx);
            if (ang < 0) ang += Math.PI;
            bin = Math.floor((ang / Math.PI) * TEX_DIRS + 0.5) % TEX_DIRS;
          }
          v[base + HUE_LEN + LUM_BINS + bin] += k;
        }
        n += k;
      }
    }
    y0 = y1;
  }
  /* 무리마다 따로 합 1 로 맞춘다. */
  for (let band = 0; band < CUE_BANDS.length; band += 1) {
    const base = band * BAND_LEN;
    for (const [off, len] of [[0, HUE_LEN], [HUE_LEN, LUM_BINS], [HUE_LEN + LUM_BINS, TEX_BINS]]) {
      let s = 0;
      for (let k = 0; k < len; k += 1) s += v[base + off + k];
      if (s > 0) for (let k = 0; k < len; k += 1) v[base + off + k] /= s;
    }
  }
  return { v, n: Math.round(n), fg: !!useMask };
}

/** 무리 하나의 히스토그램 교집합. 한쪽이 비었으면 null. */
function groupSim(a, b, off, len) {
  let sa = 0, sb = 0, inter = 0;
  for (let k = 0; k < len; k += 1) { sa += a[off + k]; sb += b[off + k]; inter += Math.min(a[off + k], b[off + k]); }
  return sa > 0.5 && sb > 0.5 ? inter : null;
}

/** 무리별 닮음(CUE_GROUPS 개, 0~1, 잴 수 없으면 null). */
export function cueSims(a, b) {
  const out = new Array(CUE_GROUPS).fill(null);
  if (!a || !b || !a.v || !b.v) return out;
  for (let band = 0; band < CUE_BANDS.length; band += 1) {
    const base = band * BAND_LEN;
    out[band] = groupSim(a.v, b.v, base, HUE_LEN);
    out[CUE_BANDS.length + band] = groupSim(a.v, b.v, base + HUE_LEN, LUM_BINS);
    out[2 * CUE_BANDS.length + band] = groupSim(a.v, b.v, base + HUE_LEN + LUM_BINS, TEX_BINS);
  }
  return out;
}

/** 무게 w 로 합친 닮음(0~1). 잴 수 있는 무리가 없으면 null. */
export function weightedCueSim(a, b, w) {
  const s = cueSims(a, b);
  let t = 0, ws = 0;
  for (let g = 0; g < CUE_GROUPS; g += 1) {
    if (s[g] === null) continue;
    t += w[g] * s[g]; ws += w[g];
  }
  return ws > 0 ? t / ws : null;
}

export function normalizeWeights(w) {
  const s = w.reduce((a, b) => a + b, 0);
  return s > 0 ? w.map((x) => x / s) : w.slice();
}

export const CUE_DEFAULT = Object.freeze(normalizeWeights([...CUE_BASE]));

function meanOf(list) {
  const ok = list.filter((x) => x !== null && Number.isFinite(x));
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

/**
 * 장면에 맞는 무게 고르기.
 *   self    대상 단서들(사용자가 고른 모습 + 고른 직후 혼자 보인 모습)
 *   ring    대상 둘레 배경 단서들
 *   others  같은 화면의 다른 사람 단서들
 * 돌려주는 것 { w, disc, adapted } — adapted=false 면 비교할 배경·남이 없어 기본 무게 그대로다.
 */
export function chooseCueWeights({ self = [], ring = [], others = [] }, policy = CUE_POLICY) {
  const me = self.filter((c) => c && c.n >= policy.minSamples);
  if (!me.length) return { w: CUE_DEFAULT.slice(), disc: null, adapted: false };
  const rg = ring.filter((c) => c && c.n >= policy.minSamples);
  const ot = others.filter((c) => c && c.n >= policy.minSamples).slice(0, 40);
  if (!rg.length && !ot.length) return { w: CUE_DEFAULT.slice(), disc: null, adapted: false };
  const groupMean = (pairs) => {
    const acc = Array.from({ length: CUE_GROUPS }, () => []);
    for (const [a, b] of pairs) cueSims(a, b).forEach((s, g) => { if (s !== null) acc[g].push(s); });
    return acc.map(meanOf);
  };
  const selfPairs = [];
  for (let i = 0; i < me.length; i += 1) for (let j = i + 1; j < me.length; j += 1) selfPairs.push([me[i], me[j]]);
  const selfSim = selfPairs.length ? groupMean(selfPairs) : new Array(CUE_GROUPS).fill(policy.selfPrior);
  const bgSim = rg.length ? groupMean(me.flatMap((a) => rg.map((b) => [a, b]))) : new Array(CUE_GROUPS).fill(null);
  const otSim = ot.length ? groupMean(me.slice(0, 4).flatMap((a) => ot.map((b) => [a, b]))) : new Array(CUE_GROUPS).fill(null);
  const disc = new Array(CUE_GROUPS).fill(null);
  for (let g = 0; g < CUE_GROUPS; g += 1) {
    const d = [bgSim[g], otSim[g]].filter((x) => x !== null);
    const s = selfSim[g] ?? policy.selfPrior;
    disc[g] = d.length ? s - Math.max(...d) : null;
  }
  let dm = 0, dw = 0;
  for (let g = 0; g < CUE_GROUPS; g += 1) if (disc[g] !== null) { dm += CUE_BASE[g] * disc[g]; dw += CUE_BASE[g]; }
  if (dw <= 0) return { w: CUE_DEFAULT.slice(), disc, adapted: false };
  dm /= dw;
  const raw = CUE_BASE.map((b, g) => {
    if (disc[g] === null) return b;
    const f = Math.max(policy.minFactor, Math.min(policy.maxFactor, 1 + policy.gain * (disc[g] - dm)));
    return b * f;
  });
  return { w: normalizeWeights(raw), disc: disc.map((x) => (x === null ? null : +x.toFixed(3))), adapted: true };
}

/**
 * 잇기에서 쓰는 고친 닮음. base 는 hilit-appearance.js 의 닮음(줄 만들기와 같은 눈금)이다.
 * 그 눈금을 지키려고 값을 갈아 끼우지 않고, 「기본 무게로 본 단서 닮음」과 「고른 무게·사람 화소로 본 단서 닮음」의
 * 차이만큼만 옮긴다. 장면이 평범하면(무게가 기본과 같고 마스크가 없으면) 차이가 0 이라 예전 점수 그대로다.
 *
 * ctx = { w, gain, useFg }
 */
export function adjustSimilarity(base, a, b, ctx) {
  if (base === null || !ctx || !a?.cues || !b?.cues) return base;
  const ref = weightedCueSim(a.cues, b.cues, CUE_DEFAULT);
  if (ref === null) return base;
  const fgPair = ctx.useFg && a.cuesFg && b.cuesFg;
  const now = fgPair ? weightedCueSim(a.cuesFg, b.cuesFg, ctx.w) : weightedCueSim(a.cues, b.cues, ctx.w);
  if (now === null) return base;
  return Math.max(0, Math.min(1, base + (ctx.gain ?? 1) * (now - ref)));
}
