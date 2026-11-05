/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·35957e07 @license @preserve */
/* 운동 추적과 무거운 Re-ID 사이의 단기 연속성 검증기.

외곽선(contour-feature)과 HSV(hsv-aux)는 각자 점수를 내고, 여기서
신뢰도로 가중해 후단에서만 합친다. 원시 벡터를 이어 붙이지 않는다.

이 검증기가 하는 일
  - 같은 트랙이 몇 프레임 동안 자연스럽게 이어지는지 확인한다.
  - 명백히 다른 후보를 감점한다 (지우지는 않는다 — retainCompetingCandidates).
  - 무거운 Re-ID 가 필요한 순간을 고르거나, 필요 없는 저위험 점검을 건너뛴다.

이 검증기가 하지 않는 일
  - 외곽선·HSV 로 신원을 확정하지 않는다.
  - 외곽선·HSV 로 갤러리를 갱신하지 않는다 (galleryUpdateAllowed 는 항상 false).
  - 외곽선 불일치 한 번으로 ID 를 바꾸지 않는다.
  - 자동 재획득을 켜지 않는다.

shadow 모드(기본)에서는 가상 결정만 기록하고 실제 스케줄러 결정은 그대로 둔다.
*/

import {
  computeMaskQuality,
  contourDistance,
  contourReliability,
  type ContourDistanceMethod,
  type ContourFeature,
  type ContourSport,
  type MaskQuality,
} from './contour-feature';
import type { SchedulerDecision, ReidCallReason } from './reid-scheduler';

/* ---------- 15장: 플래그 ---------- */

export interface ContourContinuityFlags {
  enableContourContinuity: boolean;
  contourShadowMode: boolean;
  contourSampleCount: 32 | 48 | 64;
  /** 1 = 원본, 0.5 = 1/2, 0.25 = 1/4 */
  contourMaskScale: 1 | 0.5 | 0.25;
  contourSmoothingStrength: number;
  contourMinMaskQuality: number;
  contourMinVisibleRatio: number;
  contourMinObjectSize: number;
  contourMaxOcclusionRatio: number;
  contourDistanceMethod: ContourDistanceMethod;
  contourMemoryMs: number;
  contourMaxPrototypes: number;
  /** 0 = 상황별 동적, 그 외 고정 확정 프레임 수 */
  contourMultiFrameConfirmation: number;
  enableContourHsvFusion: boolean;
  enableContourGalleryGate: boolean;
  preventGalleryUpdateFromContourOnly: true;
  disableContourDuringCrowdCrossing: boolean;
  enableGmcCorrectedContour: boolean;
  excludeObjectMaskFromGmc: boolean;
  fallbackToExistingAssociation: true;
  /** 자동 재획득. 이 모듈은 절대 켜지 않는다. */
  autoReacquire: false;
}

export const CONTOUR_CONTINUITY_DEFAULTS: Readonly<ContourContinuityFlags> = Object.freeze({
  enableContourContinuity: false,
  contourShadowMode: true,
  contourSampleCount: 48,
  contourMaskScale: 0.5,
  contourSmoothingStrength: 1,
  contourMinMaskQuality: 0.45,
  contourMinVisibleRatio: 0.55,
  contourMinObjectSize: 32,
  contourMaxOcclusionRatio: 0.4,
  contourDistanceMethod: 'trimmed-chamfer',
  contourMemoryMs: 1000,
  contourMaxPrototypes: 3,
  contourMultiFrameConfirmation: 3,
  enableContourHsvFusion: true,
  enableContourGalleryGate: true,
  preventGalleryUpdateFromContourOnly: true,
  disableContourDuringCrowdCrossing: true,
  enableGmcCorrectedContour: true,
  excludeObjectMaskFromGmc: true,
  fallbackToExistingAssociation: true,
  autoReacquire: false,
});

/** 외곽선이 실제 결정에 손을 댈 수 있는가. 둘 중 하나라도 아니면 기존 경로 그대로. */
export function contourAffectsDecisions(flags: ContourContinuityFlags): boolean {
  return flags.enableContourContinuity && !flags.contourShadowMode;
}

/* ---------- 14장: 단기 외곽선 메모리 ---------- */

export interface ContourPrototype {
  tMs: number;
  contour: ContourFeature;
  hsv: unknown | null;
  quality: number;
}

export interface PrototypeAdmitInput {
  trackingConfidence: number;
  maskQuality: number;
  crowdCrossing: boolean;
  occluded: boolean;
  switchRiskLow: boolean;
  gmcConfidence: number;
  /** 잠정 후보·오답 후보에서 온 외곽선이면 true — 절대 대표표본에 넣지 않는다 */
  tentative: boolean;
}

export const PROTOTYPE_ADMIT = Object.freeze({
  minTrackingConfidence: 0.6,
  minMaskQuality: 0.55,
  minGmcConfidence: 0.5,
  /** 기존 표본과 이 점수 이상 같으면 중복으로 보고 시간만 갱신 */
  duplicateScore: 0.93,
});

/**
 * 트랙 하나의 단기 외곽선 메모리. RAM 에만 있다. 이미지를 저장하지 않는다.
 * 장기 신원 갤러리가 아니다 — contourMemoryMs 가 지나면 영향이 사라진다.
 */
export class ContourShortTermMemory {
  private protos: ContourPrototype[] = [];
  /**
   * @param memoryMs 표본 창. 가장 최근 표본보다 이만큼 오래된 표본은 버린다.
   * @param maxPrototypes 표본 최대 수.
   * @param maxGapMs 마지막 표본 이후 이만큼 넘게 갱신이 없으면 메모리 전체를 버린다.
   *   예측기가 관측 없이 버티는 한계(1.2초)와 맞춘다. 창을 "지금" 기준으로만 재면
   *   짧은 가림 동안 메모리가 사라져, 정작 가림 직후에 근거가 없다.
   */
  constructor(
    private readonly memoryMs: number,
    private readonly maxPrototypes: number,
    private readonly maxGapMs = 1200,
  ) {}

  prune(nowMs: number): void {
    if (!this.protos.length) return;
    const newest = this.protos[this.protos.length - 1].tMs;
    if (nowMs - newest > this.maxGapMs) {
      this.protos = [];
      return;
    }
    this.protos = this.protos.filter((p) => newest - p.tMs <= this.memoryMs);
  }

  /** 오래된 표본일수록 가중이 줄어든다 (15번 안전장치). */
  ageWeight(p: ContourPrototype, nowMs: number): number {
    const age = Math.max(0, nowMs - p.tMs);
    return Math.max(0, 1 - age / Math.max(1, this.memoryMs + this.maxGapMs));
  }

  get size(): number {
    return this.protos.length;
  }

  list(nowMs: number): ContourPrototype[] {
    this.prune(nowMs);
    return this.protos.slice();
  }

  latest(nowMs: number): ContourPrototype | null {
    this.prune(nowMs);
    return this.protos.length ? this.protos[this.protos.length - 1] : null;
  }

  admissionBlockers(input: PrototypeAdmitInput): string[] {
    const out: string[] = [];
    if (input.tentative) out.push('tentative-candidate');
    if (input.trackingConfidence < PROTOTYPE_ADMIT.minTrackingConfidence) out.push('tracking-confidence');
    if (input.maskQuality < PROTOTYPE_ADMIT.minMaskQuality) out.push('mask-quality');
    if (input.crowdCrossing) out.push('crowd-crossing');
    if (input.occluded) out.push('occluded');
    if (!input.switchRiskLow) out.push('switch-risk');
    if (input.gmcConfidence < PROTOTYPE_ADMIT.minGmcConfidence) out.push('gmc-confidence');
    return out;
  }

  /** 조건을 모두 통과할 때만 넣는다. 돌려주는 값은 넣었는지와 막은 사유. */
  admit(nowMs: number, contour: ContourFeature, hsv: unknown | null, input: PrototypeAdmitInput,
    opts: { method?: ContourDistanceMethod; sport?: ContourSport } = {}): { admitted: boolean; blockers: string[] } {
    const blockers = this.admissionBlockers(input);
    if (blockers.length) return { admitted: false, blockers };
    this.prune(nowMs);
    const last = this.protos[this.protos.length - 1];
    if (last) {
      const d = contourDistance(contour, last.contour, { method: opts.method, sport: opts.sport });
      if (Number.isFinite(d.score) && d.score >= PROTOTYPE_ADMIT.duplicateScore) {
        // 중복: 최신 표본을 교체해 시간만 앞당긴다
        this.protos[this.protos.length - 1] = { tMs: nowMs, contour, hsv, quality: input.maskQuality };
        return { admitted: true, blockers: [] };
      }
    }
    this.protos.push({ tMs: nowMs, contour, hsv, quality: input.maskQuality });
    while (this.protos.length > this.maxPrototypes) this.protos.shift();
    return { admitted: true, blockers: [] };
  }

  clear(): void {
    this.protos = [];
  }
}

/* ---------- 9장: 후단 점수 결합 ---------- */

export interface CueScore {
  score: number | null;
  reliability: number;
}

export interface LightCues {
  motion: CueScore;
  spatial: CueScore;
  contour: CueScore;
  hsv: CueScore;
}

export interface FusionContext {
  crowdCrossing: boolean;
  lightingChanged: boolean;
  smallObject: boolean;
  fastPoseChange: boolean;
  gmcConfidence: number;
  sameUniformLikely: boolean;
  cameraStable: boolean;
}

export interface FusionWeights {
  motion: number;
  spatial: number;
  contour: number;
  hsv: number;
}

export const BASE_FUSION_WEIGHTS: Readonly<FusionWeights> = Object.freeze({
  motion: 0.35,
  spatial: 0.2,
  contour: 0.3,
  hsv: 0.15,
});

/** 상황별 가중 (9장 1~7). 한 벌의 고정 가중치를 모든 장면에 쓰지 않는다. */
export function situationalWeights(base: FusionWeights, ctx: FusionContext): FusionWeights {
  const w = { ...base };
  if (ctx.cameraStable && ctx.gmcConfidence >= 0.7) {
    w.motion *= 1.15;
    w.contour *= 1.1;
  }
  if (ctx.lightingChanged) w.hsv *= 0.3;
  if (ctx.crowdCrossing) {
    w.contour *= 0.4;
    w.hsv *= 0.4;
  }
  if (ctx.smallObject) w.contour *= 0.6;
  if (ctx.fastPoseChange) w.contour *= 0.7;
  if (ctx.gmcConfidence < 0.5) {
    const k = 0.4 + ctx.gmcConfidence;
    w.motion *= k;
    w.spatial *= k;
  }
  if (ctx.sameUniformLikely) w.hsv *= 0.25;
  return w;
}

export interface FusedScore {
  score: number | null;
  /** 실제로 결합에 들어간 가중·신뢰도 질량 */
  evidenceMass: number;
  used: Array<keyof LightCues>;
}

/**
 * S_light = Σ wᵢ·rᵢ·sᵢ / Σ wᵢ·rᵢ. 점수가 없거나 신뢰도 0 인 항목은 분자·분모에서 뺀다.
 * 외곽선 벡터와 HSV 벡터는 여기 들어오지 않는다 — 점수만 들어온다.
 */
export function fuseLightScores(cues: LightCues, weights: FusionWeights, enableHsv: boolean): FusedScore {
  let num = 0;
  let den = 0;
  const used: Array<keyof LightCues> = [];
  for (const key of ['motion', 'spatial', 'contour', 'hsv'] as const) {
    if (key === 'hsv' && !enableHsv) continue;
    const c = cues[key];
    if (c.score == null || !Number.isFinite(c.score) || c.reliability <= 0) continue;
    const wr = weights[key] * Math.min(1, c.reliability);
    num += wr * c.score;
    den += wr;
    used.push(key);
  }
  return { score: den > 0 ? num / den : null, evidenceMass: den, used };
}

/* ---------- 12장: 상태 전이 ---------- */

export type ContinuityTier = 'A-high' | 'B-medium' | 'C-low';

export interface TierThresholds {
  highScore: number;
  highMargin: number;
  mediumScore: number;
  contourAgree: number;
  contourConflict: number;
  hsvConflict: number;
}

/** 세 가지 운용 설정. 값은 합성 검증 세트에서 고른다 — 제품 기본값으로 확정하지 않는다. */
export const CONTOUR_OPERATING_POINTS: Readonly<Record<'safety' | 'balanced' | 'performance', TierThresholds>> = Object.freeze({
  safety: { highScore: 0.8, highMargin: 0.25, mediumScore: 0.55, contourAgree: 0.6, contourConflict: 0.25, hsvConflict: 0.4 },
  balanced: { highScore: 0.72, highMargin: 0.18, mediumScore: 0.5, contourAgree: 0.5, contourConflict: 0.2, hsvConflict: 0.35 },
  performance: { highScore: 0.62, highMargin: 0.1, mediumScore: 0.45, contourAgree: 0.4, contourConflict: 0.15, hsvConflict: 0.3 },
});

export interface CandidateCues {
  candidateId: string;
  cues: LightCues;
}

export interface ContinuityInput {
  tMs: number;
  candidates: CandidateCues[];
  context: FusionContext;
  /** 가림 직후 첫 프레임 */
  firstFrameAfterOcclusion: boolean;
  /** 화면 밖에서 돌아온 직후 */
  reentry: boolean;
  /** 긴 가림 뒤 */
  longOcclusion: boolean;
}

export interface ContinuityVerdict {
  tier: ContinuityTier;
  bestCandidateId: string | null;
  bestScore: number | null;
  margin: number | null;
  /** 명백히 다른 후보 — 감점 대상. 지우지 않는다. */
  demoted: string[];
  /** 무거운 Re-ID 를 건너뛰어도 되는가 (저위험 점검에만 적용) */
  maySkipHeavyReid: boolean;
  /** 무거운 Re-ID 를 요청하는가 (충돌·고위험) */
  requestHeavyReid: boolean;
  /** 확정 보류 */
  holdConfirmation: boolean;
  /** 외곽선·HSV 로는 절대 true 가 되지 않는다 */
  galleryUpdateAllowed: false;
  identityChangeAllowed: false;
  reacquireConfirmed: false;
  reasons: string[];
  consecutiveHigh: number;
}

/**
 * 트랙 하나의 연속성 판정. 한 프레임 결과로 상태를 올리지 않는다(히스테리시스).
 */
/** 충돌로 무거운 Re-ID 를 요청한 뒤 다음 요청까지의 최소 간격. */
export const REQUEST_COOLDOWN_MS = 300;

export class ContinuityJudge {
  private consecutiveHigh = 0;
  private lastBest: string | null = null;
  private lastRequestMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly thresholds: TierThresholds,
    private readonly flags: ContourContinuityFlags,
  ) {}

  /** 상황별 확정 프레임 수. 1 프레임은 위험 기준선으로만 쓴다. */
  requiredFrames(ctx: FusionContext): number {
    const fixed = this.flags.contourMultiFrameConfirmation;
    if (fixed > 0) return fixed;
    let n = 2;
    if (ctx.gmcConfidence < 0.6 || ctx.smallObject) n += 1;
    if (ctx.fastPoseChange || ctx.lightingChanged) n += 1;
    return n;
  }

  reset(): void {
    this.consecutiveHigh = 0;
    this.lastBest = null;
    this.lastRequestMs = Number.NEGATIVE_INFINITY;
  }

  judge(input: ContinuityInput): ContinuityVerdict {
    const ctx = input.context;
    const reasons: string[] = [];
    const baseW = situationalWeights(BASE_FUSION_WEIGHTS, ctx);
    const crowdOff = ctx.crowdCrossing && this.flags.disableContourDuringCrowdCrossing;

    const rows = input.candidates.map((c) => {
      const cues: LightCues = crowdOff
        ? { ...c.cues, contour: { score: c.cues.contour.score, reliability: 0 } }
        : c.cues;
      return { id: c.candidateId, cues, fused: fuseLightScores(cues, baseW, this.flags.enableContourHsvFusion) };
    });

    // 명백히 다른 후보: 서로 독립인 신호(외곽선·HSV·운동) 중 둘 이상이 믿을 만하게
    // 불일치할 때만. 한 신호만으로는 빼지 않는다. 군중 교차 중에는 빼지 않는다.
    // 후보가 하나뿐이면 빼지 않는다 — 그건 "다른 후보 제거" 가 아니라 대상 거절이다.
    const demoted: string[] = [];
    if (!ctx.crowdCrossing && rows.length > 1) {
      for (const r of rows) {
        const cs = r.cues.contour;
        const hs = r.cues.hsv;
        const ms = r.cues.motion;
        const contourBad = cs.score != null && cs.reliability >= 0.3 && cs.score < this.thresholds.contourConflict;
        const hsvBad = this.flags.enableContourHsvFusion
          && hs.score != null && hs.reliability >= 0.3 && hs.score < this.thresholds.hsvConflict
          && !ctx.sameUniformLikely && !ctx.lightingChanged;
        const motionBad = ms.score != null && ms.reliability >= 0.5 && ms.score < 0.15 && ctx.gmcConfidence >= 0.5;
        if (Number(contourBad) + Number(hsvBad) + Number(motionBad) >= 2) demoted.push(r.id);
      }
    }

    const ranked = rows
      .filter((r) => r.fused.score != null)
      .sort((a, b) => (b.fused.score as number) - (a.fused.score as number));
    const best = ranked[0] ?? null;
    const second = ranked[1] ?? null;
    const bestScore = best ? (best.fused.score as number) : null;
    const margin = best ? (second ? bestScore! - (second.fused.score as number) : 1) : null;

    let tier: ContinuityTier = 'C-low';
    if (best) {
      const bc = best.cues;
      const motionOk = bc.motion.score != null && bc.motion.score >= 0.5;
      const contourUsable = bc.contour.score != null && bc.contour.reliability >= 0.3;
      const contourOk = contourUsable && (bc.contour.score as number) >= this.thresholds.contourAgree;
      const contourConflict = contourUsable && (bc.contour.score as number) < this.thresholds.contourConflict;
      const hsvConflict = this.flags.enableContourHsvFusion
        && bc.hsv.score != null && bc.hsv.reliability >= 0.3
        && bc.hsv.score < this.thresholds.hsvConflict && !ctx.sameUniformLikely;
      const cuesDisagree = motionOk && (contourConflict || hsvConflict);

      const highRisk = ctx.crowdCrossing || input.longOcclusion || input.reentry
        || ctx.gmcConfidence < 0.35 || (margin != null && margin < 0.05 && ranked.length > 1)
        || (ctx.sameUniformLikely && ranked.length > 1);
      if (highRisk) reasons.push('high-risk-context');
      if (cuesDisagree) reasons.push('cues-disagree');

      if (!highRisk && !cuesDisagree && motionOk && contourOk
        && bestScore! >= this.thresholds.highScore
        && (margin ?? 0) >= this.thresholds.highMargin) {
        tier = 'A-high';
      } else if (!highRisk && bestScore! >= this.thresholds.mediumScore) {
        tier = 'B-medium';
      } else {
        tier = 'C-low';
      }
    } else {
      reasons.push('no-scorable-candidate');
    }

    // 가림 직후 첫 프레임은 높은 신뢰로 올리지 않는다
    if (input.firstFrameAfterOcclusion && tier === 'A-high') {
      tier = 'B-medium';
      reasons.push('first-frame-after-occlusion');
    }

    // 다중 프레임 히스테리시스: 같은 후보가 연속으로 A 여야 건너뛰기를 허락한다
    if (tier === 'A-high' && best && best.id === this.lastBest) this.consecutiveHigh += 1;
    else if (tier === 'A-high' && best) this.consecutiveHigh = 1;
    else this.consecutiveHigh = 0;
    this.lastBest = best ? best.id : null;
    const need = this.requiredFrames(ctx);
    const confirmed = tier === 'A-high' && this.consecutiveHigh >= need;
    if (tier === 'A-high' && !confirmed) reasons.push(`hysteresis-${this.consecutiveHigh}/${need}`);

    // 요청은 신호가 실제로 충돌할 때만. 고위험 상황 자체는 스케줄러 트리거가 이미 맡는다.
    // 연달아 요청하지 않는다(REQUEST_COOLDOWN_MS).
    let requestHeavyReid = tier === 'C-low' && best != null && reasons.includes('cues-disagree')
      && input.tMs - this.lastRequestMs >= REQUEST_COOLDOWN_MS;
    if (requestHeavyReid) this.lastRequestMs = input.tMs;
    if (!Number.isFinite(input.tMs)) requestHeavyReid = false;

    return {
      tier,
      bestCandidateId: best ? best.id : null,
      bestScore,
      margin,
      demoted,
      maySkipHeavyReid: confirmed,
      requestHeavyReid,
      holdConfirmation: tier !== 'A-high' || !confirmed,
      galleryUpdateAllowed: false,
      identityChangeAllowed: false,
      reacquireConfirmed: false,
      reasons,
      consecutiveHigh: this.consecutiveHigh,
    };
  }
}

/* ---------- 외곽선 점수 산출 (메모리 대비) ---------- */

export interface ContourCueInput {
  current: ContourFeature;
  quality: MaskQuality;
  memory: ContourShortTermMemory;
  nowMs: number;
  flags: ContourContinuityFlags;
  sport?: ContourSport;
  smallObject?: boolean;
  fastPoseChange?: boolean;
}

/** 메모리의 표본들과 비교해 가장 가까운 것을 쓰되, 표본 나이만큼 신뢰도를 깎는다. */
export function contourCue(input: ContourCueInput): CueScore & { distance: ReturnType<typeof contourDistance> | null; gated: string | null } {
  const { flags, current, quality } = input;
  const g = current.global;
  if (quality.quality < flags.contourMinMaskQuality) return { score: null, reliability: 0, distance: null, gated: 'mask-quality' };
  if (quality.blockers.length) return { score: null, reliability: 0, distance: null, gated: quality.blockers[0] };
  if (g.visibleRatio < flags.contourMinVisibleRatio) return { score: null, reliability: 0, distance: null, gated: 'visible-ratio' };
  if (g.occludedRatio + g.contactRatio > flags.contourMaxOcclusionRatio) return { score: null, reliability: 0, distance: null, gated: 'occlusion' };
  if (g.height < flags.contourMinObjectSize * 0.5) return { score: null, reliability: 0, distance: null, gated: 'too-small' };
  const protos = input.memory.list(input.nowMs);
  if (!protos.length) return { score: null, reliability: 0, distance: null, gated: 'no-prototype' };
  const disableCurvature = input.smallObject === true || input.fastPoseChange === true
    || g.height < flags.contourMinObjectSize;
  let best: { s: number; rel: number; d: ReturnType<typeof contourDistance> } | null = null;
  for (const p of protos) {
    const d = contourDistance(current, p.contour, {
      method: flags.contourDistanceMethod,
      sport: input.sport,
      disableCurvature,
    });
    if (!Number.isFinite(d.score)) continue;
    const age = input.memory.ageWeight(p, input.nowMs);
    const rel = contourReliability(current, quality) * Math.min(1, d.usedRatio / 0.6) * (0.5 + 0.5 * age);
    if (!best || d.score > best.s) best = { s: d.score, rel, d };
  }
  if (!best) return { score: null, reliability: 0, distance: null, gated: 'no-overlap' };
  return { score: best.s, reliability: best.rel, distance: best.d, gated: null };
}

export function maskQualityFor(current: ContourFeature, detConfidence: number,
  box: { x: number; y: number; width: number; height: number }, memory: ContourShortTermMemory,
  nowMs: number, flags: ContourContinuityFlags, blur = 0): MaskQuality {
  const prev = memory.latest(nowMs);
  return computeMaskQuality(current, {
    detConfidence,
    box,
    previous: prev ? prev.contour : null,
    blur,
    minObjectSize: flags.contourMinObjectSize,
  });
}

/* ---------- 10장: 스케줄러 결정에 붙이기 ---------- */

/** 외곽선으로 건너뛸 수 있는 사유. 급한 사유·경쟁 사유는 여기 없다. */
const SKIPPABLE: ReadonlySet<ReidCallReason> = new Set(['stable_low_freq', 'fixed_period']);

export interface ContourSchedulerOutcome {
  decision: SchedulerDecision;
  /** shadow 에서 "켰다면 이렇게 했을 것" */
  virtual: { skipped: boolean; requested: boolean };
  applied: boolean;
  note: string;
}

/**
 * 스케줄러 결정에 외곽선 판정을 붙인다.
 *
 *  - shadow 또는 비활성: 결정을 그대로 돌려준다(객체 동일성까지 유지). 가상 결정만 기록.
 *  - 활성: 저위험 주기 점검만 건너뛸 수 있다. 사용자 확인·재진입·급변·경쟁·위험
 *    상태에서는 절대 건너뛰지 않는다. 충돌이면 추출을 요청할 수 있다.
 *  - 갤러리 편입(admitInspect)은 외곽선이 켜 주지 않는다.
 */
export function applyContourToScheduler(
  decision: SchedulerDecision,
  verdict: ContinuityVerdict | null,
  flags: ContourContinuityFlags,
): ContourSchedulerOutcome {
  if (!verdict) {
    return { decision, virtual: { skipped: false, requested: false }, applied: false, note: 'no-verdict-fallback' };
  }
  const onlySkippable = decision.extract && decision.reasons.length > 0
    && decision.reasons.every((r) => SKIPPABLE.has(r));
  const lowRisk = decision.switchRisk === 'none';
  const wouldSkip = verdict.maySkipHeavyReid && onlySkippable && lowRisk;
  const wouldRequest = verdict.requestHeavyReid && !decision.extract
    && decision.skip !== 'no_valid_crop' && decision.skip !== 'full_occlusion' && decision.skip !== 'severe_blur';
  const virtual = { skipped: wouldSkip, requested: wouldRequest };
  if (!contourAffectsDecisions(flags)) {
    return { decision, virtual, applied: false, note: flags.enableContourContinuity ? 'shadow' : 'disabled' };
  }
  if (wouldSkip) {
    return {
      decision: {
        ...decision,
        extract: false,
        compare: false,
        rerank: false,
        admitInspect: false,
        measuredFresh: false,
        skip: 'not_due',
        skipDetail: 'contour-continuity-high',
      },
      virtual,
      applied: true,
      note: 'skipped-low-risk-check',
    };
  }
  if (wouldRequest) {
    return {
      decision: {
        ...decision,
        extract: true,
        compare: true,
        // 요청으로 뽑은 특징은 갤러리에 넣지 않는다 — 충돌 구간이다
        admitInspect: false,
        measuredFresh: true,
        reasons: [...decision.reasons, 'track_drift_suspect'],
        skip: null,
        skipDetail: 'contour-continuity-conflict',
        holdJudgment: true,
      },
      virtual,
      applied: true,
      note: 'requested-heavy-reid',
    };
  }
  return { decision, virtual, applied: false, note: 'unchanged' };
}

const URGENT_REASONS: ReadonlySet<ReidCallReason> = new Set(['user_confirm', 'surprise_move', 'reentry_after_occlusion']);

export interface ConditionalReidInput {
  /** 감점 후보를 뺀 뒤 남은 후보 수 */
  effectiveCandidates: number;
  /** 최근 검증된 embedding 으로 재정렬한 1·2위 차. 못 했으면 null */
  cachedMargin: number | null;
}

/** 캐시 재정렬 1·2위 차가 이 이상이면 "갤러리/Jaccard 단계에서 풀렸다" 로 본다. */
export const CACHED_RESOLVE_MARGIN = 0.12;

/**
 * A5: 경량 단계로 풀리지 않을 때만 무거운 Re-ID 를 돌린다.
 *
 * 사용자 확인·급변·가림 뒤 재진입은 무조건 돌린다. switch-risk 가 elevated/ask
 * 이면 건너뛰지 않는다. 경량 판정이 충돌하면(C 등급) 오히려 요청한다.
 */
export function conditionalHeavyReid(
  decision: SchedulerDecision,
  verdict: ContinuityVerdict | null,
  flags: ContourContinuityFlags,
  input: ConditionalReidInput,
): ContourSchedulerOutcome {
  if (!verdict) {
    return { decision, virtual: { skipped: false, requested: false }, applied: false, note: 'no-verdict-fallback' };
  }
  const urgent = decision.reasons.some((r) => URGENT_REASONS.has(r));
  const riskHigh = decision.switchRisk === 'elevated' || decision.switchRisk === 'ask';
  let wouldSkip = false;
  let why = 'unchanged';
  if (decision.extract && !urgent && !riskHigh) {
    if (verdict.maySkipHeavyReid) {
      wouldSkip = true;
      why = 'light-high-confirmed';
    } else if (input.effectiveCandidates <= 1 && verdict.tier !== 'C-low') {
      wouldSkip = true;
      why = 'single-candidate-after-demotion';
    } else if (input.cachedMargin != null && input.cachedMargin >= CACHED_RESOLVE_MARGIN && verdict.tier !== 'C-low') {
      wouldSkip = true;
      why = 'resolved-by-cached-gallery';
    }
  }
  const hard = decision.skip === 'no_valid_crop' || decision.skip === 'full_occlusion' || decision.skip === 'severe_blur';
  const wouldRequest = !decision.extract && !hard && verdict.requestHeavyReid;
  const virtual = { skipped: wouldSkip, requested: wouldRequest };
  if (!contourAffectsDecisions(flags)) {
    return { decision, virtual, applied: false, note: flags.enableContourContinuity ? 'shadow' : 'disabled' };
  }
  if (wouldSkip) {
    return {
      decision: {
        ...decision, extract: false, compare: false, rerank: false, admitInspect: false,
        measuredFresh: false, skip: 'not_due', skipDetail: `contour-conditional:${why}`,
      },
      virtual,
      applied: true,
      note: why,
    };
  }
  if (wouldRequest) {
    return {
      decision: {
        ...decision, extract: true, compare: true, admitInspect: false, measuredFresh: true,
        reasons: [...decision.reasons, 'track_drift_suspect'], skip: null,
        skipDetail: 'contour-conditional:unresolved', holdJudgment: true,
      },
      virtual,
      applied: true,
      note: 'requested-heavy-reid',
    };
  }
  return { decision, virtual, applied: false, note: why };
}

/**
 * 갤러리 갱신 관문 (10장). 외곽선·HSV 가 일치해도 이 조건이 다 맞아야 한다.
 * 외곽선·HSV 는 입력에조차 없다 — 그것만으로는 열 수 없다는 뜻이다.
 */
export interface GalleryGateInput {
  trackingConfidence: number;
  crowdCrossing: boolean;
  occluded: boolean;
  gmcConfidence: number;
  reidSelfCheckPassed: boolean;
  stableFrames: number;
  reidMargin: number;
}

export const GALLERY_GATE = Object.freeze({
  minTrackingConfidence: 0.7,
  minGmcConfidence: 0.6,
  minStableFrames: 5,
  minReidMargin: 0.08,
});

export function galleryUpdateGate(input: GalleryGateInput): { allowed: boolean; blockers: string[] } {
  const b: string[] = [];
  if (input.trackingConfidence < GALLERY_GATE.minTrackingConfidence) b.push('tracking-confidence');
  if (input.crowdCrossing) b.push('crowd-crossing');
  if (input.occluded) b.push('occluded');
  if (input.gmcConfidence < GALLERY_GATE.minGmcConfidence) b.push('gmc-confidence');
  if (!input.reidSelfCheckPassed) b.push('reid-self-check');
  if (input.stableFrames < GALLERY_GATE.minStableFrames) b.push('stable-frames');
  if (input.reidMargin < GALLERY_GATE.minReidMargin) b.push('reid-margin');
  return { allowed: b.length === 0, blockers: b };
}
