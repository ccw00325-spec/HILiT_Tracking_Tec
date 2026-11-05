/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·2062d431 @license @preserve */
/* HilitPersonNet Plus — v0보다 넓은 자체 from-scratch 검출기.

외부 pretrained·teacher·COCO/ImageNet/SoccerNet 가중치가 없다.
채널은 12/24/28/28/16. 학습 식은 v0와 같고 용량만 키운다.
제품 모드는 여전히 diagnose. 동의 실사가 0편이면 학습·승격은 BLOCKED다.
*/

import {
  inferPersonNet,
  personNetParamCount,
  trainPersonNet,
  type PersonNetBox,
  type PersonNetTrainReport,
  type PersonNetWeights,
} from './hilit-person-net';
import {
  PERSONNET_RIGHTS_VERSION,
  emptyPersonNetRightsManifest,
  gateManifest,
  type GatePurpose,
  type PersonNetRightsManifest,
} from './hilit-data-rights';

export const PERSONNET_PLUS_MODEL_ID = 'hilit-personnet-plus';
export const PERSONNET_PLUS_MODEL_VERSION = '0.1.0';
export const PERSONNET_PLUS_ARCHITECTURE = 'hilit-personnet-plus-dw-fpn-center';
export const PERSONNET_PLUS_PRODUCT_MODE = 'diagnose' as const;
export const PERSONNET_PLUS_AUTO_APPLY = false;

export const PLUS_STEM_C = 12;
export const PLUS_P3_C = 24;
export const PLUS_P4_C = 28;
export const PLUS_P5_C = 28;
export const PLUS_FUSE_C = 16;
export const PLUS_HEAD_C = 5;

export const FORBIDDEN_DATASET_TOKENS = [
  'coco',
  'msmt17',
  'market-1501',
  'market1501',
  'dukemtmc',
  'sportsmot',
  'soccernet',
  'imagenet',
  'crowdhuman',
  'objects365',
  'got-10k',
  'lasot',
  'youtube-bb',
] as const;

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

export function scanForbiddenDatasetText(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_DATASET_TOKENS.filter((token) => lower.includes(token));
}

export function rejectForbiddenManifestHints(
  manifest: PersonNetRightsManifest | null | undefined,
): string[] {
  const hits: string[] = [];
  for (const clip of manifest?.clips ?? []) {
    const blob = [clip.assetId, clip.filePath ?? '', clip.sourceVideoId, clip.owner].join(' ');
    for (const token of scanForbiddenDatasetText(blob)) {
      hits.push(`${clip.assetId}:${token}`);
    }
  }
  return hits;
}

export function gatePersonNetPlus(
  manifest: PersonNetRightsManifest | null | undefined,
  hashes: Readonly<Record<string, string | null>>,
  purpose: GatePurpose,
  looseFiles: readonly string[] = [],
): ReturnType<typeof gateManifest> & { forbiddenHits: string[] } {
  const forbiddenHits = rejectForbiddenManifestHints(manifest);
  const gated = gateManifest(manifest ?? emptyPersonNetRightsManifest(), hashes, purpose, looseFiles);
  if (forbiddenHits.length) {
    return {
      ...gated,
      status: 'BLOCKED',
      admitted: [],
      forbiddenHits,
      issues: [
        ...gated.issues,
        {
          assetId: null,
          code: 'forbidden-dataset-token',
          message: `상업 위험이 있는 외부 데이터 이름이 보입니다: ${forbiddenHits.join(', ')}`,
        },
      ],
    };
  }
  return { ...gated, forbiddenHits };
}

/** v0와 같은 위상, 채널만 넓힌 from-scratch 초기화. */
export function initPersonNetPlusWeights(seed = 3, inW = 96, inH = 160): PersonNetWeights {
  const rng = mulberry(seed);
  const stemW = new Float32Array(PLUS_STEM_C * 3 * 9);
  const stemB = new Float32Array(PLUS_STEM_C);
  const dw3W = new Float32Array(PLUS_STEM_C * 9);
  const dw3B = new Float32Array(PLUS_STEM_C);
  const pw3W = new Float32Array(PLUS_P3_C * PLUS_STEM_C);
  const pw3B = new Float32Array(PLUS_P3_C);
  const dw4W = new Float32Array(PLUS_P3_C * 9);
  const dw4B = new Float32Array(PLUS_P3_C);
  const pw4W = new Float32Array(PLUS_P4_C * PLUS_P3_C);
  const pw4B = new Float32Array(PLUS_P4_C);
  const dw5W = new Float32Array(PLUS_P4_C * 9);
  const dw5B = new Float32Array(PLUS_P4_C);
  const pw5W = new Float32Array(PLUS_P5_C * PLUS_P4_C);
  const pw5B = new Float32Array(PLUS_P5_C);
  const fuse3W = new Float32Array(PLUS_FUSE_C * PLUS_P3_C);
  const fuse3B = new Float32Array(PLUS_FUSE_C);
  const fuse4W = new Float32Array(PLUS_FUSE_C * PLUS_P4_C);
  const fuse4B = new Float32Array(PLUS_FUSE_C);
  const fuse5W = new Float32Array(PLUS_FUSE_C * PLUS_P5_C);
  const fuse5B = new Float32Array(PLUS_FUSE_C);
  const headW = new Float32Array(PLUS_HEAD_C * PLUS_FUSE_C);
  const headB = new Float32Array(PLUS_HEAD_C);
  randnFill(stemW, rng, 0.10);
  randnFill(dw3W, rng, 0.10);
  randnFill(pw3W, rng, 0.10);
  randnFill(dw4W, rng, 0.10);
  randnFill(pw4W, rng, 0.10);
  randnFill(dw5W, rng, 0.10);
  randnFill(pw5W, rng, 0.10);
  randnFill(fuse3W, rng, 0.10);
  randnFill(fuse4W, rng, 0.10);
  randnFill(fuse5W, rng, 0.10);
  randnFill(headW, rng, 0.07);
  headB[0] = -1.8;
  return {
    modelId: PERSONNET_PLUS_MODEL_ID,
    modelVersion: PERSONNET_PLUS_MODEL_VERSION,
    architecture: PERSONNET_PLUS_ARCHITECTURE,
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

export function personNetPlusParamCount(weights: PersonNetWeights): number {
  return personNetParamCount(weights);
}

/** 스포츠 원거리: 납작한 상자는 사람 후보에서 낮춘다. 학습된 사람 확률이 아니다. */
export function preferSportPersonBoxes(boxes: readonly PersonNetBox[]): PersonNetBox[] {
  return boxes
    .map((box) => {
      const ratio = box.height / Math.max(1e-3, box.width);
      const tall = ratio >= 1.35 && ratio <= 4.2;
      const small = box.height < 28;
      const score = box.score * (tall ? 1 : 0.55) * (small ? 0.85 : 1);
      return { ...box, score, small: small || box.small };
    })
    .filter((box) => box.score >= 0.28)
    .sort((a, b) => b.score - a.score);
}

export function trainPersonNetPlus(
  samples: Parameters<typeof trainPersonNet>[0],
  weights: PersonNetWeights,
  options?: Parameters<typeof trainPersonNet>[2],
): { weights: PersonNetWeights; report: PersonNetTrainReport } {
  const trained = trainPersonNet(samples, weights, options);
  return {
    weights: {
      ...trained.weights,
      modelId: PERSONNET_PLUS_MODEL_ID,
      modelVersion: PERSONNET_PLUS_MODEL_VERSION,
      architecture: PERSONNET_PLUS_ARCHITECTURE,
    },
    report: {
      ...trained.report,
      productEligible: false,
      realWorldPrecision: null,
      realWorldRecall: null,
      syntheticOnly: true,
    },
  };
}

export function inferPersonNetPlus(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  weights: PersonNetWeights,
): { boxes: PersonNetBox[]; modelId: string; identityConfirmed: false; eligibleForAutoReacquire: false } {
  const raw = inferPersonNet(rgba, width, height, weights);
  return {
    boxes: preferSportPersonBoxes(raw.boxes),
    modelId: PERSONNET_PLUS_MODEL_ID,
    identityConfirmed: false,
    eligibleForAutoReacquire: false,
  };
}

export function personNetPlusPromotion(input: {
  rightsOk: boolean;
  holdoutCount: number;
  realPrecision: number | null;
  realRecall: number | null;
}): 'BLOCKED' | 'diagnose-only' {
  if (!input.rightsOk || input.holdoutCount <= 0) return 'BLOCKED';
  if (input.realPrecision == null || input.realRecall == null) return 'BLOCKED';
  return 'diagnose-only';
}

export { PERSONNET_RIGHTS_VERSION };
