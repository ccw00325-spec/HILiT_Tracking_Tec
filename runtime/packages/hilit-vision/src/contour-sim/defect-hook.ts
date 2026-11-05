/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·45dba04c @license @preserve */
/* 추적 결함 분류기의 입력을 만든다 (시뮬레이터 연결부).

- 화소 특징(DCT·SVD)은 prepare 단계에서 원본 화소가 RAM 에 있을 때 한 번 계산하고
  숫자만 남긴다. 원본 화소·ROI 는 저장하지 않는다.
- 추적 상태 특징은 runClip 이 프레임마다 넘긴다. 외곽선·HSV·Re-ID 점수는
  "직전 프레임" 값만 쓴다 — 결함 판단이 그 모듈보다 먼저 돌아야 하므로.
- 시간 창 통계는 TimeWindowBuffer 가 timestamp 로 자른다. 미래는 보지 않는다.
*/

import {
  DCT_GLOBAL_SIZE, DCT_ROI_SIZE, SVD_MASK_SIZE, SVD_ROI_SIZE, blockBoundaryRatio, dctQualityFeatures,
  gradientMagnitude, resizeBilinear, resizeNearest, round6, singularValues, spectrumDistance,
  svdFeaturesFromSpectrum, temporalOutlierResidual,
} from '../defect-features';
import { TimeWindowBuffer } from '../defect-window';
import type { ContourMaskInput } from '../contour-feature';

export const DEFECT_SCHEMA_VERSION = 'defect-schema-v1';

/** 프레임 전역 화소 특징 */
export interface FrameDefectPix {
  gHigh: number; gMid: number; gEntropy: number; gHighAtt: number; gBlock: number; gDc: number; gAc: number;
  ms: { dct: number; block: number };
}

/** 탐지 한 개의 ROI 화소 특징 */
export interface DetDefectPix {
  rHigh: number; rMid: number; rEntropy: number; rHighAtt: number; rBlock: number; rHv: number; rAc: number;
  mHigh: number; mEntropy: number; mAc: number;
  sgS1: number; sgEff: number; sgRes: number; sgSlope: number;
  grS1: number; grEff: number; grRes: number;
  msS1: number; msEff: number; msRes: number;
  maskRoiMismatch: number;
  pixReliability: number;
  /** 채점 전용: 생성기 정답 마스크와의 IoU */
  gtMaskIoU: number | null;
  ms: { dct: number; svd: number };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function gray01(gray: Uint8Array): Float64Array {
  const out = new Float64Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = gray[i] / 255;
  return out;
}

export function frameDefectPix(g: Float64Array, w: number, h: number): FrameDefectPix {
  const t0 = now();
  const thumb = resizeBilinear(g, w, h, { x: 0, y: 0, width: w, height: h }, DCT_GLOBAL_SIZE.w, DCT_GLOBAL_SIZE.h);
  const d = dctQualityFeatures(thumb, DCT_GLOBAL_SIZE.w, DCT_GLOBAL_SIZE.h).values;
  const t1 = now();
  // 블록 경계는 원본 격자에서 잰다 (크기를 바꾸면 8화소 격자가 사라진다)
  const block = blockBoundaryRatio(g, w, h, 8, 0, 0);
  const t2 = now();
  return {
    gHigh: d.highRatio, gMid: d.midRatio, gEntropy: d.spectralEntropy, gHighAtt: d.highAttenuation,
    gBlock: round6(block), gDc: d.dcLogEnergy, gAc: d.acLogEnergy,
    ms: { dct: t1 - t0, block: t2 - t1 },
  };
}

export function detDefectPix(g: Float64Array, w: number, h: number, box: { x: number; y: number; width: number; height: number },
  mask: ContourMaskInput | null, gtLabel: Int16Array | null, truthId: number): DetDefectPix {
  const t0 = now();
  const bx = Math.max(0, box.x);
  const by = Math.max(0, box.y);
  const bw = Math.max(2, Math.min(w - bx, box.width));
  const bh = Math.max(2, Math.min(h - by, box.height));
  const rect = { x: bx, y: by, width: bw, height: bh };
  const roi = resizeBilinear(g, w, h, rect, DCT_ROI_SIZE.w, DCT_ROI_SIZE.h);
  const rd = dctQualityFeatures(roi, DCT_ROI_SIZE.w, DCT_ROI_SIZE.h).values;
  // ROI 블록 경계: 원본 좌표 격자, 상자 시작점 오프셋을 맞춘다
  const x0 = Math.floor(bx);
  const y0 = Math.floor(by);
  const cw = Math.max(2, Math.min(w - x0, Math.round(bw)));
  const ch = Math.max(2, Math.min(h - y0, Math.round(bh)));
  const crop = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) crop[y * cw + x] = g[(y0 + y) * w + x0 + x];
  const rBlock = blockBoundaryRatio(crop, cw, ch, 8, x0 % 8, y0 % 8);
  // 마스크를 ROI 격자로 (마스크 격자 좌표계로 바꿔 최근접)
  let maskRoi: Float64Array | null = null;
  let maskSmall: Float64Array | null = null;
  if (mask) {
    const mr = { x: (bx - mask.frameX) / mask.scale, y: (by - mask.frameY) / mask.scale, width: bw / mask.scale, height: bh / mask.scale };
    maskRoi = resizeNearest(mask.data, mask.width, mask.height, mr, DCT_ROI_SIZE.w, DCT_ROI_SIZE.h);
    maskSmall = resizeNearest(mask.data, mask.width, mask.height, mr, SVD_MASK_SIZE.w, SVD_MASK_SIZE.h);
  }
  const md = maskRoi ? dctQualityFeatures(roi, DCT_ROI_SIZE.w, DCT_ROI_SIZE.h, { mask: maskRoi }).values : null;
  const t1 = now();
  const small = resizeBilinear(g, w, h, rect, SVD_ROI_SIZE.w, SVD_ROI_SIZE.h);
  const sgSpec = singularValues(small, SVD_ROI_SIZE.h, SVD_ROI_SIZE.w);
  const sg = svdFeaturesFromSpectrum(sgSpec).values;
  const gr = svdFeaturesFromSpectrum(singularValues(gradientMagnitude(small, SVD_ROI_SIZE.w, SVD_ROI_SIZE.h), SVD_ROI_SIZE.h, SVD_ROI_SIZE.w)).values;
  let msSpec: Float64Array | null = null;
  if (maskSmall) msSpec = singularValues(maskSmall, SVD_MASK_SIZE.h, SVD_MASK_SIZE.w);
  const msv = svdFeaturesFromSpectrum(msSpec).values;
  const t2 = now();
  // 채점 전용 GT 마스크 IoU (특징에 들어가지 않는다)
  let gtMaskIoU: number | null = null;
  if (mask && gtLabel) {
    let inter = 0;
    let a = 0;
    let b = 0;
    for (let y = 0; y < mask.height; y += 1) {
      for (let x = 0; x < mask.width; x += 1) {
        const fx = Math.min(w - 1, Math.floor(mask.frameX + (x + 0.5) * mask.scale));
        const fy = Math.min(h - 1, Math.floor(mask.frameY + (y + 0.5) * mask.scale));
        const gt = gtLabel[fy * w + fx] === truthId ? 1 : 0;
        const pr = mask.data[y * mask.width + x] ? 1 : 0;
        inter += gt & pr;
        a += pr;
        b += gt;
      }
    }
    gtMaskIoU = a + b - inter > 0 ? inter / (a + b - inter) : null;
  }
  const valid = Number.isFinite(rd.highRatio) && Number.isFinite(sg.s1Energy);
  return {
    rHigh: rd.highRatio, rMid: rd.midRatio, rEntropy: rd.spectralEntropy, rHighAtt: rd.highAttenuation,
    rBlock: round6(rBlock), rHv: rd.hvAsymmetry, rAc: rd.acLogEnergy,
    mHigh: md?.highRatio ?? Number.NaN, mEntropy: md?.spectralEntropy ?? Number.NaN, mAc: md?.acLogEnergy ?? Number.NaN,
    sgS1: sg.s1Energy, sgEff: sg.effectiveRank, sgRes: sg.lowRankResidual, sgSlope: sg.spectrumSlope,
    grS1: gr.s1Energy, grEff: gr.effectiveRank, grRes: gr.lowRankResidual,
    msS1: msv.s1Energy, msEff: msv.effectiveRank, msRes: msv.lowRankResidual,
    maskRoiMismatch: spectrumDistance(sgSpec, msSpec),
    pixReliability: valid ? 1 : 0,
    gtMaskIoU,
    ms: { dct: t1 - t0, svd: t2 - t1 },
  };
}

/* ---------- 특징 순서 (schema) ---------- */

export const DCT_FEATURES = [
  'gHigh', 'gMid', 'gEntropy', 'gHighAtt', 'gBlock', 'gDc', 'gAc',
  'rHigh', 'rMid', 'rEntropy', 'rHighAtt', 'rBlock', 'rHv', 'rAc',
  'mHigh', 'mEntropy', 'mAc',
] as const;
export const SVD_FEATURES = [
  'sgS1', 'sgEff', 'sgRes', 'sgSlope', 'grS1', 'grEff', 'grRes', 'msS1', 'msEff', 'msRes', 'maskRoiMismatch',
] as const;
export const TRACK_FEATURES = [
  'detConf', 'detRelHeight', 'gapFrames', 'gatedCount', 'motionD2Log', 'covStdBodies', 'speedChangeBodies',
  'gmcOk', 'gmcInlierRatio', 'gmcGridCells', 'gmcResidualP90', 'gmcRival', 'gmcTranslation', 'gmcDeltaPrev',
  'maskQuality', 'visibleRatio', 'contactRatio', 'maskAreaToBox', 'componentCount',
  'prevContourScore', 'prevHsvScore', 'prevAppScore', 'prevAppMargin', 'sinceReidSec', 'gallerySize',
  'candMargin', 'recentSwitches', 'crowdFlag', 'trackAgeSec', 'tentativeFlag',
] as const;
/** 시간 창에 넣는 핵심 특징 */
export const TEMPORAL_KEYS = ['gHigh', 'rHigh', 'rAc', 'sgS1', 'detConf', 'motionD2Log', 'gmcResidualP90', 'maskQuality'] as const;
export const TEMPORAL_WINDOWS = [0.5, 1.0] as const;
export const TEMPORAL_STATS = ['mean', 'std', 'slope', 'lastMinusMean'] as const;

export const BASE_FEATURES = [...DCT_FEATURES, ...SVD_FEATURES, ...TRACK_FEATURES] as const;
export const TEMPORAL_FEATURES: string[] = [];
for (const w of TEMPORAL_WINDOWS) for (const k of TEMPORAL_KEYS) for (const s of TEMPORAL_STATS) TEMPORAL_FEATURES.push(`${k}@${w}s.${s}`);
TEMPORAL_FEATURES.push('temporalOutlierResidual@1s');

export const DEFECT_FEATURE_ORDER: readonly string[] = Object.freeze([...BASE_FEATURES, ...TEMPORAL_FEATURES]);

export type FeatureGroup = 'dct' | 'svd' | 'track' | 'temporal';
export function featureGroupOf(name: string): FeatureGroup {
  if ((DCT_FEATURES as readonly string[]).includes(name)) return 'dct';
  if ((SVD_FEATURES as readonly string[]).includes(name)) return 'svd';
  if ((TRACK_FEATURES as readonly string[]).includes(name)) return 'track';
  return 'temporal';
}

export type TrackState = Record<typeof TRACK_FEATURES[number], number>;

/** 프레임마다 base 특징을 받아 시간 창 통계를 붙인다. */
export class DefectFeatureAssembler {
  private readonly buf = new TimeWindowBuffer(TEMPORAL_KEYS.length, 2.5);
  private readonly keyIdx = TEMPORAL_KEYS.map((k) => (BASE_FEATURES as readonly string[]).indexOf(k));

  assemble(tSec: number, frame: FrameDefectPix | null, det: DetDefectPix | null, track: TrackState): { vector: Float64Array; reliability: number; ms: number } {
    const t0 = now();
    const base: number[] = [];
    const fp = frame as unknown as Record<string, number> | null;
    const dp = det as unknown as Record<string, number> | null;
    for (const k of DCT_FEATURES) base.push(k.startsWith('g') ? (fp ? fp[k] : Number.NaN) : (dp ? dp[k] : Number.NaN));
    for (const k of SVD_FEATURES) base.push(dp ? dp[k] : Number.NaN);
    for (const k of TRACK_FEATURES) base.push(track[k]);
    this.buf.push(tSec, this.keyIdx.map((i) => base[i]));
    const temporal: number[] = [];
    for (const w of TEMPORAL_WINDOWS) {
      for (let c = 0; c < TEMPORAL_KEYS.length; c += 1) {
        const st = this.buf.stat(tSec, w, c);
        for (const s of TEMPORAL_STATS) temporal.push(st[s]);
      }
    }
    temporal.push(temporalOutlierResidual(this.buf.matrix(tSec, 1.0)));
    const vector = Float64Array.from([...base, ...temporal]);
    const reliability = det ? det.pixReliability : 0.5;
    return { vector, reliability, ms: now() - t0 };
  }
}
