/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e9fa139c @license @preserve */
/* 브라우저 런타임 사본. 정본은 packages/hilit-vision/src/hilit-person-detector.ts
 * 와 hilit-grid-net.ts, hilit-stand-energy.ts 다. 한쪽을 고치면 다른 쪽도 고친다.
 *
 * NanoDet 클래스·ONNX 세션을 만들지 않는다. 검출 점수는 동일인 확률이 아니다.
 * 조각 확대는 옵션이다. 기본 후보는 전체 프레임 64×96 만 본다.
 */
import { planSlices, isClipped } from './hilit-tiling.js';
import { DETECTOR_SCORE_MIN } from './generated/detector-thresholds.js';
export const GRID_IN_W = 64;
export const GRID_IN_H = 96;
export const MODEL_ID = 'hilit-grid-synth-v0';
export const MODEL_VERSION = '0.1.0';
export const STAND_MODEL_ID = 'hilit-stand-energy-v0';

const C1 = 8, C2 = 16, C3 = 16, HEAD = 5, GW = 8, GH = 12;

function conv2d(input, inC, inH, inW, w, b, outC, stride) {
  const pad = 1, k = 3;
  const outH = Math.floor((inH + 2 * pad - k) / stride) + 1;
  const outW = Math.floor((inW + 2 * pad - k) / stride) + 1;
  const out = new Float32Array(outC * outH * outW);
  for (let oc = 0; oc < outC; oc++) {
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        let s = b[oc];
        const iy0 = y * stride - pad, ix0 = x * stride - pad;
        for (let ic = 0; ic < inC; ic++) {
          const wBase = (oc * inC + ic) * 3;
          const inBase = ic * inH * inW;
          for (let ky = 0; ky < 3; ky++) {
            const iy = iy0 + ky;
            if (iy < 0 || iy >= inH) continue;
            const row = inBase + iy * inW;
            const wk = (wBase + ky) * 3;
            for (let kx = 0; kx < 3; kx++) {
              const ix = ix0 + kx;
              if (ix < 0 || ix >= inW) continue;
              s += w[wk + kx] * input[row + ix];
            }
          }
        }
        out[(oc * outH + y) * outW + x] = s;
      }
    }
  }
  return { data: out, h: outH, w: outW };
}

function relu(x) {
  const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = x[i] > 0 ? x[i] : 0;
  return o;
}

function conv1x1(input, inC, h, w, wt, b, outC) {
  const hw = h * w;
  const out = new Float32Array(outC * hw);
  for (let oc = 0; oc < outC; oc++) {
    for (let i = 0; i < hw; i++) {
      let s = b[oc];
      for (let ic = 0; ic < inC; ic++) s += wt[oc * inC + ic] * input[ic * hw + i];
      out[oc * hw + i] = s;
    }
  }
  return out;
}

export function sigmoid(x) {
  if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z); }
  const z = Math.exp(x); return z / (1 + z);
}

export function forwardLogits(rgb, weights) {
  const c1 = conv2d(rgb, 3, GRID_IN_H, GRID_IN_W, f32(weights.conv1w), f32(weights.conv1b), C1, 2);
  const r1 = relu(c1.data);
  const c2 = conv2d(r1, C1, c1.h, c1.w, f32(weights.conv2w), f32(weights.conv2b), C2, 2);
  const r2 = relu(c2.data);
  const c3 = conv2d(r2, C2, c2.h, c2.w, f32(weights.conv3w), f32(weights.conv3b), C3, 2);
  const r3 = relu(c3.data);
  return conv1x1(r3, C3, c3.h, c3.w, f32(weights.headw), f32(weights.headb), HEAD);
}

function f32(arr) { return arr instanceof Float32Array ? arr : Float32Array.from(arr); }

/* encoding 'v2' 는 크기를 로그 눈금으로 적는다. 왜 그런지는
 * packages/hilit-vision/src/hilit-grid-net.ts 의 긴 주석에 적혀 있다.
 * 가중치에 적힌 값을 따라야 한다 — 섞으면 상자 크기가 통째로 틀어진다. */
export function decodeBoxes(logits, scoreMin = 0.35, encoding = 'v1') {
  const cellW = GRID_IN_W / GW, cellH = GRID_IN_H / GH, hw = GH * GW, out = [];
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const i = gy * GW + gx;
      const obj = sigmoid(logits[i]);
      if (obj < scoreMin) continue;
      const tx = sigmoid(logits[hw + i]), ty = sigmoid(logits[2 * hw + i]);
      const tw = sigmoid(logits[3 * hw + i]), th = sigmoid(logits[4 * hw + i]);
      const cx = (gx + tx) * cellW, cy = (gy + ty) * cellH;
      const width = encoding === 'v2'
        ? 3 * Math.pow(48 / 3, tw)
        : (0.8 + 2.4 * tw) * cellW;
      const height = encoding === 'v2'
        ? 8 * Math.pow(96 / 8, th)
        : (2.5 + 8.0 * th) * cellH;
      out.push({ x: cx - width / 2, y: cy - height / 2, width, height, score: obj });
    }
  }
  return out;
}

export function boxIou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1);
  const inter = w * h, uni = a.width * a.height + b.width * b.height - inter;
  return uni <= 0 ? 0 : inter / uni;
}

export function nms(boxes, iouThr = 0.45, maxKeep = 12) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const box of sorted) {
    if (keep.some((k) => boxIou(k, box) > iouThr)) continue;
    keep.push(box);
    if (keep.length >= maxKeep) break;
  }
  return keep;
}

export function rgbFromRgba(rgba, width, height) {
  const out = new Float32Array(3 * GRID_IN_H * GRID_IN_W);
  for (let y = 0; y < GRID_IN_H; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / GRID_IN_H));
    for (let x = 0; x < GRID_IN_W; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / GRID_IN_W));
      const i = (sy * width + sx) * 4, j = y * GRID_IN_W + x;
      out[j] = rgba[i] / 255;
      out[GRID_IN_H * GRID_IN_W + j] = rgba[i + 1] / 255;
      out[2 * GRID_IN_H * GRID_IN_W + j] = rgba[i + 2] / 255;
    }
  }
  return out;
}

function grayAt(gray, width, height, x, y) {
  const xx = Math.max(0, Math.min(width - 1, x));
  const yy = Math.max(0, Math.min(height - 1, y));
  return gray[yy * width + xx];
}

export function rgbaToGray(rgba, width, height) {
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    g[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return g;
}

function windowScore(gray, width, height, x, y, w, h) {
  let edge = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 12));
  for (let yy = y; yy < y + h; yy += step) {
    for (let xx = x; xx < x + w; xx += step) {
      const dx = grayAt(gray, width, height, xx + 1, yy) - grayAt(gray, width, height, xx - 1, yy);
      const dy = grayAt(gray, width, height, xx, yy + 1) - grayAt(gray, width, height, xx, yy - 1);
      edge += Math.abs(dx) * 0.35 + Math.abs(dy);
      n += 1;
    }
  }
  const aspect = h / Math.max(1, w);
  return (n ? edge / n : 0) * (aspect >= 1.6 && aspect <= 5.2 ? 1 : 0.15);
}

export function proposeStandEnergy(gray, width, height, maxKeep = 8) {
  if (width < 16 || height < 24) return [];
  const cand = [];
  const h0 = Math.max(16, Math.round(height * 0.22));
  const h1 = Math.max(h0 + 1, Math.round(height * 0.78));
  const hStep = Math.max(8, Math.round(height * 0.1));
  for (let h = h0; h <= h1; h += hStep) {
    const w = Math.max(8, Math.round(h * 0.36));
    const yStep = Math.max(4, Math.round(h * 0.28));
    const xStep = Math.max(4, Math.round(w * 0.4));
    for (let y = 0; y <= height - h; y += yStep) {
      for (let x = 0; x <= width - w; x += xStep) {
        cand.push({ x, y, width: w, height: h, score: windowScore(gray, width, height, x, y, w, h) });
      }
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const floor = cand.length ? cand[0].score * 0.42 : 0;
  const keep = [];
  for (const box of cand) {
    if (box.score < Math.max(4, floor)) continue;
    if (keep.some((k) => boxIou(k, box) > 0.4)) continue;
    keep.push(box);
    if (keep.length >= maxKeep) break;
  }
  if (!keep.length) return [];
  const max = keep[0].score || 1;
  return keep.map((b) => ({ ...b, score: Math.min(0.99, b.score / max) }));
}

function scaleGrid(box, frameW, frameH) {
  const sx = frameW / GRID_IN_W, sy = frameH / GRID_IN_H;
  return {
    x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy,
    detectorScore: box.score, source: 'hilit-grid', candidateId: '',
  };
}

/* 조각까지 합치면 후보가 는다. 12 로 묶어 두면 조각에서 나온 작은
 * 사람들이 큰 사람에게 밀려 잘린다 — 실측에서 키 50px 구간 검출률이
 * 92.5%에서 72.5%로 떨어졌다. 조각을 쓸 때는 24 까지 받는다. */
function nmsProposals(boxes, iouThr, maxKeep = 12) {
  const sorted = [...boxes].sort((a, b) => b.detectorScore - a.detectorScore);
  const keep = [];
  for (const box of sorted) {
    if (keep.some((k) => boxIou(k, box) > iouThr)) continue;
    keep.push(box);
    if (keep.length >= maxKeep) break;
  }
  return keep;
}

export function cropRgba(rgba, width, height, region) {
  const originX = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const originY = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const cropW = Math.max(1, Math.min(width - originX, Math.floor(region.width)));
  const cropH = Math.max(1, Math.min(height - originY, Math.floor(region.height)));
  const out = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    const src = ((originY + y) * width + originX) * 4;
    out.set(rgba.subarray(src, src + cropW * 4), y * cropW * 4);
  }
  return { rgba: out, width: cropW, height: cropH, originX, originY };
}

export class HilitPersonDetector {
  constructor(weights, reason = null) {
    this.weights = weights;
    this.reason = reason;
  }

  static fromWeights(weights) { return new HilitPersonDetector(weights, null); }

  /* 스포츠 가중치를 먼저 본다.
   *
   * 예전 가중치(hilit-grid-synth-v0)는 세 띠 색 막대로 배웠다. 팔다리도
   * 겹침도 잘린 사람도 본 적이 없다. 스포츠 장면을 그려 다시 배운 쪽이
   * 합성 두 시험대 **모두에서** 더 낫다(2026-09-21 측정).
   *
   *   스포츠 시험대  recall 17.7% -> 47.5% · precision 2.7% -> 14.6%
   *   막대 시험대    recall 34.6% -> 62.5% · precision 10.3% -> 29.0%
   *
   * 둘 다 우리가 그린 도형에서 잰 값이다. 실사 검출 성능이 아니고,
   * precision 15%는 여전히 제품 기준에 한참 못 미친다. 그래도 예전
   * 가중치보다 나으므로 이쪽을 먼저 싣는다. 없으면 예전 것으로 물러난다. */
  static async load() {
    const candidates = [
      { file: './hilit-grid-sports-v1.json', id: 'hilit-grid-sports-v1' },
      { file: './hilit-grid-synth-v0.json', id: MODEL_ID },
    ];
    let lastReason = 'weights-missing';
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate.file, import.meta.url);
        const res = await fetch(url);
        if (!res.ok) { lastReason = 'weights-missing'; continue; }
        const weights = await res.json();
        if (weights?.modelId !== candidate.id) { lastReason = 'weights-id-mismatch'; continue; }
        return new HilitPersonDetector(weights, null);
      } catch {
        lastReason = 'weights-load-failed';
      }
    }
    return new HilitPersonDetector(null, lastReason);
  }

  proposeFromCanvas(canvas, { timestamp = 0, ...options } = {}) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width, height } = canvas;
    const img = ctx.getImageData(0, 0, width, height);
    return this.proposeRgba(img.data, width, height, timestamp, options);
  }

  proposeOnRegion(rgba, width, height, region, sources = 'all', scoreMin = DETECTOR_SCORE_MIN.default) {
    let view = { rgba, width, height, originX: 0, originY: 0 };
    if (region) view = cropRgba(rgba, width, height, region);
    const useGrid = sources !== 'stand';
    const useStand = sources !== 'grid';
    const proposals = [];
    const rgb = rgbFromRgba(view.rgba, view.width, view.height);
    if (useGrid && this.weights) {
      const grid = nms(decodeBoxes(forwardLogits(rgb, this.weights), scoreMin, this.weights.sizeEncoding || 'v1'));
      for (const box of grid) {
        const p = scaleGrid(box, view.width, view.height);
        p.x += view.originX; p.y += view.originY;
        proposals.push(p);
      }
    }
    if (useStand) {
      const smallGray = new Float32Array(GRID_IN_W * GRID_IN_H);
      const plane = GRID_IN_W * GRID_IN_H;
      for (let i = 0; i < plane; i++) {
        smallGray[i] = (0.299 * rgb[i] + 0.587 * rgb[plane + i] + 0.114 * rgb[2 * plane + i]) * 255;
      }
      const stand = proposeStandEnergy(smallGray, GRID_IN_W, GRID_IN_H, 8);
      for (const box of stand) {
        const p = scaleGrid(box, view.width, view.height);
        p.source = 'stand-energy';
        p.x += view.originX; p.y += view.originY;
        proposals.push(p);
      }
    }
    return nmsProposals(proposals, 0.5);
  }

  proposeRgba(rgba, width, height, timestamp = 0, options = {}) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      if (options.signal?.aborted) {
        return this.finish('error', 'cancelled', [], t0, width, height, timestamp, 'error');
      }
      if (!(width > 2) || !(height > 2) || rgba.length < width * height * 4) {
        return this.finish('error', 'bad-frame', [], t0, width, height, timestamp, 'error');
      }
      let proposals = [];
      let sliceCount = 1;
      if (options.region) {
        proposals = this.proposeOnRegion(rgba, width, height, options.region, options.sources, options.scoreMin);
      } else if (options.sliced) {
        const subjectHeight = options.subjectHeight
          ?? (options.focus && height > 0 ? options.focus.height / height : null);
        const slices = planSlices(width, height, {
          focus: options.focus ?? null,
          subjectHeight,
          maxSlices: options.maxSlices ?? 3,
          force: options.forceSlice === true,
        });
        sliceCount = slices.length;
        const raw = [];
        for (const slice of slices) {
          const local = this.proposeOnRegion(rgba, width, height, slice.region, options.sources, options.scoreMin);
          for (const box of local) {
            if (isClipped(box, slice)) continue;
            raw.push(box);
          }
        }
        proposals = nmsProposals(raw, 0.5, 24);
      } else {
        proposals = this.proposeOnRegion(rgba, width, height, null, options.sources, options.scoreMin);
      }
      const merged = proposals.map((p, i) => ({
        ...p, candidateId: `${p.source}-${i + 1}`,
      }));
      const quality = this.weights ? 'pipeline-check' : 'heuristic-only';
      const modelId = this.weights ? MODEL_ID : STAND_MODEL_ID;
      const modelVersion = this.weights ? MODEL_VERSION : '0.1.0';
      const run = !merged.length
        ? this.finish('empty', null, [], t0, width, height, timestamp, 'ready', quality, modelId, modelVersion)
        : this.finish('ok', null, merged, t0, width, height, timestamp, 'ready', quality, modelId, modelVersion);
      run.sliceCount = sliceCount;
      return run;
    } catch (err) {
      return this.finish('error', err instanceof Error ? err.message : String(err), [], t0, width, height, timestamp, 'error');
    }
  }

  finish(outcome, reason, proposals, t0, width, height, timestamp, availability, qualityStatus = 'unavailable', modelId = this.weights ? MODEL_ID : null, modelVersion = this.weights ? MODEL_VERSION : null) {
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      outcome, availability, modelId, modelVersion, qualityStatus, proposals,
      reason: reason ?? this.reason, elapsedMs: Math.max(0, t1 - t0),
      analysisWidth: GRID_IN_W, analysisHeight: GRID_IN_H,
      frameWidth: width, frameHeight: height, timestamp,
    };
  }
}

export function decideDetectorReacquire(input) {
  const mode = input.mode;
  if (mode === 'off' || mode === 'diagnose' || mode === 'assist' || mode === 'correct') {
    return { action: 'diagnose_only', reason: `mode-${mode}`, chosenIndex: null };
  }
  const proposals = input.proposals || [];
  if (!proposals.length) return { action: 'ask_user', reason: 'no-proposal', chosenIndex: null };
  if (input.gapSeconds > 8) return { action: 'ask_user', reason: 'gap-too-long', chosenIndex: null };
  if (input.appearanceDecision !== 'accept') {
    return { action: 'ask_user', reason: `appearance-${input.appearanceDecision}`, chosenIndex: null };
  }
  if (proposals.length === 1) {
    return { action: 'ask_user', reason: 'single-candidate-not-enough', chosenIndex: null };
  }
  if (!((input.uniqueMargin ?? 0) >= 0.08)) {
    return { action: 'ask_user', reason: 'not-unique', chosenIndex: null };
  }
  let best = 0, bestSelf = -1;
  proposals.forEach((p, i) => {
    const self = p.appearanceSelf ?? -1;
    if (self > bestSelf) { bestSelf = self; best = i; }
  });
  if (proposals[best].motionErrorBodies > 3) {
    return { action: 'ask_user', reason: 'motion-too-far', chosenIndex: null };
  }
  return { action: 'confirm', reason: 'appearance-unique-motion', chosenIndex: best };
}
