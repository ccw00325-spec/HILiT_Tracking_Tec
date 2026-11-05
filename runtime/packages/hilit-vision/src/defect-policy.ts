/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·52b4867d @license @preserve */
/* 추적 결함 위험 → 안전 대응. SVM 은 결함을 고치지 않는다. 대응을 고를 뿐이다.

이 제어기가 절대 하지 않는 것
  - ID 를 바꾸거나 확정하지 않는다 (identityChangeAllowed: false)
  - 재획득을 승인하지 않는다 (reacquireApproval: false)
  - shadow·비활성이면 어떤 결정도 바꾸지 않는다

충돌하면 더 안전한 쪽이 이긴다: 갤러리 차단 > ID 확정, 보류 > 공격적 확정.
*/

import { applyScaler, linearScore, plattProb, type Platt, type Scaler } from './defect-svm';

export const DEFECT_IDS = [
  'blurRisk', 'focusFailureRisk', 'compressionArtifactRisk', 'noiseRisk', 'lowLightRisk', 'lowContrastRisk',
  'smallObjectRisk', 'insufficientDetailRisk',
  'detectionMissRisk', 'maskFailureRisk', 'mergedMaskRisk', 'partialMaskRisk', 'occlusionRisk', 'crowdCrossingRisk',
  'gmcFailureRisk', 'wrongCameraMotionRisk', 'motionPredictionFailureRisk', 'unstableTransformRisk',
  'appearanceAmbiguityRisk', 'wrongAssociationRisk', 'idSwitchRisk', 'galleryContaminationRisk',
  'falseReacquireRisk', 'staleTrackReuseRisk', 'reidFeatureQualityRisk',
] as const;
export type DefectId = typeof DEFECT_IDS[number];

export type DefectLevel = 1 | 2 | 3;
export const DEFECT_LEVEL: Readonly<Record<DefectId, DefectLevel>> = Object.freeze({
  blurRisk: 1, focusFailureRisk: 1, compressionArtifactRisk: 1, noiseRisk: 1, lowLightRisk: 1, lowContrastRisk: 1,
  smallObjectRisk: 1, insufficientDetailRisk: 1,
  detectionMissRisk: 2, maskFailureRisk: 2, mergedMaskRisk: 2, partialMaskRisk: 2, occlusionRisk: 2, crowdCrossingRisk: 2,
  gmcFailureRisk: 2, wrongCameraMotionRisk: 2, motionPredictionFailureRisk: 2, unstableTransformRisk: 2,
  appearanceAmbiguityRisk: 3, wrongAssociationRisk: 3, idSwitchRisk: 3, galleryContaminationRisk: 3,
  falseReacquireRisk: 3, staleTrackReuseRisk: 3, reidFeatureQualityRisk: 3,
});

/* ---------- 13장: 플래그 ---------- */

export interface TrackingDefectFlags {
  enableTrackingDefectClassifier: boolean;
  trackingDefectShadowMode: boolean;
  trackingDefectModelVersion: string;
  trackingDefectFeatureSchemaVersion: string;
  trackingDefectBackend: 'ts-dot-product';
  trackingDefectLogLevel: 'off' | 'summary' | 'frame';
  enableDctQualityFeatures: boolean;
  dctGlobalInputSize: [number, number];
  dctRoiInputSize: [number, number];
  dctBlockSize: number;
  dctFrequencyBands: [number, number];
  dctUpdateIntervalMs: number;
  enableSvdQualityFeatures: boolean;
  svdRoiInputSize: [number, number];
  svdTopK: number;
  svdTemporalWindowMs: number;
  svdUpdateIntervalMs: number;
  svdMaxComputeMs: number;
  svmModelType: 'linear' | 'linear-weighted' | 'linear-calibrated';
  svmCalibrationType: 'platt' | 'none';
  svmDecisionThresholds: Partial<Record<DefectId, number>>;
  svmMinConfidence: number;
  svmMinPersistenceMs: number;
  svmEnterThreshold: number;
  svmExitThreshold: number;
  svmCooldownMs: number;
  blockGalleryUpdateOnRisk: boolean;
  holdIdDecisionOnRisk: boolean;
  reduceContourWeightOnRisk: boolean;
  reduceHsvWeightOnRisk: boolean;
  triggerSlicedDetectionOnRisk: boolean;
  triggerSiftBfOnGmcRisk: boolean;
  triggerLightGlueOnGmcRisk: boolean;
  triggerHeavyReidOnRisk: boolean;
  fallbackToExistingTracking: true;
  autoReacquire: false;
}

export const TRACKING_DEFECT_DEFAULTS: Readonly<TrackingDefectFlags> = Object.freeze({
  enableTrackingDefectClassifier: false,
  trackingDefectShadowMode: true,
  trackingDefectModelVersion: 'none',
  trackingDefectFeatureSchemaVersion: 'defect-schema-v1',
  trackingDefectBackend: 'ts-dot-product',
  trackingDefectLogLevel: 'summary',
  enableDctQualityFeatures: true,
  dctGlobalInputSize: [64, 36],
  dctRoiInputSize: [32, 64],
  dctBlockSize: 8,
  dctFrequencyBands: [0.25, 0.75],
  dctUpdateIntervalMs: 0,
  enableSvdQualityFeatures: true,
  svdRoiInputSize: [16, 32],
  svdTopK: 4,
  svdTemporalWindowMs: 1000,
  svdUpdateIntervalMs: 0,
  svdMaxComputeMs: 4,
  svmModelType: 'linear-calibrated',
  svmCalibrationType: 'platt',
  svmDecisionThresholds: {},
  svmMinConfidence: 0.2,
  svmMinPersistenceMs: 200,
  svmEnterThreshold: 0.6,
  svmExitThreshold: 0.4,
  svmCooldownMs: 500,
  blockGalleryUpdateOnRisk: true,
  holdIdDecisionOnRisk: false,
  reduceContourWeightOnRisk: false,
  reduceHsvWeightOnRisk: false,
  triggerSlicedDetectionOnRisk: false,
  triggerSiftBfOnGmcRisk: false,
  triggerLightGlueOnGmcRisk: false,
  triggerHeavyReidOnRisk: false,
  fallbackToExistingTracking: true,
  autoReacquire: false,
});

export function defectAffectsDecisions(flags: TrackingDefectFlags): boolean {
  return flags.enableTrackingDefectClassifier && !flags.trackingDefectShadowMode;
}

/* ---------- 모델 번들 ---------- */

export interface DefectModelEntry {
  w: number[];
  b: number;
  platt: Platt | null;
  /** 보정 확률 문턱 (검증에서 고름) */
  threshold: number;
  /** 검증 PR-AUC 등 — 신뢰도 하한 판단에 쓴다 */
  validationPrAuc: number | null;
  labelKind: 'ground-truth' | 'synthetic-corruption' | 'rule-weak';
}

export interface DefectModelBundle {
  schemaVersion: string;
  featureOrder: string[];
  scaler: Scaler;
  missingValue: 'scaler-mean';
  models: Partial<Record<DefectId, DefectModelEntry>>;
  modelVersion: string;
  modelType: TrackingDefectFlags['svmModelType'];
  trainingDataVersion: string;
  sourceCommit: string;
  seed: number;
  trainedAt: string;
}

export type BundleLoadResult = { ok: true; bundle: DefectModelBundle } | { ok: false; reason: string };

/** schema·특징 순서·scaler 크기가 하나라도 안 맞으면 모델을 쓰지 않는다. */
export function loadDefectBundle(raw: unknown, expectedSchema: string, expectedOrder: readonly string[]): BundleLoadResult {
  try {
    const b = raw as DefectModelBundle;
    if (!b || typeof b !== 'object') return { ok: false, reason: 'not-an-object' };
    if (b.schemaVersion !== expectedSchema) return { ok: false, reason: 'schema-mismatch' };
    if (!Array.isArray(b.featureOrder) || b.featureOrder.length !== expectedOrder.length
      || b.featureOrder.some((f, i) => f !== expectedOrder[i])) return { ok: false, reason: 'feature-order-mismatch' };
    const d = expectedOrder.length;
    if (!b.scaler || b.scaler.mean?.length !== d || b.scaler.std?.length !== d) return { ok: false, reason: 'scaler-mismatch' };
    if ([...b.scaler.mean, ...b.scaler.std].some((v) => !Number.isFinite(v))) return { ok: false, reason: 'scaler-not-finite' };
    for (const [k, m] of Object.entries(b.models ?? {})) {
      if (!m || m.w.length !== d || !Number.isFinite(m.b) || m.w.some((v) => !Number.isFinite(v))) {
        return { ok: false, reason: `model-invalid:${k}` };
      }
    }
    return { ok: true, bundle: b };
  } catch {
    return { ok: false, reason: 'load-exception' };
  }
}

export interface DefectScore {
  score: number | null;
  prob: number | null;
  /** 입력 신뢰도 × 검증 품질. 낮으면 강제 행동 금지 */
  confidence: number;
}

/** 표준화 + 내적. NaN/Inf 가 섞인 특징이 너무 많으면 점수를 내지 않는다. */
export function scoreDefects(bundle: DefectModelBundle, features: ArrayLike<number>, inputReliability = 1): Partial<Record<DefectId, DefectScore>> {
  const out: Partial<Record<DefectId, DefectScore>> = {};
  let missing = 0;
  for (let i = 0; i < features.length; i += 1) if (!Number.isFinite(features[i])) missing += 1;
  const missRatio = features.length ? missing / features.length : 1;
  const x = applyScaler(features, bundle.scaler);
  for (const [k, m] of Object.entries(bundle.models) as Array<[DefectId, DefectModelEntry]>) {
    if (missRatio > 0.5) {
      out[k] = { score: null, prob: null, confidence: 0 };
      continue;
    }
    const s = linearScore(m, x);
    const p = plattProb(m.platt, s);
    const q = m.validationPrAuc == null ? 0.5 : Math.max(0, Math.min(1, m.validationPrAuc));
    out[k] = { score: s, prob: p, confidence: Math.max(0, Math.min(1, inputReliability * (1 - missRatio) * q)) };
  }
  return out;
}

/* ---------- 11장: 대응 ---------- */

export interface DefectActions {
  blockGalleryUpdate: boolean;
  quarantineRecentGallery: boolean;
  holdIdDecision: boolean;
  /** 히스테리시스 강화: 최소 확정 프레임 */
  minConfirmFrames: number;
  disableContour: boolean;
  reduceContourCurvature: boolean;
  hsvWeightScale: number;
  appearanceWeightScale: number;
  motionWeightScale: number;
  requireLargerMargin: boolean;
  gmcRecheck: 'none' | 'sift-bf' | 'lightglue';
  reuseLastGoodGmc: boolean;
  requestHeavyReid: boolean;
  requestGalleryJaccard: boolean;
  requestSlicedDetection: boolean;
  staleTrackPenalty: boolean;
  fallback: boolean;
  identityChangeAllowed: false;
  reacquireApproval: false;
  active: DefectId[];
}

export function neutralActions(): DefectActions {
  return {
    blockGalleryUpdate: false, quarantineRecentGallery: false, holdIdDecision: false, minConfirmFrames: 0,
    disableContour: false, reduceContourCurvature: false, hsvWeightScale: 1, appearanceWeightScale: 1, motionWeightScale: 1,
    requireLargerMargin: false, gmcRecheck: 'none', reuseLastGoodGmc: false, requestHeavyReid: false,
    requestGalleryJaccard: false, requestSlicedDetection: false, staleTrackPenalty: false, fallback: false,
    identityChangeAllowed: false, reacquireApproval: false, active: [],
  };
}

/** 결함 하나 → 대응. 여러 결함은 mergeActions 로 더 안전한 쪽을 고른다. */
export function actionsFor(d: DefectId): Partial<DefectActions> {
  switch (d) {
    case 'blurRisk': case 'focusFailureRisk': case 'insufficientDetailRisk':
      return { reduceContourCurvature: true, appearanceWeightScale: 0.6, hsvWeightScale: 0.7, blockGalleryUpdate: true, holdIdDecision: true };
    case 'compressionArtifactRisk': case 'noiseRisk':
      return { reduceContourCurvature: true, blockGalleryUpdate: true };
    case 'lowLightRisk': case 'lowContrastRisk':
      return { hsvWeightScale: 0.5, blockGalleryUpdate: true };
    case 'smallObjectRisk':
      return { reduceContourCurvature: true, requestSlicedDetection: true };
    case 'maskFailureRisk': case 'mergedMaskRisk': case 'partialMaskRisk':
      return { disableContour: true, hsvWeightScale: 0.5, blockGalleryUpdate: true };
    case 'occlusionRisk': case 'crowdCrossingRisk':
      return { holdIdDecision: true, minConfirmFrames: 3, hsvWeightScale: 0.5, blockGalleryUpdate: true, requestGalleryJaccard: true };
    case 'gmcFailureRisk': case 'unstableTransformRisk': case 'wrongCameraMotionRisk':
      return { gmcRecheck: 'sift-bf', reuseLastGoodGmc: true, motionWeightScale: 0.6 };
    case 'motionPredictionFailureRisk':
      return { motionWeightScale: 0.5, holdIdDecision: true };
    case 'appearanceAmbiguityRisk':
      return { requireLargerMargin: true, requestGalleryJaccard: true, holdIdDecision: true };
    case 'idSwitchRisk': case 'wrongAssociationRisk':
      return { holdIdDecision: true, minConfirmFrames: 3, blockGalleryUpdate: true, requireLargerMargin: true };
    case 'galleryContaminationRisk':
      return { blockGalleryUpdate: true, quarantineRecentGallery: true };
    case 'falseReacquireRisk': case 'staleTrackReuseRisk':
      return { staleTrackPenalty: true, holdIdDecision: true };
    case 'detectionMissRisk':
      return { requestSlicedDetection: true };
    case 'reidFeatureQualityRisk':
      return { appearanceWeightScale: 0.6, blockGalleryUpdate: true };
    default:
      return {};
  }
}

/** 더 안전한 쪽: 차단·보류는 OR, 가중 배율은 최솟값, 확정 프레임은 최댓값. */
export function mergeActions(list: ReadonlyArray<Partial<DefectActions>>): DefectActions {
  const out = neutralActions();
  for (const a of list) {
    out.blockGalleryUpdate ||= a.blockGalleryUpdate ?? false;
    out.quarantineRecentGallery ||= a.quarantineRecentGallery ?? false;
    out.holdIdDecision ||= a.holdIdDecision ?? false;
    out.minConfirmFrames = Math.max(out.minConfirmFrames, a.minConfirmFrames ?? 0);
    out.disableContour ||= a.disableContour ?? false;
    out.reduceContourCurvature ||= a.reduceContourCurvature ?? false;
    out.hsvWeightScale = Math.min(out.hsvWeightScale, a.hsvWeightScale ?? 1);
    out.appearanceWeightScale = Math.min(out.appearanceWeightScale, a.appearanceWeightScale ?? 1);
    out.motionWeightScale = Math.min(out.motionWeightScale, a.motionWeightScale ?? 1);
    out.requireLargerMargin ||= a.requireLargerMargin ?? false;
    if (a.gmcRecheck === 'lightglue' || (a.gmcRecheck === 'sift-bf' && out.gmcRecheck === 'none')) out.gmcRecheck = a.gmcRecheck;
    out.reuseLastGoodGmc ||= a.reuseLastGoodGmc ?? false;
    out.requestHeavyReid ||= a.requestHeavyReid ?? false;
    out.requestGalleryJaccard ||= a.requestGalleryJaccard ?? false;
    out.requestSlicedDetection ||= a.requestSlicedDetection ?? false;
    out.staleTrackPenalty ||= a.staleTrackPenalty ?? false;
    out.fallback ||= a.fallback ?? false;
  }
  if (out.holdIdDecision) out.minConfirmFrames = Math.max(out.minConfirmFrames, 2);
  return out;
}

/* ---------- 12장: 히스테리시스·지속·쿨다운 ---------- */

interface DefectState {
  on: boolean;
  aboveSinceMs: number | null;
  lastOnMs: number;
}

export interface ControllerStep {
  actions: DefectActions;
  /** shadow 여부와 무관하게 "켰다면" 의 대응 */
  recommended: DefectActions;
  applied: boolean;
  probs: Partial<Record<DefectId, number | null>>;
  reason: string;
}

export class DefectRiskController {
  private state = new Map<DefectId, DefectState>();
  private lastCall = new Map<string, number>();
  private readonly bundle: DefectModelBundle | null;
  readonly disabledReason: string | null;

  constructor(private readonly flags: TrackingDefectFlags, bundleRaw: unknown, featureOrder: readonly string[]) {
    const r = bundleRaw == null ? { ok: false as const, reason: 'no-model' } : loadDefectBundle(bundleRaw, flags.trackingDefectFeatureSchemaVersion, featureOrder);
    this.bundle = r.ok ? r.bundle : null;
    this.disabledReason = r.ok ? null : r.reason;
  }

  get usable(): boolean {
    return this.bundle != null;
  }

  private cooldownOk(key: string, nowMs: number, ms: number): boolean {
    const last = this.lastCall.get(key);
    if (last != null && nowMs - last < ms) return false;
    this.lastCall.set(key, nowMs);
    return true;
  }

  step(nowMs: number, features: ArrayLike<number>, inputReliability = 1): ControllerStep {
    const fallbackStep = (reason: string): ControllerStep => ({
      actions: neutralActions(), recommended: { ...neutralActions(), fallback: true }, applied: false, probs: {}, reason,
    });
    if (!this.bundle) return fallbackStep(`fallback:${this.disabledReason}`);
    for (let i = 0; i < features.length; i += 1) {
      const v = features[i];
      if (v === Number.POSITIVE_INFINITY || v === Number.NEGATIVE_INFINITY) return fallbackStep('fallback:inf-input');
    }
    const scores = scoreDefects(this.bundle, features, inputReliability);
    const probs: Partial<Record<DefectId, number | null>> = {};
    const active: DefectId[] = [];
    for (const d of DEFECT_IDS) {
      const s = scores[d];
      if (!s) continue;
      probs[d] = s.prob;
      const st = this.state.get(d) ?? { on: false, aboveSinceMs: null, lastOnMs: -Infinity };
      const enter = this.flags.svmDecisionThresholds[d] ?? this.bundle.models[d]?.threshold ?? this.flags.svmEnterThreshold;
      const exit = Math.min(enter, this.flags.svmExitThreshold + (enter - this.flags.svmEnterThreshold));
      const p = s.prob;
      if (p == null || s.confidence < this.flags.svmMinConfidence) {
        // 보정 신뢰가 낮으면 강제 행동을 켜지 않는다. 켜져 있던 것은 끈다.
        st.on = false;
        st.aboveSinceMs = null;
      } else if (!st.on) {
        if (p >= enter) {
          st.aboveSinceMs ??= nowMs;
          if (nowMs - st.aboveSinceMs >= this.flags.svmMinPersistenceMs) {
            st.on = true;
            st.lastOnMs = nowMs;
          }
        } else st.aboveSinceMs = null;
      } else if (p < exit) {
        st.on = false;
        st.aboveSinceMs = null;
      } else st.lastOnMs = nowMs;
      this.state.set(d, st);
      if (st.on) active.push(d);
    }
    const recommended = mergeActions(active.map(actionsFor));
    recommended.active = active;
    // 플래그로 꺼진 대응은 빼고, 호출형 대응에는 쿨다운
    if (!this.flags.blockGalleryUpdateOnRisk) {
      recommended.blockGalleryUpdate = false;
      recommended.quarantineRecentGallery = false;
    }
    if (!this.flags.holdIdDecisionOnRisk) {
      recommended.holdIdDecision = false;
      recommended.minConfirmFrames = 0;
    }
    if (!this.flags.reduceContourWeightOnRisk) {
      recommended.disableContour = false;
      recommended.reduceContourCurvature = false;
    }
    if (!this.flags.reduceHsvWeightOnRisk) recommended.hsvWeightScale = 1;
    if (!this.flags.triggerSlicedDetectionOnRisk) recommended.requestSlicedDetection = false;
    else if (recommended.requestSlicedDetection) recommended.requestSlicedDetection = this.cooldownOk('sliced', nowMs, this.flags.svmCooldownMs);
    if (recommended.gmcRecheck !== 'none') {
      if (!this.flags.triggerSiftBfOnGmcRisk) recommended.gmcRecheck = 'none';
      else if (!this.cooldownOk('gmc', nowMs, this.flags.svmCooldownMs)) recommended.gmcRecheck = 'none';
      else if (this.flags.triggerLightGlueOnGmcRisk && (probs.gmcFailureRisk ?? 0) >= 0.85 && this.cooldownOk('lightglue', nowMs, this.flags.svmCooldownMs * 4)) {
        recommended.gmcRecheck = 'lightglue';
      }
    }
    if (!this.flags.triggerHeavyReidOnRisk) recommended.requestHeavyReid = false;
    else {
      const want = active.some((d) => d === 'appearanceAmbiguityRisk' || d === 'idSwitchRisk' || d === 'wrongAssociationRisk');
      recommended.requestHeavyReid = want && this.cooldownOk('reid', nowMs, this.flags.svmCooldownMs);
    }
    const applied = defectAffectsDecisions(this.flags);
    return { actions: applied ? recommended : neutralActions(), recommended, applied, probs, reason: applied ? 'applied' : 'shadow-or-disabled' };
  }
}
