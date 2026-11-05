/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c56f4fc6 @license @preserve */
/* 외형·공간 소프트 결합.

순위용이다. 가까운 위치만으로 동일인을 확정하지 않는다.
동적 가중합과 감점 전용은 같은 식이 아니다. 둘을 겹쳐 공간을
두 번 넣지 않는다. 공간 정보가 없으면 0점 불일치로 채우지 않고
영향력을 제거한다(w_space=0).
*/

import {
  assessSpatialQuality,
  tableWeights,
  type SpatialQuality,
  type SpatialQualityInput,
  type SpatialSituation,
} from './spatial-quality';

export type FusionMode = 'off' | 'weighted' | 'penalty' | 'fixed-70-30';

export const FUSION_POLICY = Object.freeze({
  lambdaPenalty: 0.30,
  /** 정지·턴에서 방향 단서 최소 속력(몸/초). */
  minSpeedBodiesForHeading: 0.18,
  scoreIsProbability: false as const,
});

export interface SpaceCues {
  /** 불확실성을 넣은 위치 일치 0~1. 높을수록 예측과 가깝다. */
  position: number | null;
  heading: number | null;
  size: number | null;
  exitEntry: number | null;
  headingReliable: boolean;
  sizeReliable: boolean;
}

export interface FusionInput {
  appearance: number | null;
  appearanceObserved: boolean;
  space: SpaceCues | null;
  quality: SpatialQuality;
  mode: FusionMode;
}

export interface FusionResult {
  sAppearance: number | null;
  sSpace: number | null;
  sRank: number | null;
  wAppearance: number;
  wSpace: number;
  situation: SpatialSituation;
  table: { wAppearance: number; wSpace: number };
  mode: FusionMode;
  reason: string;
  hold: boolean;
  scoreIsProbability: false;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function composeSpaceScore(cues: SpaceCues | null, quality: SpatialQuality): number | null {
  if (!cues || !quality.spaceInformative) return null;
  const parts: Array<{ v: number; w: number }> = [];
  if (cues.position != null) parts.push({ v: cues.position, w: 1 });
  if (cues.headingReliable && cues.heading != null) parts.push({ v: cues.heading, w: 0.25 });
  if (cues.sizeReliable && cues.size != null) parts.push({ v: cues.size, w: 0.2 });
  if (cues.exitEntry != null) parts.push({ v: cues.exitEntry, w: 0.15 });
  if (!parts.length) return null;
  let s = 0;
  let w = 0;
  for (const p of parts) {
    s += p.v * p.w;
    w += p.w;
  }
  return clamp01(s / w);
}

export function fuseAppearanceSpace(input: FusionInput): FusionResult {
  const q = input.quality;
  const appearance = input.appearance;
  const table = tableWeights(q.situation);
  const holdBothWeak = !input.appearanceObserved
    || appearance == null
    || (appearance < 0.55 && !q.spaceInformative);
  if (holdBothWeak) {
    return {
      sAppearance: appearance,
      sSpace: null,
      sRank: appearance,
      wAppearance: 1,
      wSpace: 0,
      situation: q.situation,
      table,
      mode: input.mode,
      reason: 'appearance-and-space-weak-hold',
      hold: true,
      scoreIsProbability: false,
    };
  }
  if (input.mode === 'off' || appearance == null) {
    return {
      sAppearance: appearance,
      sSpace: null,
      sRank: appearance,
      wAppearance: 1,
      wSpace: 0,
      situation: q.situation,
      table,
      mode: input.mode,
      reason: 'appearance-only',
      hold: false,
      scoreIsProbability: false,
    };
  }

  const sSpace = composeSpaceScore(input.space, q);
  const omitSpace = sSpace == null || !q.spaceInformative || q.situation === 'G';
  if (omitSpace) {
    return {
      sAppearance: appearance,
      sSpace: null,
      sRank: appearance,
      wAppearance: 1,
      wSpace: 0,
      situation: q.situation,
      table,
      mode: input.mode,
      reason: 'space-omitted',
      hold: false,
      scoreIsProbability: false,
    };
  }

  if (input.mode === 'fixed-70-30') {
    return {
      sAppearance: appearance,
      sSpace,
      sRank: clamp01(0.70 * appearance + 0.30 * sSpace),
      wAppearance: 0.70,
      wSpace: 0.30,
      situation: q.situation,
      table,
      mode: input.mode,
      reason: 'fixed-70-30',
      hold: false,
      scoreIsProbability: false,
    };
  }

  if (input.mode === 'penalty') {
    const sRank = appearance * (1 - FUSION_POLICY.lambdaPenalty * q.rSpace * (1 - sSpace));
    return {
      sAppearance: appearance,
      sSpace,
      sRank: clamp01(sRank),
      wAppearance: 1,
      wSpace: 0,
      situation: q.situation,
      table,
      mode: input.mode,
      reason: 'penalty-only',
      hold: false,
      scoreIsProbability: false,
    };
  }

  const wSpace = q.wSpace;
  const wAppearance = q.wAppearance;
  const sRank = wAppearance * appearance + wSpace * sSpace;
  return {
    sAppearance: appearance,
    sSpace,
    sRank: clamp01(sRank),
    wAppearance,
    wSpace,
    situation: q.situation,
    table,
    mode: input.mode,
    reason: `weighted-${q.situation}`,
    hold: false,
    scoreIsProbability: false,
  };
}

export function spatialCuesFromBoxes(input: {
  predCx: number;
  predCy: number;
  candCx: number;
  candCy: number;
  predW: number;
  predH: number;
  candW: number;
  candH: number;
  d2: number | null;
  inflatedCovariance: boolean;
  dtSec: number;
  cameraDx: number;
  cameraDy: number;
  prevCx: number | null;
  prevCy: number | null;
  turning: boolean;
  zoomLikely: boolean;
  exitEntryPlausible: boolean | null;
}): SpaceCues {
  let position: number | null = null;
  if (input.d2 != null && Number.isFinite(input.d2) && !input.inflatedCovariance) {
    position = Math.exp(-input.d2 / 4);
  } else if (input.d2 != null && input.inflatedCovariance) {
    position = 0.5;
  }
  let heading: number | null = null;
  let headingReliable = false;
  if (input.prevCx != null && input.prevCy != null && input.dtSec > 1e-3) {
    const mvx = (input.candCx - input.prevCx) - input.cameraDx;
    const mvy = (input.candCy - input.prevCy) - input.cameraDy;
    const speedBodies = Math.hypot(mvx, mvy) / Math.max(1, input.candH) / input.dtSec;
    headingReliable = speedBodies >= FUSION_POLICY.minSpeedBodiesForHeading && !input.turning;
    if (headingReliable) {
      const toPredX = input.predCx - (input.prevCx + input.cameraDx);
      const toPredY = input.predCy - (input.prevCy + input.cameraDy);
      const na = Math.hypot(mvx, mvy);
      const nb = Math.hypot(toPredX, toPredY);
      heading = na > 1e-3 && nb > 1e-3
        ? (mvx * toPredX + mvy * toPredY) / (na * nb)
        : null;
      if (heading != null) heading = (heading + 1) / 2;
    }
  }
  const sizeRatio = Math.max(
    input.candW / Math.max(1e-3, input.predW),
    input.predW / Math.max(1e-3, input.candW),
    input.candH / Math.max(1e-3, input.predH),
    input.predH / Math.max(1e-3, input.candH),
  );
  const sizeReliable = !input.zoomLikely;
  const size = sizeReliable ? clamp01(2 - sizeRatio) : null;
  const exitEntry = input.exitEntryPlausible == null ? null : input.exitEntryPlausible ? 1 : 0;
  return {
    position,
    heading,
    size,
    exitEntry,
    headingReliable,
    sizeReliable,
  };
}

export { assessSpatialQuality };
export type { SpatialQuality, SpatialQualityInput, SpatialSituation };
