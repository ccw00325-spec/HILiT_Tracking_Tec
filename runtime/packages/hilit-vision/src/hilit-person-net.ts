/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·1fa0a5df @license @preserve */
/* HilitPersonNet v0 — HILiT가 처음부터 학습하는 사람 검출기 기반.

외부 COCO/ImageNet 가중치, teacher, 자동 다운로드가 없다.
NanoDet·YOLO 구현을 복사하지 않는다. 일반 아이디어만 쓴다:
depthwise separable conv, 3단 특징, anchor-free center, GIoU, focal.

입력 기본은 96×160. 제품 목표 192×320과 같은 위상(16으로 나뉨)이다.
순수 TypeScript 역전파로 점검을 돌리려고 공간 크기를 반으로 두었다.
실사 정확도를 이 파일의 합성 숫자로 주장하지 않는다.
*/

import {
  filterRestoredBoxes,
  letterboxRgba,
  planPreprocess,
  restoreBox,
  type PreprocessMeta,
} from './letterbox.ts';

export const PERSONNET_IN_W = 96;
export const PERSONNET_IN_H = 160;
export const PERSONNET_PRODUCT_IN_W = 192;
export const PERSONNET_PRODUCT_IN_H = 320;
export const PERSONNET_STRIDE = 4;
export const PERSONNET_MODEL_ID = 'hilit-personnet';
export const PERSONNET_MODEL_VERSION = '0.0.0';
export const PERSONNET_ARCHITECTURE = 'hilit-personnet-v0-dw-fpn-center';

export interface PersonNetBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  gx?: number;
  gy?: number;
  small?: boolean;
  occluded?: boolean;
  edge?: boolean;
}

export interface PersonNetWeights {
  modelId: string;
  modelVersion: string;
  architecture: string;
  initializedFromScratch: true;
  seed: number;
  inW: number;
  inH: number;
  stemW: number[];
  stemB: number[];
  dw3W: number[];
  dw3B: number[];
  pw3W: number[];
  pw3B: number[];
  dw4W: number[];
  dw4B: number[];
  pw4W: number[];
  pw4B: number[];
  dw5W: number[];
  dw5B: number[];
  pw5W: number[];
  pw5B: number[];
  fuse3W: number[];
  fuse3B: number[];
  fuse4W: number[];
  fuse4B: number[];
  fuse5W: number[];
  fuse5B: number[];
  headW: number[];
  headB: number[];
}

export interface PersonNetProvenance {
  modelId: string;
  modelVersion: string;
  architecture: string;
  initializedFromScratch: true;
  trainingRunId: string;
  datasetManifestHash: string;
  trainAssetCount: number;
  validationAssetCount: number;
  holdoutAssetCount: number;
  sourceCommit: string;
  createdAt: string;
  commercialUseStatus: 'approved' | 'internal-evaluation';
  externalWeights: [];
  externalTrainingData: [];
  modelSha256: string;
  syntheticOnly: boolean;
  productEligible: boolean;
}

export interface PersonNetCheckpoint {
  format: 'hilit-personnet-v0';
  weights: PersonNetWeights;
  provenance: PersonNetProvenance;
}

export interface PersonSynthSample {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  people: PersonNetBox[];
  kind: 'normal' | 'small' | 'occluded' | 'edge';
  syntheticOnly: true;
}

export interface PersonNetTrainReport {
  steps: number;
  firstLoss: number;
  lastLoss: number;
  losses: number[];
  syntheticOnly: true;
  realWorldPrecision: null;
  realWorldRecall: null;
  productEligible: false;
}

const STEM_C = 8;
const P3_C = 16;
const P4_C = 20;
const P5_C = 20;
const FUSE_C = 12;
const HEAD_C = 5;

function mulberry(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randnFill(out: Float32Array, rng: () => number, scale: number): void {
  for (let i = 0; i < out.length; i += 1) out[i] = (rng() * 2 - 1) * scale;
}

function cloneArr(xs: ArrayLike<number>): Float32Array {
  return Float32Array.from(xs);
}

export function personNetParamCount(weights: PersonNetWeights): number {
  return (
    weights.stemW.length + weights.stemB.length
    + weights.dw3W.length + weights.dw3B.length + weights.pw3W.length + weights.pw3B.length
    + weights.dw4W.length + weights.dw4B.length + weights.pw4W.length + weights.pw4B.length
    + weights.dw5W.length + weights.dw5B.length + weights.pw5W.length + weights.pw5B.length
    + weights.fuse3W.length + weights.fuse3B.length
    + weights.fuse4W.length + weights.fuse4B.length
    + weights.fuse5W.length + weights.fuse5B.length
    + weights.headW.length + weights.headB.length
  );
}

export function initPersonNetWeights(seed = 1, inW = PERSONNET_IN_W, inH = PERSONNET_IN_H): PersonNetWeights {
  const rng = mulberry(seed);
  const stemW = new Float32Array(STEM_C * 3 * 9);
  const stemB = new Float32Array(STEM_C);
  const dw3W = new Float32Array(STEM_C * 9);
  const dw3B = new Float32Array(STEM_C);
  const pw3W = new Float32Array(P3_C * STEM_C);
  const pw3B = new Float32Array(P3_C);
  const dw4W = new Float32Array(P3_C * 9);
  const dw4B = new Float32Array(P3_C);
  const pw4W = new Float32Array(P4_C * P3_C);
  const pw4B = new Float32Array(P4_C);
  const dw5W = new Float32Array(P4_C * 9);
  const dw5B = new Float32Array(P4_C);
  const pw5W = new Float32Array(P5_C * P4_C);
  const pw5B = new Float32Array(P5_C);
  const fuse3W = new Float32Array(FUSE_C * P3_C);
  const fuse3B = new Float32Array(FUSE_C);
  const fuse4W = new Float32Array(FUSE_C * P4_C);
  const fuse4B = new Float32Array(FUSE_C);
  const fuse5W = new Float32Array(FUSE_C * P5_C);
  const fuse5B = new Float32Array(FUSE_C);
  const headW = new Float32Array(HEAD_C * FUSE_C);
  const headB = new Float32Array(HEAD_C);
  randnFill(stemW, rng, 0.12);
  randnFill(dw3W, rng, 0.12);
  randnFill(pw3W, rng, 0.12);
  randnFill(dw4W, rng, 0.12);
  randnFill(pw4W, rng, 0.12);
  randnFill(dw5W, rng, 0.12);
  randnFill(pw5W, rng, 0.12);
  randnFill(fuse3W, rng, 0.12);
  randnFill(fuse4W, rng, 0.12);
  randnFill(fuse5W, rng, 0.12);
  randnFill(headW, rng, 0.08);
  headB[0] = -1.8;
  return {
    modelId: PERSONNET_MODEL_ID,
    modelVersion: PERSONNET_MODEL_VERSION,
    architecture: PERSONNET_ARCHITECTURE,
    initializedFromScratch: true,
    seed,
    inW,
    inH,
    stemW: Array.from(stemW),
    stemB: Array.from(stemB),
    dw3W: Array.from(dw3W),
    dw3B: Array.from(dw3B),
    pw3W: Array.from(pw3W),
    pw3B: Array.from(pw3B),
    dw4W: Array.from(dw4W),
    dw4B: Array.from(dw4B),
    pw4W: Array.from(pw4W),
    pw4B: Array.from(pw4B),
    dw5W: Array.from(dw5W),
    dw5B: Array.from(dw5B),
    pw5W: Array.from(pw5W),
    pw5B: Array.from(pw5B),
    fuse3W: Array.from(fuse3W),
    fuse3B: Array.from(fuse3B),
    fuse4W: Array.from(fuse4W),
    fuse4B: Array.from(fuse4B),
    fuse5W: Array.from(fuse5W),
    fuse5B: Array.from(fuse5B),
    headW: Array.from(headW),
    headB: Array.from(headB),
  };
}

function sigmoid(x: number): number {
  if (x > 12) return 1;
  if (x < -12) return 0;
  return 1 / (1 + Math.exp(-x));
}

function softplus(x: number): number {
  if (x > 20) return x;
  if (x < -20) return Math.exp(x);
  return Math.log(1 + Math.exp(x));
}

function idx(c: number, y: number, x: number, h: number, w: number): number {
  return (c * h + y) * w + x;
}

function conv3x3(
  input: Float32Array,
  inC: number,
  inH: number,
  inW: number,
  w: Float32Array,
  b: Float32Array,
  outC: number,
  stride: number,
): { data: Float32Array; h: number; w: number } {
  const pad = 1;
  const outH = Math.floor((inH + 2 * pad - 3) / stride) + 1;
  const outW = Math.floor((inW + 2 * pad - 3) / stride) + 1;
  const out = new Float32Array(outC * outH * outW);
  for (let oc = 0; oc < outC; oc += 1) {
    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        let s = b[oc];
        const iy0 = y * stride - pad;
        const ix0 = x * stride - pad;
        for (let ic = 0; ic < inC; ic += 1) {
          const wBase = (oc * inC + ic) * 9;
          const inBase = ic * inH * inW;
          for (let ky = 0; ky < 3; ky += 1) {
            const iy = iy0 + ky;
            if (iy < 0 || iy >= inH) continue;
            for (let kx = 0; kx < 3; kx += 1) {
              const ix = ix0 + kx;
              if (ix < 0 || ix >= inW) continue;
              s += w[wBase + ky * 3 + kx] * input[inBase + iy * inW + ix];
            }
          }
        }
        out[idx(oc, y, x, outH, outW)] = s;
      }
    }
  }
  return { data: out, h: outH, w: outW };
}

function conv3x3Backward(
  input: Float32Array,
  inC: number,
  inH: number,
  inW: number,
  w: Float32Array,
  outC: number,
  stride: number,
  dOut: Float32Array,
  outH: number,
  outW: number,
  dW: Float32Array,
  dB: Float32Array,
  dIn: Float32Array | null,
): void {
  const pad = 1;
  for (let oc = 0; oc < outC; oc += 1) {
    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        const go = dOut[idx(oc, y, x, outH, outW)];
        dB[oc] += go;
        const iy0 = y * stride - pad;
        const ix0 = x * stride - pad;
        for (let ic = 0; ic < inC; ic += 1) {
          const wBase = (oc * inC + ic) * 9;
          const inBase = ic * inH * inW;
          for (let ky = 0; ky < 3; ky += 1) {
            const iy = iy0 + ky;
            if (iy < 0 || iy >= inH) continue;
            for (let kx = 0; kx < 3; kx += 1) {
              const ix = ix0 + kx;
              if (ix < 0 || ix >= inW) continue;
              const iv = input[inBase + iy * inW + ix];
              dW[wBase + ky * 3 + kx] += go * iv;
              if (dIn) dIn[inBase + iy * inW + ix] += go * w[wBase + ky * 3 + kx];
            }
          }
        }
      }
    }
  }
}

function dwconv3x3(
  input: Float32Array,
  c: number,
  inH: number,
  inW: number,
  w: Float32Array,
  b: Float32Array,
  stride: number,
): { data: Float32Array; h: number; w: number } {
  const pad = 1;
  const outH = Math.floor((inH + 2 * pad - 3) / stride) + 1;
  const outW = Math.floor((inW + 2 * pad - 3) / stride) + 1;
  const out = new Float32Array(c * outH * outW);
  for (let oc = 0; oc < c; oc += 1) {
    const wBase = oc * 9;
    const inBase = oc * inH * inW;
    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        let s = b[oc];
        const iy0 = y * stride - pad;
        const ix0 = x * stride - pad;
        for (let ky = 0; ky < 3; ky += 1) {
          const iy = iy0 + ky;
          if (iy < 0 || iy >= inH) continue;
          for (let kx = 0; kx < 3; kx += 1) {
            const ix = ix0 + kx;
            if (ix < 0 || ix >= inW) continue;
            s += w[wBase + ky * 3 + kx] * input[inBase + iy * inW + ix];
          }
        }
        out[idx(oc, y, x, outH, outW)] = s;
      }
    }
  }
  return { data: out, h: outH, w: outW };
}

function dwconv3x3Backward(
  input: Float32Array,
  c: number,
  inH: number,
  inW: number,
  w: Float32Array,
  stride: number,
  dOut: Float32Array,
  outH: number,
  outW: number,
  dW: Float32Array,
  dB: Float32Array,
  dIn: Float32Array | null,
): void {
  const pad = 1;
  for (let oc = 0; oc < c; oc += 1) {
    const wBase = oc * 9;
    const inBase = oc * inH * inW;
    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        const go = dOut[idx(oc, y, x, outH, outW)];
        dB[oc] += go;
        const iy0 = y * stride - pad;
        const ix0 = x * stride - pad;
        for (let ky = 0; ky < 3; ky += 1) {
          const iy = iy0 + ky;
          if (iy < 0 || iy >= inH) continue;
          for (let kx = 0; kx < 3; kx += 1) {
            const ix = ix0 + kx;
            if (ix < 0 || ix >= inW) continue;
            dW[wBase + ky * 3 + kx] += go * input[inBase + iy * inW + ix];
            if (dIn) dIn[inBase + iy * inW + ix] += go * w[wBase + ky * 3 + kx];
          }
        }
      }
    }
  }
}

function conv1x1(
  input: Float32Array,
  inC: number,
  h: number,
  w: number,
  weight: Float32Array,
  bias: Float32Array,
  outC: number,
): Float32Array {
  const hw = h * w;
  const out = new Float32Array(outC * hw);
  for (let oc = 0; oc < outC; oc += 1) {
    for (let i = 0; i < hw; i += 1) {
      let s = bias[oc];
      for (let ic = 0; ic < inC; ic += 1) s += weight[oc * inC + ic] * input[ic * hw + i];
      out[oc * hw + i] = s;
    }
  }
  return out;
}

function conv1x1Backward(
  input: Float32Array,
  inC: number,
  h: number,
  w: number,
  weight: Float32Array,
  outC: number,
  dOut: Float32Array,
  dW: Float32Array,
  dB: Float32Array,
  dIn: Float32Array | null,
): void {
  const hw = h * w;
  for (let oc = 0; oc < outC; oc += 1) {
    for (let i = 0; i < hw; i += 1) {
      const go = dOut[oc * hw + i];
      dB[oc] += go;
      for (let ic = 0; ic < inC; ic += 1) {
        dW[oc * inC + ic] += go * input[ic * hw + i];
        if (dIn) dIn[ic * hw + i] += go * weight[oc * inC + ic];
      }
    }
  }
}

function relu(x: Float32Array): Float32Array {
  const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 1) o[i] = x[i] > 0 ? x[i] : 0;
  return o;
}

function reluBackward(pre: Float32Array, dOut: Float32Array): Float32Array {
  const o = new Float32Array(pre.length);
  for (let i = 0; i < pre.length; i += 1) o[i] = pre[i] > 0 ? dOut[i] : 0;
  return o;
}

function nearestUp(input: Float32Array, c: number, inH: number, inW: number, scale: number): Float32Array {
  const outH = inH * scale;
  const outW = inW * scale;
  const out = new Float32Array(c * outH * outW);
  for (let oc = 0; oc < c; oc += 1) {
    for (let y = 0; y < outH; y += 1) {
      const iy = Math.min(inH - 1, Math.floor(y / scale));
      for (let x = 0; x < outW; x += 1) {
        const ix = Math.min(inW - 1, Math.floor(x / scale));
        out[idx(oc, y, x, outH, outW)] = input[idx(oc, iy, ix, inH, inW)];
      }
    }
  }
  return out;
}

function nearestUpBackward(
  dOut: Float32Array,
  c: number,
  inH: number,
  inW: number,
  scale: number,
): Float32Array {
  const outH = inH * scale;
  const outW = inW * scale;
  const dIn = new Float32Array(c * inH * inW);
  for (let oc = 0; oc < c; oc += 1) {
    for (let y = 0; y < outH; y += 1) {
      const iy = Math.min(inH - 1, Math.floor(y / scale));
      for (let x = 0; x < outW; x += 1) {
        const ix = Math.min(inW - 1, Math.floor(x / scale));
        dIn[idx(oc, iy, ix, inH, inW)] += dOut[idx(oc, y, x, outH, outW)];
      }
    }
  }
  return dIn;
}

function add3(a: Float32Array, b: Float32Array, c: Float32Array): Float32Array {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) o[i] = a[i] + b[i] + c[i];
  return o;
}

export function rgbaToPersonNetRgb(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const rgb = new Float32Array(3 * height * width);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i] = rgba[i * 4] / 255;
    rgb[width * height + i] = rgba[i * 4 + 1] / 255;
    rgb[2 * width * height + i] = rgba[i * 4 + 2] / 255;
  }
  return rgb;
}

interface Live {
  stemW: Float32Array; stemB: Float32Array;
  dw3W: Float32Array; dw3B: Float32Array; pw3W: Float32Array; pw3B: Float32Array;
  dw4W: Float32Array; dw4B: Float32Array; pw4W: Float32Array; pw4B: Float32Array;
  dw5W: Float32Array; dw5B: Float32Array; pw5W: Float32Array; pw5B: Float32Array;
  fuse3W: Float32Array; fuse3B: Float32Array;
  fuse4W: Float32Array; fuse4B: Float32Array;
  fuse5W: Float32Array; fuse5B: Float32Array;
  headW: Float32Array; headB: Float32Array;
}

function toLive(w: PersonNetWeights): Live {
  return {
    stemW: cloneArr(w.stemW), stemB: cloneArr(w.stemB),
    dw3W: cloneArr(w.dw3W), dw3B: cloneArr(w.dw3B), pw3W: cloneArr(w.pw3W), pw3B: cloneArr(w.pw3B),
    dw4W: cloneArr(w.dw4W), dw4B: cloneArr(w.dw4B), pw4W: cloneArr(w.pw4W), pw4B: cloneArr(w.pw4B),
    dw5W: cloneArr(w.dw5W), dw5B: cloneArr(w.dw5B), pw5W: cloneArr(w.pw5W), pw5B: cloneArr(w.pw5B),
    fuse3W: cloneArr(w.fuse3W), fuse3B: cloneArr(w.fuse3B),
    fuse4W: cloneArr(w.fuse4W), fuse4B: cloneArr(w.fuse4B),
    fuse5W: cloneArr(w.fuse5W), fuse5B: cloneArr(w.fuse5B),
    headW: cloneArr(w.headW), headB: cloneArr(w.headB),
  };
}

/** 배열 길이로 채널을 읽는다. Plus는 v0보다 넓게 초기화한다. */
function ch(w: Live): { stem: number; p3: number; p4: number; p5: number; fuse: number; head: number } {
  return {
    stem: w.stemB.length,
    p3: w.pw3B.length,
    p4: w.pw4B.length,
    p5: w.pw5B.length,
    fuse: w.fuse3B.length,
    head: w.headB.length,
  };
}

function fromLive(src: PersonNetWeights, live: Live): PersonNetWeights {
  return {
    ...src,
    stemW: Array.from(live.stemW), stemB: Array.from(live.stemB),
    dw3W: Array.from(live.dw3W), dw3B: Array.from(live.dw3B), pw3W: Array.from(live.pw3W), pw3B: Array.from(live.pw3B),
    dw4W: Array.from(live.dw4W), dw4B: Array.from(live.dw4B), pw4W: Array.from(live.pw4W), pw4B: Array.from(live.pw4B),
    dw5W: Array.from(live.dw5W), dw5B: Array.from(live.dw5B), pw5W: Array.from(live.pw5W), pw5B: Array.from(live.pw5B),
    fuse3W: Array.from(live.fuse3W), fuse3B: Array.from(live.fuse3B),
    fuse4W: Array.from(live.fuse4W), fuse4B: Array.from(live.fuse4B),
    fuse5W: Array.from(live.fuse5W), fuse5B: Array.from(live.fuse5B),
    headW: Array.from(live.headW), headB: Array.from(live.headB),
  };
}

interface Tape {
  rgb: Float32Array;
  inH: number;
  inW: number;
  stem: Float32Array; stemH: number; stemW: number; stemPre: Float32Array;
  dw3: Float32Array; dw3H: number; dw3W: number;
  p3pre: Float32Array; p3: Float32Array; p3H: number; p3W: number;
  dw4: Float32Array; dw4H: number; dw4W: number;
  p4pre: Float32Array; p4: Float32Array; p4H: number; p4W: number;
  dw5: Float32Array; dw5H: number; dw5W: number;
  p5pre: Float32Array; p5: Float32Array; p5H: number; p5W: number;
  f3: Float32Array; f4: Float32Array; f5: Float32Array;
  f4up: Float32Array; f5up: Float32Array;
  fused: Float32Array;
  logits: Float32Array;
}

function forwardTape(rgb: Float32Array, w: Live, inH: number, inW: number): Tape {
  const C = ch(w);
  const stemConv = conv3x3(rgb, 3, inH, inW, w.stemW, w.stemB, C.stem, 2);
  const stem = relu(stemConv.data);
  const dw3 = dwconv3x3(stem, C.stem, stemConv.h, stemConv.w, w.dw3W, w.dw3B, 2);
  const p3pre = conv1x1(dw3.data, C.stem, dw3.h, dw3.w, w.pw3W, w.pw3B, C.p3);
  const p3 = relu(p3pre);
  const dw4 = dwconv3x3(p3, C.p3, dw3.h, dw3.w, w.dw4W, w.dw4B, 2);
  const p4pre = conv1x1(dw4.data, C.p3, dw4.h, dw4.w, w.pw4W, w.pw4B, C.p4);
  const p4 = relu(p4pre);
  const dw5 = dwconv3x3(p4, C.p4, dw4.h, dw4.w, w.dw5W, w.dw5B, 2);
  const p5pre = conv1x1(dw5.data, C.p4, dw5.h, dw5.w, w.pw5W, w.pw5B, C.p5);
  const p5 = relu(p5pre);
  const f3 = conv1x1(p3, C.p3, dw3.h, dw3.w, w.fuse3W, w.fuse3B, C.fuse);
  const f4 = conv1x1(p4, C.p4, dw4.h, dw4.w, w.fuse4W, w.fuse4B, C.fuse);
  const f5 = conv1x1(p5, C.p5, dw5.h, dw5.w, w.fuse5W, w.fuse5B, C.fuse);
  const f4up = nearestUp(f4, C.fuse, dw4.h, dw4.w, 2);
  const f5up = nearestUp(f5, C.fuse, dw5.h, dw5.w, 4);
  const fused = add3(f3, f4up, f5up);
  const logits = conv1x1(fused, C.fuse, dw3.h, dw3.w, w.headW, w.headB, C.head);
  return {
    rgb, inH, inW,
    stem, stemH: stemConv.h, stemW: stemConv.w, stemPre: stemConv.data,
    dw3: dw3.data, dw3H: dw3.h, dw3W: dw3.w,
    p3pre, p3, p3H: dw3.h, p3W: dw3.w,
    dw4: dw4.data, dw4H: dw4.h, dw4W: dw4.w,
    p4pre, p4, p4H: dw4.h, p4W: dw4.w,
    dw5: dw5.data, dw5H: dw5.h, dw5W: dw5.w,
    p5pre, p5, p5H: dw5.h, p5W: dw5.w,
    f3, f4, f5, f4up, f5up, fused, logits,
  };
}

export function forwardPersonNet(rgb: Float32Array, weights: PersonNetWeights): {
  logits: Float32Array;
  gridH: number;
  gridW: number;
} {
  const live = toLive(weights);
  const tape = forwardTape(rgb, live, weights.inH, weights.inW);
  return { logits: tape.logits, gridH: tape.p3H, gridW: tape.p3W };
}

export function boxIou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const uni = a.width * a.height + b.width * b.height - inter;
  return uni <= 0 ? 0 : inter / uni;
}

export function generalizedIou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const aa = Math.max(0, a.width) * Math.max(0, a.height);
  const bb = Math.max(0, b.width) * Math.max(0, b.height);
  const uni = aa + bb - inter;
  const iou = uni > 0 ? inter / uni : 0;
  const cx1 = Math.min(a.x, b.x);
  const cy1 = Math.min(a.y, b.y);
  const cx2 = Math.max(a.x + a.width, b.x + b.width);
  const cy2 = Math.max(a.y + a.height, b.y + b.height);
  const c = Math.max(1e-6, (cx2 - cx1) * (cy2 - cy1));
  return iou - (c - uni) / c;
}

function decodeCell(
  logits: Float32Array,
  gx: number,
  gy: number,
  gridW: number,
  gridH: number,
  inW: number,
  inH: number,
): PersonNetBox {
  const hw = gridH * gridW;
  const i = gy * gridW + gx;
  const score = sigmoid(logits[i]);
  const ox = sigmoid(logits[hw + i]);
  const oy = sigmoid(logits[2 * hw + i]);
  const tw = Math.max(-4, Math.min(4, logits[3 * hw + i]));
  const th = Math.max(-4, Math.min(4, logits[4 * hw + i]));
  const cx = (gx + ox) * PERSONNET_STRIDE;
  const cy = (gy + oy) * PERSONNET_STRIDE;
  const width = Math.max(2, Math.exp(tw));
  const height = Math.max(2, Math.exp(th));
  void inW;
  void inH;
  return { x: cx - width / 2, y: cy - height / 2, width, height, score, gx, gy };
}

export function decodePersonNet(
  logits: Float32Array,
  gridH: number,
  gridW: number,
  inW: number,
  inH: number,
  scoreMin = 0.35,
): PersonNetBox[] {
  const out: PersonNetBox[] = [];
  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      const box = decodeCell(logits, gx, gy, gridW, gridH, inW, inH);
      if (box.score < scoreMin) continue;
      const i = gy * gridW + gx;
      let peak = true;
      for (let ny = Math.max(0, gy - 1); ny <= Math.min(gridH - 1, gy + 1) && peak; ny += 1) {
        for (let nx = Math.max(0, gx - 1); nx <= Math.min(gridW - 1, gx + 1); nx += 1) {
          if (ny === gy && nx === gx) continue;
          if (sigmoid(logits[ny * gridW + nx]) > box.score) peak = false;
        }
      }
      void i;
      if (peak) out.push(box);
    }
  }
  return out;
}

export function centerSuppress(boxes: PersonNetBox[], iouThr = 0.5, maxKeep = 12): PersonNetBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: PersonNetBox[] = [];
  for (const box of sorted) {
    if (keep.some((k) => boxIou(k, box) > iouThr)) continue;
    keep.push(box);
    if (keep.length >= maxKeep) break;
  }
  return keep;
}

export function restorePersonNetBoxes(
  boxes: PersonNetBox[],
  meta: PreprocessMeta,
): PersonNetBox[] {
  const restored: PersonNetBox[] = [];
  for (const box of boxes) {
    const r = restoreBox(box, meta);
    const clamped = filterRestoredBoxes([r], meta.sourceWidth, meta.sourceHeight)[0];
    if (!clamped) continue;
    restored.push({ ...box, ...clamped });
  }
  return restored;
}

export function letterboxForPersonNet(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  inW = PERSONNET_IN_W,
  inH = PERSONNET_IN_H,
): { rgb: Float32Array; meta: PreprocessMeta; analysis: Uint8ClampedArray } {
  const meta = planPreprocess(width, height, inW, inH, 'letterbox');
  const analysis = letterboxRgba(rgba, meta);
  return { rgb: rgbaToPersonNetRgb(analysis, inW, inH), meta, analysis };
}

function setPixel(rgba: Uint8ClampedArray, width: number, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= width || y >= rgba.length / (width * 4)) return;
  const i = (y * width + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = 255;
}

export function makePersonSynth(kind: PersonSynthSample['kind'] = 'normal', seed = 3): PersonSynthSample {
  const width = PERSONNET_IN_W;
  const height = PERSONNET_IN_H;
  const rng = mulberry(seed + kind.length * 17);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const n = 28 + Math.floor(rng() * 18);
    rgba[i] = n;
    rgba[i + 1] = n + 2;
    rgba[i + 2] = n + 6;
    rgba[i + 3] = 255;
  }
  let pw = kind === 'small' ? 10 : 18;
  let ph = kind === 'small' ? 28 : 70;
  let x = kind === 'edge' ? 0 : 38;
  let y = kind === 'small' ? 110 : 48;
  if (kind === 'normal') {
    x = 36;
    y = 42;
  }
  const headH = Math.max(6, Math.floor(ph * 0.22));
  const torsoH = Math.floor(ph * 0.46);
  for (let yy = 0; yy < ph; yy += 1) {
    for (let xx = 0; xx < pw; xx += 1) {
      const band = yy < headH ? [210, 160, 130] : yy < headH + torsoH ? [200, 40, 46] : [30, 40, 90];
      setPixel(rgba, width, x + xx, y + yy, band[0], band[1], band[2]);
    }
  }
  const cx = x + pw / 2;
  const cyh = y + headH / 2;
  const rad = Math.max(3, Math.floor(pw * 0.42));
  for (let yy = -rad; yy <= rad; yy += 1) {
    for (let xx = -rad; xx <= rad; xx += 1) {
      if (xx * xx + yy * yy <= rad * rad) {
        setPixel(rgba, width, Math.round(cx + xx), Math.round(cyh + yy), 220, 170, 140);
      }
    }
  }
  let occluded = false;
  if (kind === 'occluded') {
    occluded = true;
    for (let yy = y + Math.floor(ph * 0.35); yy < y + Math.floor(ph * 0.62); yy += 1) {
      for (let xx = 0; xx < width; xx += 1) setPixel(rgba, width, xx, yy, 70, 70, 74);
    }
  }
  const people: PersonNetBox[] = [{
    x,
    y,
    width: pw,
    height: ph,
    score: 1,
    small: kind === 'small',
    occluded,
    edge: kind === 'edge',
  }];
  return { rgba, width, height, people, kind, syntheticOnly: true };
}

function encodeTargets(
  people: PersonNetBox[],
  gridH: number,
  gridW: number,
): { obj: Float32Array; ox: Float32Array; oy: Float32Array; tw: Float32Array; th: Float32Array } {
  const n = gridH * gridW;
  const obj = new Float32Array(n);
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);
  const tw = new Float32Array(n);
  const th = new Float32Array(n);
  for (const p of people) {
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    const gx = Math.min(gridW - 1, Math.max(0, Math.floor(cx / PERSONNET_STRIDE)));
    const gy = Math.min(gridH - 1, Math.max(0, Math.floor(cy / PERSONNET_STRIDE)));
    const i = gy * gridW + gx;
    obj[i] = 1;
    ox[i] = cx / PERSONNET_STRIDE - gx;
    oy[i] = cy / PERSONNET_STRIDE - gy;
    tw[i] = Math.log(Math.max(2, p.width));
    th[i] = Math.log(Math.max(2, p.height));
  }
  return { obj, ox, oy, tw, th };
}

function zeroLike(xs: Float32Array): Float32Array {
  return new Float32Array(xs.length);
}

function sgd(param: Float32Array, grad: Float32Array, lr: number): void {
  for (let i = 0; i < param.length; i += 1) {
    const g = Math.max(-2, Math.min(2, grad[i]));
    param[i] -= lr * g;
    grad[i] = 0;
  }
}

function trainOne(rgb: Float32Array, people: PersonNetBox[], live: Live, inH: number, inW: number, lr: number): number {
  const C = ch(live);
  const tape = forwardTape(rgb, live, inH, inW);
  const gridH = tape.p3H;
  const gridW = tape.p3W;
  const hw = gridH * gridW;
  const t = encodeTargets(people, gridH, gridW);
  const dLogits = new Float32Array(C.head * hw);
  let loss = 0;
  const alpha = 0.25;
  const gamma = 2;
  for (let i = 0; i < hw; i += 1) {
    const logit = tape.logits[i];
    const p = sigmoid(logit);
    const pos = t.obj[i] > 0.5;
    if (pos) {
      const focus = alpha * (1 - p) ** gamma;
      loss += focus * softplus(-logit);
      dLogits[i] += focus * (p - 1);
      const px = sigmoid(tape.logits[hw + i]);
      const py = sigmoid(tape.logits[2 * hw + i]);
      const dOx = px - t.ox[i];
      const dOy = py - t.oy[i];
      loss += Math.abs(dOx) + Math.abs(dOy);
      dLogits[hw + i] += Math.sign(dOx || 1e-6) * px * (1 - px);
      dLogits[2 * hw + i] += Math.sign(dOy || 1e-6) * py * (1 - py);
      const dTw = tape.logits[3 * hw + i] - t.tw[i];
      const dTh = tape.logits[4 * hw + i] - t.th[i];
      loss += Math.abs(dTw) + Math.abs(dTh);
      dLogits[3 * hw + i] += Math.sign(dTw || 1e-6);
      dLogits[4 * hw + i] += Math.sign(dTh || 1e-6);
      const gx = i % gridW;
      const gy = Math.floor(i / gridW);
      const pred = decodeCell(tape.logits, gx, gy, gridW, gridH, inW, inH);
      const gt = people.find((p) => {
        const pcx = p.x + p.width / 2;
        const pcy = p.y + p.height / 2;
        return Math.floor(pcx / PERSONNET_STRIDE) === gx && Math.floor(pcy / PERSONNET_STRIDE) === gy;
      }) ?? people[0];
      loss += 1 - generalizedIou(pred, gt);
    } else {
      const focus = (1 - alpha) * p ** gamma;
      loss += focus * softplus(logit);
      dLogits[i] += focus * p;
    }
  }

  const dFused = zeroLike(tape.fused);
  const dHeadW = zeroLike(live.headW);
  const dHeadB = zeroLike(live.headB);
  conv1x1Backward(tape.fused, C.fuse, gridH, gridW, live.headW, C.head, dLogits, dHeadW, dHeadB, dFused);
  const dF3 = dFused;
  const dF4up = dFused;
  const dF5up = dFused;
  const dF4 = nearestUpBackward(dF4up, C.fuse, tape.p4H, tape.p4W, 2);
  const dF5 = nearestUpBackward(dF5up, C.fuse, tape.p5H, tape.p5W, 4);
  const dP3 = zeroLike(tape.p3);
  const dP4 = zeroLike(tape.p4);
  const dP5 = zeroLike(tape.p5);
  const dFuse3W = zeroLike(live.fuse3W);
  const dFuse3B = zeroLike(live.fuse3B);
  const dFuse4W = zeroLike(live.fuse4W);
  const dFuse4B = zeroLike(live.fuse4B);
  const dFuse5W = zeroLike(live.fuse5W);
  const dFuse5B = zeroLike(live.fuse5B);
  conv1x1Backward(tape.p3, C.p3, tape.p3H, tape.p3W, live.fuse3W, C.fuse, dF3, dFuse3W, dFuse3B, dP3);
  conv1x1Backward(tape.p4, C.p4, tape.p4H, tape.p4W, live.fuse4W, C.fuse, dF4, dFuse4W, dFuse4B, dP4);
  conv1x1Backward(tape.p5, C.p5, tape.p5H, tape.p5W, live.fuse5W, C.fuse, dF5, dFuse5W, dFuse5B, dP5);
  const dDw3 = zeroLike(tape.dw3);
  const dDw4 = zeroLike(tape.dw4);
  const dDw5 = zeroLike(tape.dw5);
  const dPw3W = zeroLike(live.pw3W);
  const dPw3B = zeroLike(live.pw3B);
  const dPw4W = zeroLike(live.pw4W);
  const dPw4B = zeroLike(live.pw4B);
  const dPw5W = zeroLike(live.pw5W);
  const dPw5B = zeroLike(live.pw5B);
  const dDw3W = zeroLike(live.dw3W);
  const dDw3B = zeroLike(live.dw3B);
  const dDw4W = zeroLike(live.dw4W);
  const dDw4B = zeroLike(live.dw4B);
  const dDw5W = zeroLike(live.dw5W);
  const dDw5B = zeroLike(live.dw5B);
  const dP5pre = reluBackward(tape.p5pre, dP5);
  conv1x1Backward(tape.dw5, C.p4, tape.dw5H, tape.dw5W, live.pw5W, C.p5, dP5pre, dPw5W, dPw5B, dDw5);
  dwconv3x3Backward(tape.p4, C.p4, tape.p4H, tape.p4W, live.dw5W, 2, dDw5, tape.dw5H, tape.dw5W, dDw5W, dDw5B, dP4);
  const dP4pre = reluBackward(tape.p4pre, dP4);
  conv1x1Backward(tape.dw4, C.p3, tape.dw4H, tape.dw4W, live.pw4W, C.p4, dP4pre, dPw4W, dPw4B, dDw4);
  dwconv3x3Backward(tape.p3, C.p3, tape.p3H, tape.p3W, live.dw4W, 2, dDw4, tape.dw4H, tape.dw4W, dDw4W, dDw4B, dP3);
  const dP3pre = reluBackward(tape.p3pre, dP3);
  conv1x1Backward(tape.dw3, C.stem, tape.dw3H, tape.dw3W, live.pw3W, C.p3, dP3pre, dPw3W, dPw3B, dDw3);
  const dStem = zeroLike(tape.stem);
  dwconv3x3Backward(tape.stem, C.stem, tape.stemH, tape.stemW, live.dw3W, 2, dDw3, tape.dw3H, tape.dw3W, dDw3W, dDw3B, dStem);
  const dStemPre = reluBackward(tape.stemPre, dStem);
  const dStemW = zeroLike(live.stemW);
  const dStemB = zeroLike(live.stemB);
  conv3x3Backward(tape.rgb, 3, inH, inW, live.stemW, C.stem, 2, dStemPre, tape.stemH, tape.stemW, dStemW, dStemB, null);

  sgd(live.headW, dHeadW, lr);
  sgd(live.headB, dHeadB, lr);
  sgd(live.fuse3W, dFuse3W, lr);
  sgd(live.fuse3B, dFuse3B, lr);
  sgd(live.fuse4W, dFuse4W, lr);
  sgd(live.fuse4B, dFuse4B, lr);
  sgd(live.fuse5W, dFuse5W, lr);
  sgd(live.fuse5B, dFuse5B, lr);
  sgd(live.pw3W, dPw3W, lr);
  sgd(live.pw3B, dPw3B, lr);
  sgd(live.pw4W, dPw4W, lr);
  sgd(live.pw4B, dPw4B, lr);
  sgd(live.pw5W, dPw5W, lr);
  sgd(live.pw5B, dPw5B, lr);
  sgd(live.dw3W, dDw3W, lr);
  sgd(live.dw3B, dDw3B, lr);
  sgd(live.dw4W, dDw4W, lr);
  sgd(live.dw4B, dDw4B, lr);
  sgd(live.dw5W, dDw5W, lr);
  sgd(live.dw5B, dDw5B, lr);
  sgd(live.stemW, dStemW, lr);
  sgd(live.stemB, dStemB, lr);
  return loss;
}

export function trainPersonNet(
  samples: PersonSynthSample[],
  weights: PersonNetWeights,
  options: { steps?: number; lr?: number } = {},
): { weights: PersonNetWeights; report: PersonNetTrainReport } {
  const steps = options.steps ?? 20;
  const lr = options.lr ?? 0.04;
  const live = toLive(weights);
  const losses: number[] = [];
  for (let s = 0; s < steps; s += 1) {
    const sample = samples[s % samples.length];
    const rgb = rgbaToPersonNetRgb(sample.rgba, sample.width, sample.height);
    losses.push(trainOne(rgb, sample.people, live, sample.height, sample.width, lr));
  }
  const next = fromLive(weights, live);
  return {
    weights: next,
    report: {
      steps,
      firstLoss: losses[0] ?? 0,
      lastLoss: losses[losses.length - 1] ?? 0,
      losses,
      syntheticOnly: true,
      realWorldPrecision: null,
      realWorldRecall: null,
      productEligible: false,
    },
  };
}

export function inferPersonNet(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  weights: PersonNetWeights,
  scoreMin = 0.35,
): { boxes: PersonNetBox[]; meta: PreprocessMeta; gridH: number; gridW: number } {
  const packed = letterboxForPersonNet(rgba, width, height, weights.inW, weights.inH);
  const fwd = forwardPersonNet(packed.rgb, weights);
  const raw = decodePersonNet(fwd.logits, fwd.gridH, fwd.gridW, weights.inW, weights.inH, scoreMin);
  const suppressed = centerSuppress(raw);
  return {
    boxes: restorePersonNetBoxes(suppressed, packed.meta),
    meta: packed.meta,
    gridH: fwd.gridH,
    gridW: fwd.gridW,
  };
}

export function emptyExternalLists(): { externalWeights: []; externalTrainingData: [] } {
  return { externalWeights: [], externalTrainingData: [] };
}

export function makePersonNetProvenance(input: {
  trainingRunId: string;
  datasetManifestHash: string;
  trainAssetCount: number;
  validationAssetCount: number;
  holdoutAssetCount: number;
  sourceCommit: string;
  modelSha256: string;
  syntheticOnly: boolean;
  createdAt?: string;
}): PersonNetProvenance {
  return {
    modelId: PERSONNET_MODEL_ID,
    modelVersion: PERSONNET_MODEL_VERSION,
    architecture: PERSONNET_ARCHITECTURE,
    initializedFromScratch: true,
    trainingRunId: input.trainingRunId,
    datasetManifestHash: input.datasetManifestHash,
    trainAssetCount: input.trainAssetCount,
    validationAssetCount: input.validationAssetCount,
    holdoutAssetCount: input.holdoutAssetCount,
    sourceCommit: input.sourceCommit,
    createdAt: input.createdAt ?? new Date().toISOString(),
    commercialUseStatus: input.syntheticOnly || input.holdoutAssetCount === 0
      ? 'internal-evaluation'
      : 'internal-evaluation',
    ...emptyExternalLists(),
    modelSha256: input.modelSha256,
    syntheticOnly: input.syntheticOnly,
    productEligible: false,
  };
}

export function validatePersonNetProvenance(raw: unknown, actualSha256?: string | null): string[] {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') return ['provenance가 객체가 아닙니다.'];
  const row = raw as Record<string, unknown>;
  const need = [
    'modelId', 'modelVersion', 'architecture', 'initializedFromScratch', 'trainingRunId',
    'datasetManifestHash', 'trainAssetCount', 'validationAssetCount', 'holdoutAssetCount',
    'sourceCommit', 'createdAt', 'commercialUseStatus', 'externalWeights', 'externalTrainingData',
    'modelSha256',
  ];
  for (const key of need) {
    if (!(key in row)) issues.push(`${key} 없음`);
  }
  if (row.initializedFromScratch !== true) issues.push('initializedFromScratch는 true여야 합니다.');
  if (!Array.isArray(row.externalWeights) || row.externalWeights.length !== 0) {
    issues.push('externalWeights는 빈 배열이어야 합니다.');
  }
  if (!Array.isArray(row.externalTrainingData) || row.externalTrainingData.length !== 0) {
    issues.push('externalTrainingData는 빈 배열이어야 합니다.');
  }
  if (row.commercialUseStatus !== 'approved' && row.commercialUseStatus !== 'internal-evaluation') {
    issues.push('commercialUseStatus는 approved 또는 internal-evaluation이어야 합니다.');
  }
  if (typeof row.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.modelSha256)) {
    issues.push('modelSha256이 없습니다.');
  } else if (actualSha256 && actualSha256.toLowerCase() !== String(row.modelSha256).toLowerCase()) {
    issues.push('모델 해시가 provenance와 다릅니다.');
  }
  if (typeof row.datasetManifestHash !== 'string' || row.datasetManifestHash.length < 8) {
    issues.push('datasetManifestHash가 없습니다.');
  }
  return issues;
}

export function serializePersonNetCheckpoint(checkpoint: PersonNetCheckpoint): string {
  return `${JSON.stringify(checkpoint)}\n`;
}

export function parsePersonNetCheckpoint(text: string): PersonNetCheckpoint {
  const raw = JSON.parse(text) as PersonNetCheckpoint;
  if (raw.format !== 'hilit-personnet-v0' || !raw.weights || !raw.provenance) {
    throw new Error('personnet-checkpoint-invalid');
  }
  return raw;
}
