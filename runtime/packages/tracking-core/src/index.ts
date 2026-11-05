/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·aac7bf20 @license @preserve */
import { clamp01, type NormalizedBBox, type TrackingPoint } from '@hilit/shared-types';

// 소유권·출처 표시(워터마크). 번들에 실려 어디로 복사되든 따라간다. 지우지 말 것(LICENSE 4항).
export { OWNERSHIP, type Ownership } from './ownership';

export {
  applyProductionProfile, auditProductionProfile, parseProductionProfile, shouldApplyProductionProfile, trajectoryFeatures, featuresAt as productionFeaturesAt, predictOk, decideByThresholds as productionDecideByThresholds,
  PRODUCTION_FEATURES, PRODUCTION_FEATURE_VERSION, PRODUCTION_PROFILE_VERSION,
  type ProductionProfile, type ProductionThresholds, type ProductionQualityHead,
} from './production-profile';

export interface PixelBBox { x: number; y: number; width: number; height: number }
export interface TrackingProgress {
  phase: 'models' | 'track';
  percent?: number;
  message?: string;
  fps?: number;
  /* 지금 따라가고 있는 자리 — 추적이 도는 동안만 온다.
   *
   * 이게 없으면 화면은 진행률 숫자만 받고, 사용자는 몇 분을 기다린 뒤
   * 결과를 보고서야 자기가 제대로 잡혔는지 안다. 좌표는 파이프라인이
   * 이미 갖고 있으므로 실어 보내는 값이 거의 없다. */
  at?: number;
  box?: NormalizedBBox;
}

export interface TrackingEngine<Input = File> {
  readonly platform: 'android' | 'web';
  open(input: Input): Promise<unknown>;
  track(target: NormalizedBBox, onProgress?: (progress: TrackingProgress) => void): Promise<TrackingPoint[]>;
  dispose(): void;
}

export function normalizeBBox(box: PixelBBox, width: number, height: number): NormalizedBBox {
  return {
    x: clamp01(box.x / Math.max(1, width)), y: clamp01(box.y / Math.max(1, height)),
    width: clamp01(box.width / Math.max(1, width)), height: clamp01(box.height / Math.max(1, height)),
  };
}

export function denormalizeBBox(box: NormalizedBBox, width: number, height: number): PixelBBox {
  return { x: Math.round(box.x * width), y: Math.round(box.y * height), width: Math.round(box.width * width), height: Math.round(box.height * height) };
}

export function closestTrackingPoint(points: TrackingPoint[], timestamp: number): TrackingPoint | undefined {
  let closest: TrackingPoint | undefined;
  let delta = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const next = Math.abs(point.timestamp - timestamp);
    if (next < delta) { closest = point; delta = next; }
  }
  return closest;
}

export {
  FollowCamera, edgePin, pchipAt, holdAim, steadyCentreX, gaussianInTime, MAX_CROP_SHARE, HARD_MAX_UPSCALE,
  GOLDEN_X_STILL, GOLDEN_X_RUN, GOLDEN_Y_EYE, BODY_CENTRE_Y,
  DEFAULT_SUBJECT_SHARE, DEFAULT_STILL_SHARE, LOST_HOLD_WIDEN,
  type CropRect, type OutputAspect, type FollowCameraOptions, type ShotKind, type HighlightWindow,
  type PlanStats,
} from './follow-camera';
export {
  plannedFollowCamera, trackingStartsAtSeed, type EditorCameraSettings,
} from './follow-plan';
export {
  refineWithDetections, refineCorrections, FOLLOW_REFINE, type DetectionSample, type FollowRefineOptions,
} from './follow-refine';

export {
  highlightFxAt, highlightStartsOf, drawHighlightFx, subjectOnCanvas, HIGHLIGHT_FX_SECONDS,
  type HighlightFx,
} from './highlight-fx';

export { refineTrajectory, holdSegments, type RefineOptions, type RefineResult } from './trajectory';

/* 수동 추적 — 자동이 틀렸을 때 사람이 두세 점 찍어 고친다(캡컷 방식). */
export { applyManualKeyframes, suggestKeyframeAt,
         type ManualKeyframe, type ManualTrackOptions, type ManualTrackResult } from './manual-track';
export { OneEuroFilter, OneEuroPoint, type OneEuroOptions } from './one-euro';

export { findTrackingGaps, describeGap, gapWindow, GAP_WINDOWS, type TrackingGap, type FindGapsOptions } from './gaps';
export {
  askableGaps, longestConfidentRun, ASK_WEAK_CORE_CONF, ASK_MERGE_WITHIN_SEC, ASK_MIN_WEAK_SEC, ASK_REARM_OK_SEC, ASK_REAL_LOSS_SEC, ASK_MAX,
  type AnsweredAsk, type AskCadenceOptions,
} from './ask-cadence';
export { PRESENCE_CHECK, WIDE_BOX, presenceSampleTimes, presenceGaps, mergeGaps, wideOverSpans, skippedFraming, type PresenceSample, type PresenceCheckOptions } from './presence-check';

export {
  detectorLookup, isValidPixelBox, classifyObservation, needsReassign,
  spliceTrajectory, spliceTrajectoryWindow, shouldApplyRun, emptyTrajectoryIsNotSuccess,
  type TrackLifeState, type DetectorLookup,
} from './track-lifecycle';

export {
  DETECTOR_UNAVAILABLE, emptyScene, detectorOk, EVAL_ONLY_DETECTOR_ID,
  type DetectorAvailability, type DetectorOutcomeKind, type DetectorFrameRef,
  type PersonProposal, type DetectorRequest, type DetectorResult,
} from './detector-contract';

export { FrameEnhancer, suggestEnhance, NEUTRAL_GRADE, isNeutralGrade, hdrPlanFor,
         type EnhanceLevel, type ColorGrade, type HdrPlan } from './enhance';
export { toneMapSignal, detectHdrTransfer, probeHdrTransfer, rawHdrUploadKnown, HDR_TONEMAP_GLSL,
         HDR_REFERENCE_WHITE_NITS, type HdrTransfer } from './hdr-tonemap';

/* 상업 릴리스 판정 — 어떤 가중치를 상용 빌드에 실을 수 있는가.
 * 빌드 게이트(scripts/commercial-gate.mjs)가 이 목록을 읽는다. */

/* 정답 궤적과 채점. V1 과 V2 를 같은 자로 재려면 둘 다 있어야 한다. */
export { validateGroundTruth, isValidBox,
         type GroundTruth, type GtFrame, type GtBox, type GtEvent } from './ground-truth';
export { iou, scoreTracking, scoreStability, cutIdentityContinuity, MATCH_IOU,
         type PredictedPoint, type TrackingScore, type StabilityScore } from './evaluate';
export { scoreContinuitySuite, kaplanMeier, assertSeparatedSessions } from './continuity-suite';
export { ABSENCE_HONESTY_EXPERIMENT_DEFAULT, decideAbsenceHonesty } from './absence-honesty';
export type {
  AuditCheckpoint, AuditClipInput, ContinuityReport, FailureClass, FootageSplit, LabelGrade,
} from './continuity-suite';
