/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·3979b65a @license @preserve */
/* HILIT 자체 비전 기술.
 *
 * 권리가 불명확한 외부 가중치를 걷어내고 그 자리를 채우는 알고리즘들이다.
 *
 *   appearance      OSNet(연구용 가중치) 대체. 색 기반 외형 서술자. 가중치 없음
 *   motion          관측 중심 운동 모델 (칼만식 예측 — 화소 추적 아님)
 *   motion-tracker  NanoTrack 대체. 피라미드 SAD+LK 위치 추적. 가중치 없음
 *   dcf-tracker     커널 상관필터(KCF·SAMF·MOSSE PSR) 자체 구현. 가중치 없음
 *   person-detector 자체 격자 합성곱 + 세로 에너지 창. 합성 가중치는
 *                   파이프라인 점검용이며 실사 사람 검출 품질이 아니다
 *   person-net      HilitPersonNet v0. 외부 pretrained 없이 학습하는
 *                   사람 검출 기반. 이번 단계는 diagnose-only.
 *   person-net-plus v0보다 넓은 자체 용량. 동의 실사 전에는 diagnose-only.
 *   association     둘을 합쳐 "누가 그 사람인가" 를 판정한다
 *   affine-gmc      배경 아핀 카메라 보정. 예측 상자만 옮긴다.
 *   sports-gate     등번호·팀색·코트·Tracklet으로 옆 사람 점프만 막는다.
 *
 * 왜 이렇게 만들 수 있는가, 무엇을 포기했는가는 각 파일의 머리말과
 * docs/TRACKING_V2_ARCHITECTURE.md 에 적었다.
 */
export { describe, similarity, similarityBandAware, similarityByBand, maskedBandSimilarity, merge, adapt, BANDS, DESCRIPTOR_SIZE,
         BAND_MIN_SAMPLES,
         type Descriptor, type AdaptOptions, type AdaptResult } from './appearance';
export {
  mayAdaptUserAnchor, mayRecordAsOther, decideAppearanceMatch, refineDecisionWithTexture,
  nextAnchorDrift,
  ANCHOR_DRIFT_GRACE_SEC, ANCHOR_DRIFT_RUN,
  type MemoryKind, type ReidDecision,
} from './appearance-memory';
export { makeTemplate, correlate, blendTemplate, TPL_W, TPL_H,
         type Template } from './template';
export { HilitMotion, clampBox, MAX_COAST_SECONDS, MAX_SPEED_BODIES, OCCLUSION_GAP,
         HEADING_WINDOW,
         type MotionBox, type MotionState, type Point } from './motion';
export {
  HilitMotionTrackerCore, rgbaToGray, buildPyramid, selectPoints,
  trackForwardBack, estimateMotion, preferInnerPairs, applyMotion, motionQuality,
  cropGray, roiRect, sadCoarseRange, SAD_COARSE_RANGE,
  INNER_MOTION_MAX_NORM, INNER_MOTION_MIN_POINTS,
  SIZE_MIN_RATIO, SIZE_MAX_RATIO, SIZE_UPDATE_MIN_QUALITY,
  type PixelBox, type MotionTrackResult, type MotionStatus, type GrayFrame,
} from './motion-tracker';
/* 가중치 없는 판별형 상관필터(KCF 계열) 위치 추적 — 논문 알고리즘 자체 구현. */
export {
  HilitDcfTrackerCore, DCF_PARAMS, DCF_CHANNELS, DCF_HOG_BINS,
  fft2, isPow2, gridFor, samplePatch, extractFeatures, analyzeResponse,
  psrToConfidence, unsignedAngle, EARLY_REINIT_UPDATES, BLANK_PATCH_STD,
  type DcfBox, type DcfRgbaFrame, type DcfStatus, type DcfTrackResult, type DcfParams,
} from './dcf-tracker';
/* 마지막 방어선 — 추적기가 화면 밖으로 달아나거나 옆 사람으로 건너뛰는
 * 것을 물리 법칙으로 막는다. 외형·검출·재식별이 전부 실패해도 살아 있다. */
export { visibleRatio, clampToFrame, hasEscaped, isStationary,
         maxStep, judgeStep, limitStep, limitScale, discountByVisibility,
         MAX_SCALE_PER_SECOND, limitToSizeBand, SIZE_BAND_LOW, SIZE_BAND_HIGH,
         MIN_VISIBLE, MAX_SPEED_BODIES as GUARD_MAX_SPEED_BODIES,
         STATIONARY_BODIES,
         type GuardBox, type FrameSize, type StepLimitOptions,
         type StepVerdict } from './frame-guard';

/* 화면의 모든 사람을 짧은 궤적으로 이어 붙인다 — "같이 보였으면 다른
 * 사람이다" 를 쓸 수 있게 한다(SORT·ByteTrack 연관 단계 착상). */
export { TrackletStore, iou, DEFAULT_MAX_MISSES,
         type Tracklet, type TrackletBox, type TrackletOptions, type TrackletCameraWarp } from './tracklets';
export {
  TrackletGraph, compensateDetections, TRACKLET_MIN_HITS, TRACKLET_SWITCH_BODIES,
  type TrackletSwitchDecision, type TrackletSwitchAction,
} from './tracklet-graph';

/* 작게 찍힌 사람을 검출기가 볼 수 있게 — 잘라서 다시 본다(SAHI 착상). */
export { planSlices, shouldSlice, mergeDetections, toFrame, isClipped,
         SLICE_BELOW_SHARE,
         type Slice, type Rect, type Detection, type PlanOptions } from './tiling';
export { associate, scoreCandidate, toSamples,
         HIGH_CONFIDENCE, ACCEPT_PRIMARY, ACCEPT_RECOVERY,
         type Candidate, type AssociationContext, type AssociationResult,
         type Scored, type AssociationSample } from './association';

export {
  GRID_IN_W, GRID_IN_H, MODEL_ID, MODEL_VERSION, QUALITY_STATUS,
  initWeights, forwardLogits, decodeBoxes, nms, boxIou, makeSynthSample,
  trainGridNet, evaluateWeights, evaluateSet, rgbFromRgba, paramCount,
  type GridWeights, type GridBox, type TrainReport, type SynthSample,
} from './hilit-grid-net';
export {
  STAND_MODEL_ID, STAND_MODEL_VERSION, proposeStandEnergy,
  type StandBox,
} from './hilit-stand-energy';
export {
  HilitPersonDetector, cropRgba,
  type DetectorRun, type DetectorProposal, type DetectorRunOutcome,
  type ProposeOptions,
} from './hilit-person-detector';
export {
  HOG_MODEL_ID, HOG_MODEL_VERSION, proposeHogWindow, rgbaToGray255,
  type HogBox,
} from './hilit-hog-window';
export {
  planPreprocess, restoreBox, restorePoint, clampBox as clampPixelBox, filterRestoredBoxes, letterboxRgba,
  type PreprocessMode, type PreprocessMeta, type PixelBox as LetterboxPixelBox,
} from './letterbox';
export {
  runNamedDetector,
  type NamedDetectorId, type DetectorEvidencePacket, type AdapterRequest, type AdapterBox,
} from './detector-adapter';
export {
  DETECTOR_INTERVAL_FRAMES, NEAR_PAD, REGION_PAD, planDetectorSearch, padSearchRegion,
  type DetectorTrigger, type SearchPlan, type SearchScope, type PixelRect,
} from './detector-schedule';
export {
  detectorObservationTrust,
  type DetectorObservationInput, type DetectorObservationReason,
} from './detector-observation';
export {
  classifySearchState, productMayApplyIdentity, buildReacquireEvidence,
  type SearchIdentityState, type ReacquireEvidence,
} from './reacquire-evidence';
export {
  mapPipelineTrackState, mapIdentityState, mayUpdateAppearanceMemory,
  classifyTrackFailureCause, composeTrackReport,
  type TrackMotionState, type IdentityJudgeState, type TrackFailureCause, type TrackIdentityReport,
} from './track-identity-report';
export {
  compareForwardBackward, BIDIR_IOU,
  type DirectedBox, type BidirectionalHit,
} from './bidirectional-check';
export {
  STAGE2_ADOPT_RULES, STAGE2_IOU, greedyPr, percentile, decideProductAdoption,
  type PrResult,
} from './detector-compare';
export {
  decideDetectorReacquire, uniqueAppearanceMargin,
  AUTO_REACQUIRE_DEFAULT, AUTO_REACQUIRE_PROMOTION_REQUIRED, productDetectorMode,
  type DetectorMode, type ReacquireAction, type ReacquireInput,
  type ReacquireDecision, type ReacquireProposal,
} from './detector-reacquire';
export {
  createIdentityRecord, renameDisplayName, linkMemberAccount, attachTrackSpan,
  tracksForSubject, assertSameProject, resolveByDisplayName,
  type SubjectId, type TrackId, type MemberId, type DisplayName,
  type IdentityLinkStatus, type TrackSpan, type IdentityRecord,
} from './identity-ids';
export {
  scoreObservationQuality, boxOverlapRatio, mayCommitAppearanceObservation,
  MIN_MEMORY_QUALITY, MAX_MEMORY_OVERLAP,
  type ObservationQuality, type QualityInput,
} from './appearance-quality';
export {
  describeTexture, textureSimilarity, TEXTURE_ORIENT_BINS, TEXTURE_SIZE, TEXTURE_MIN_ENERGY,
  type TextureDescriptor,
} from './appearance-texture';
export {
  extractAppearance, scoreExtractedPair, learnedReidAvailability,
  HSV_EXTRACTOR_ID, HSV_TEXTURE_EXTRACTOR_ID, EXTRACTOR_VERSION,
  APPEARANCE_PREPROCESS_VERSION,
  type FeatureExtractorKind, type ExtractedAppearance, type AppearancePairScore,
} from './feature-extractor';
export {
  createSubjectMemory, recordUserAnchor, recordAutoObservation, trustedSlots,
  scoreAgainstMemory, clearSubjectMemory, forgetIfVideoChanged,
  MAX_MEMORY_SLOTS,
  type ViewHint, type MemorySlot, type MemoryUpdate, type SubjectAppearanceMemory,
} from './identity-memory';
export {
  composeIdentityScore, judgeSubjectCandidates, assignDetectionsToSubjects,
  fillProposalOthers, pickBestByAppearance, bundleIdentityQuestions,
  IDENTITY_ACCEPT, IDENTITY_MARGIN, MOTION_DECAY_GAP_SEC,
  type IdentityEvidence, type IdentityCandidate, type SubjectJudgeInput,
  type IdentityJudgeResult, type AssignmentRow, type IdentityEvent, type IdentityQuestionSpan,
} from './identity-judge';
export {
  LABEL_SCHEMA_VERSION, validatePersonLabels, assertTrainable, EXAMPLE_SYNTH_DOCUMENT,
  type PersonLabelDocument, type PersonFrameLabel, type PersonBoxLabel,
  type LabelIssue, type SplitName, type RightsStatus, type LabelTrust,
  type ValidateLabelOptions,
} from './person-labels';
export {
  EVAL_ANNOTATION_SCHEMA, validateEvalAnnotation, assertSessionSplit,
  personLabelsToEvalAnnotation, personLabelIssuesForEval,
  type IdentityPresence, type EvalAnnotationDocument, type EvalFrame, type EvalBox,
  type EvalActionSpan, type EvalReviewEvent,
} from './eval-annotation';
export {
  MOTION_ANALYSIS_VERSION, POSE_ANALYSIS_VERSION, emptyRef,
  type AnalysisRef, type CameraMotionStatus, type SubjectMotionStatus,
  type PoseObsStatus, type InterpretationKind, type AnalysisProvenance, type TimeBase,
} from './analysis-contract';
export {
  estimateCameraTranslation, estimateCameraPreferAffine, compareCameraMethods, downsampleGray, personMask,
  CAMERA_METHOD_ID, CAMERA_BASELINE_METHOD_ID, CAMERA_MAX_PERSON_SHARE,
  type CameraBox, type CameraEstimate, type CameraCompareRow,
} from './camera-motion';
export {
  GMC_METHOD_ID, estimateAffineGmc, applyAffineToBox, identityGmc, IDENTITY_AFFINE,
  EMPTY_GMC_DIAGNOSTICS,
  type Affine2D, type AffineGmcResult, type GmcBox, type GmcDiagnostics,
} from './affine-gmc';
export {
  GmcVerifier, GMC_VERIFY_POLICY, GMC_IS_NOT_IDENTITY,
  assessGmcEvidence, affineGapPx, composeAffine,
  type GmcState, type GmcVerifyPolicy, type GmcVerifyInput, type GmcVerifyOutput,
  type GmcEvidenceVerdict, type GmcRejectReason, type ThermalLevel,
} from './gmc-verification';
export {
  shouldRunHighCostVerify, takeVerifyResult,
  HIGH_COST_VERIFY_CONFIG, LIGHTGLUE_DEFAULT_ON,
  type HighCostVerifyConfig, type HighCostVerifyBackend, type HighCostTriggerMode,
  type HighCostTriggerInput, type HighCostTriggerDecision, type HighCostTriggerReason,
} from './gmc-high-cost-verify';
export {
  refineOfflineTrajectory, inferBackwardFromForward, extrapolateBackwardGeometry, reverseBoxes,
  OFFLINE_AGREE_IOU, OFFLINE_BRIDGE_SEC,
  type OfflineBox, type OfflinePoint, type OfflineSpan,
} from './offline-bidirectional';
export {
  JerseyLock, readJerseyNumber, JERSEY_ACCEPT,
  type JerseyRead, type JerseyDecision,
} from './jersey-lock';
export {
  describeTeam, decideTeamCue, clusterTeamLabels, teamAffinity,
  type TeamVector, type TeamDecision,
} from './team-cue';
export {
  estimateCourtHint, courtFootDistance,
  type CourtHintResult, type CourtPoint,
} from './court-hint';
export {
  applyOcclusionCrop, occlusionWidenFactor, maxOverlap, boxIou as occlusionBoxIou,
  OCCLUSION_IOU_WIDEN, OCCLUSION_MAX_WIDEN,
} from './occlusion-framing';
export {
  scoreEventForMe, type EventForMeInput,
} from './event-for-me';
export {
  gateSportsIdentity, type SportsGateResult, type SportsGateAction,
} from './sports-identity-gate';
export {
  computeSubjectMotionStep, mustNotInventPhysicalSpeed,
  SUBJECT_MAX_GAP_SEC, SUBJECT_JITTER_PX,
  type SubjectMotionStep, type PixelBox as SubjectPixelBox,
} from './subject-motion';
export {
  poseEstimatorAvailability, emptyPoseObservation, jointsFromBox,
  bindPoseToSubject, restoreJointsToSource, POSE_JOINT_NAMES, POSE_VISIBLE_MIN,
  type JointName, type JointObservation, type PoseObservation, type PoseEstimatorReport,
} from './pose-observation';
export {
  samplePoseFeatures, sequencePoseFeatures, filterPoseFeatures, bodyLowerSpans,
  POSE_FEATURE_GAP_SEC,
  type PoseFeatureSample,
} from './pose-features';
export {
  interpretSubjectAndCamera, interpretPoseRequest,
  type MotionInterpretation,
} from './motion-interpretation';
export {
  sharedPoseRuntime, disposePoseRuntime, samplingQualityNote,
  type PoseRuntimeHandle,
} from './pose-runtime';
export {
  ACTION_ANALYSIS_VERSION, ACTION_THRESHOLDS, ACTION_DEFS, actionDef, learnedActionAvailability,
  type SupportedActionKind, type UnsupportedActionKind, type ActionKindDef,
} from './action-catalog';
export {
  labelMotionStep, buildActionSpans,
  type ActionSpan, type StepLabel,
} from './action-spans';
export {
  STAGE11_MANIFEST_VERSION,
  REAL_EVAL_RIGHTS,
  PRODUCT_FORBIDDEN_RIGHTS,
  PROMOTION_MIN_REVIEWED_CLIPS,
  clipAdmittedForRealMetrics,
  promotionGate,
  emptyStage11Manifest,
} from './stage11-rights';
export type { RealEvalRight, ReviewState, Stage11Clip, Stage11Manifest } from './stage11-rights';
export {
  iou as stage11Iou,
  reviewedOnly,
  detectionScores,
  trackingScores,
} from './stage11-metrics';
export type { Box as Stage11Box, ReviewedTruth, DetectionPred, TrackPred } from './stage11-metrics';
export {
  PERSONNET_RIGHTS_VERSION,
  REQUIRED_ASSET_FIELDS,
  FORBIDDEN_DATASET_TOKENS,
  emptyPersonNetRightsManifest,
  inspectAssetRecord,
  gateAsset,
  gateManifest,
  isolateUnprovenanced,
  isPersonNetAsset,
  scanForbiddenDatasetText,
} from './hilit-data-rights';
export type {
  AnnotationStatus,
  ConsentType,
  GateIssue,
  GatePurpose,
  ManifestGateResult,
  PersonNetAsset,
  PersonNetRightsManifest,
  PersonNetSplit,
  AssetGateResult,
} from './hilit-data-rights';
export {
  PERSONNET_IN_W, PERSONNET_IN_H, PERSONNET_PRODUCT_IN_W, PERSONNET_PRODUCT_IN_H,
  PERSONNET_STRIDE, PERSONNET_MODEL_ID, PERSONNET_MODEL_VERSION, PERSONNET_ARCHITECTURE,
  initPersonNetWeights, personNetParamCount, forwardPersonNet, decodePersonNet,
  centerSuppress, boxIou as personNetBoxIou, generalizedIou, restorePersonNetBoxes,
  letterboxForPersonNet, makePersonSynth, trainPersonNet, inferPersonNet,
  makePersonNetProvenance, validatePersonNetProvenance, serializePersonNetCheckpoint,
  parsePersonNetCheckpoint, emptyExternalLists, rgbaToPersonNetRgb,
} from './hilit-person-net';
export type {
  PersonNetBox, PersonNetWeights, PersonNetProvenance, PersonNetCheckpoint,
  PersonSynthSample, PersonNetTrainReport,
} from './hilit-person-net';
export {
  PERSONNET_PRODUCT_MODE, PERSONNET_AUTO_APPLY,
  productPersonNetMode, buildPersonNetDetectResult, runPersonNetDiagnose,
  decidePersonNetTrackingLink, candidateStateFromBoxes,
} from './hilit-person-net-runtime';
export type { PersonNetRuntimeMode, PersonNetDetectResult } from './hilit-person-net-runtime';
export {
  STAGE12_PROMOTION_TARGETS, evaluateSyntheticDetections, evaluateRealWorldOrBlock,
  stage12Promotion, averagePrecision50, subsetRecall, median as personNetMedian,
} from './hilit-person-net-metrics';
export type { SyntheticEvalReport, RealWorldEvalReport, PersonNetEvalRow } from './hilit-person-net-metrics';
export {
  PERSONNET_PLUS_MODEL_ID, PERSONNET_PLUS_MODEL_VERSION, PERSONNET_PLUS_ARCHITECTURE,
  PERSONNET_PLUS_PRODUCT_MODE, PERSONNET_PLUS_AUTO_APPLY,
  PLUS_STEM_C, initPersonNetPlusWeights, personNetPlusParamCount,
  preferSportPersonBoxes, trainPersonNetPlus, inferPersonNetPlus,
  personNetPlusPromotion, gatePersonNetPlus, rejectForbiddenManifestHints,
} from './hilit-person-net-plus';
export {
  S24_PROFILE_ID, S24_PROFILE_KIND, S24_MEASUREMENT_STATUS,
  S24_KR_USER_TABLE, EXYNOS_2400_CLUSTER, S24_KR_DEVICE,
  S24_KR_EXYNOS2400_PROFILE,
  APK_ANALYSIS_SHORT_SIDE, APK_ANALYSIS_FPS, APK_ANALYSIS_BUDGET_MS,
  PREVIEW_TARGET_FPS, PREVIEW_BUDGET_MS,
  S24_GB6_SINGLE_VIRTUAL, S24_NPU_NOTE,
  inferHostGeekbench6Single, scaleHostMsToS24, bandForAnalysisMs,
  trackingHeapMbEstimate,
} from './s24-exynos2400-profile';
export {
  IDENTITY_LIFECYCLE_VERSION, classifyIdentityLifecycle, advanceReentryState,
  mayUpdateUserAppearance, mapPipelineStateToLifecycle, edgeRelation,
  EDGE_GAP_OUT, OVERLAP_OCCLUSION,
  type IdentityLifecycleState, type IdentityLifecycleEvent,
  type EdgeRelation, type LifecycleObservation, type LifecycleDecision,
} from './identity-lifecycle';
export {
  DESCRIPTOR_FAMILY, COLOR_LAYOUT_V1, TEXTURE_LAYOUT_V1, PART_TEXTURE_LAYOUT_V1,
  HSV_AUX_LAYOUT_V1, LEARNED_PORT_LAYOUT, EXTRACTOR_CONTRACT,
  assertFiniteVector, isZeroVector, learnedDescriptorProvider,
} from './descriptor-layout';
export {
  describePartTexture, collapsePartTextureToBand8, partTextureSimilarity,
  PART_TEXTURE_SIZE, PART_TEXTURE_PER_REGION, PART_TEXTURE_MIN_ENERGY,
  type PartTextureDescriptor,
} from './part-texture';
export {
  describeHsvAux, compareHsvAux, applyHsvAuxiliary,
  HSV_AUX_SIZE, HSV_H_BINS, HSV_S_BINS, HSV_V_BINS,
  type HsvAuxDescriptor, type HsvAuxCompare, type HsvAuxStatus,
} from './hsv-aux';
export {
  ALIGNMENT_LEVEL, scoreRegionProxy, poseUncertainHold, partBoxes, clipShare,
  type AlignmentLevel, type PartVisibility, type RegionProxyObservation, type PartQuality,
} from './region-proxy';
export {
  createExemplarStore, addConfirmedExemplar, addAutoCandidate, firstAnchor,
  removeExemplar, clearExemplarStore, forgetExemplarIfSessionChanged,
  mapUiViewToReid, collisionOpportunity,
  MAX_CONFIRMED_EXEMPLARS, MAX_PER_VIEW, MAX_AUTO_CANDIDATES,
  PREV_MAX_MEMORY_SLOTS, PREV_MAX_USER_ANCHORS, PREV_MULTIVIEW_MAX, PREV_MULTIVIEW_PER_VIEW,
  type ExemplarView, type SubjectExemplar, type SubjectExemplarStore, type ConfirmationSource,
} from './subject-exemplar';
export {
  nextSearchDue, prioritizeCandidates, fixtureDetector, unavailableDetector,
  detectorProductBlocked, SEARCH_HZ_ABSENT, SEARCH_HZ_NEW,
  SEARCH_MIN_GAP_ABSENT_SEC, SEARCH_MIN_GAP_ACTIVE_SEC,
  type DetectorProviderKind, type DetectorCandidate, type DetectorQuery, type DetectorProviderResult,
} from './detector-provider';
export {
  composeReentryScore, judgeReentry, motionTolerance, temporalReady, REENTRY_SWEEP, REENTRY_TIME,
  type ReentryEvidence, type ReentryCandidateScore, type ReentryDecision, type ReentryAction,
} from './reentry-match';
export {
  histogramJaccard, histogramIntersection, jaccardFromIntersection, compareVisibleHistograms,
  type HistogramJaccardCompare,
} from './histogram-jaccard';
export {
  averageHash64, hammingDistance, isNearDuplicate, HASH_BITS, NEAR_DUPLICATE_HAMMING,
} from './perceptual-hash';
export {
  kReciprocalRerank, kReciprocalRerankCached, shouldNeighborRerank,
  JaccardNeighborCache, K_RECIPROCAL_POLICY,
  type RerankSample, type RerankCandidate, type RerankResultRow, type RerankSource,
} from './k-reciprocal-rerank';
export {
  mahalanobis2d, assessSpatialQuality, situationOf, tableWeights, SpatialWeightSmoother,
  browserCameraToQuality,
  SPATIAL_ASSUMPTIONS,
  type SpatialQuality, type SpatialQualityInput, type SpatialSituation, type SpatialCovariance,
  type MahalanobisResult, type CameraQualityInput,
} from './spatial-quality';
export {
  fuseAppearanceSpace, composeSpaceScore, spatialCuesFromBoxes, FUSION_POLICY,
  type FusionMode, type FusionInput, type FusionResult, type SpaceCues,
} from './space-appearance-fusion';
export {
  rankReentryCandidates,
  type RankReentryInput, type RankedReentryCandidate, type RankSpatialRef,
} from './reentry-rank';
export {
  StableViewSampler, STABLE_SAMPLE_POLICY,
  type StableSample, type CollectObservation, type AutoViewLabel, type StableSamplePolicy,
} from './stable-view-sampler';
export { ReidTimer, nowMs, type ReidTimingKey, type ReidTimingSample } from './reid-timing';
export {
  FrameFeatureCache,
  type PixelBox as FeatureCacheBox, type CachedFrameFeature,
} from './frame-feature-cache';
export {
  ReidScheduler, compareScheduleModes, retainCompetingCandidates,
  REID_SCHEDULER_POLICY, RUNTIME_ID_SWITCH_CONFIRMED, CALL_COUNT_IS_NOT_QUALITY,
  type ReidScheduleMode, type ReidCallReason, type SkipReason, type SwitchRiskLevel,
  type FrameSignals, type SchedulerDecision, type SchedulerLogEntry, type SchedulerMetrics,
} from './reid-scheduler';
export {
  sportSoftProfile, isKnownSport, SPORT_IDS,
  type SportId, type SportSoftProfile,
} from './sport-soft-profile';
export {
  makeHoldoutClip, runHoldoutTracker, runAllSports, runAblation, flagsForLayer, evaluateSizeBins,
  HOLDOUT_SEED, HOLDOUT_W, HOLDOUT_H, HOLDOUT_FPS, HOLDOUT_FRAMES, SIZE_BINS, ABLATION_LAYERS,
  type AblationLayer, type AblationFlags, type HoldoutClip, type HoldoutMetrics, type SizeBinRow,
  type HoldoutPerson,
} from './holdout-sports-eval';
export {
  ReacquireConfirmer, REACQUIRE_CONFIRM_POLICY, AUTO_REACQUIRE_DEFAULT_ON,
  type TrackState, type ConfirmBlockReason, type ConfirmContext, type ConfirmDecision,
  type RankedCandidate, type ReacquireConfirmPolicy,
} from './reacquire-confirmation';
export {
  gateReacquisitions, REACQUIRE_TRAJECTORY_GATE_ENABLED, TRAJECTORY_GATE_POLICY,
  assertGatePolicyMatchesConfirmPolicy,
  type TrajectoryGateInput, type TrajectoryGateMark, type TrajectoryGateSpan,
  type TrajectoryGateResult, type TrajectoryGatePolicy, type TentativeLifecycle,
} from './reacquire-trajectory-gate';
export {
  computeReacquireEvents, mergeReacquireMetrics,
  type ReacquireFrameLog, type ReacquireEvent, type ReacquireEventMetrics,
} from './reacquire-event-metrics';
export {
  runHoldoutV2, EVAL_V2_DEFAULTS,
  type EvalV2Options, type EvalV2Result, type DetectorLike,
} from './holdout-eval-v2';
export {
  AppearanceGallery, APPEARANCE_GALLERY_POLICY, APPEARANCE_BYTE_BUDGET_NOTE,
  type AppearanceCheckpointSnapshot, type AppearanceState, type GalleryObserveResult,
  type PersistMode, type PersistedGallerySample, type AppearanceChangeKind,
} from './appearance-gallery';
export {
  APPEARANCE_EMA_POLICY, emaAlpha, composeUpdateQuality, blendHistogramDescriptor,
  histogramL1Distance, updateAppearanceSummary, compatibleFeatureVersion,
  type AppearanceSummary, type QualityFactors, type VectorNormalize,
} from './appearance-ema';
export {
  ownerScopeId, videoScopeId, newAppearanceRunId, appearanceStoreKey, scopesCompatible,
  type AppearanceScope,
} from './gallery-scope';
export {
  containsFeaturePayload, stripFeaturePayload, assertNoFeaturePayload,
} from './feature-payload-guard';
export {
  planLookahead, refineProvisional, applyUserCorrection,
  LOOKAHEAD_BUDGET_SEC, LOOKAHEAD_BUDGET_LOW_SEC,
  type LookaheadSample, type ProvisionalResult,
} from './provisional-reacquire';
export {
  highlightIdentityFromLifecycle, highlightIdentityFromTrackState, keepDurationContract,
  SOURCE_MAX_SECONDS, RESULT_MAX_SECONDS,
  type HighlightIdentityPresence, type HighlightIdentityFact,
} from './highlight-identity';
export {
  normalizedToAnalysis, analysisToNormalized, rotateNormalized, confirmedViewsToPipeline, letterboxRoundtrip,
  type ConfirmedSubjectView,
} from './identity-coord';
export {
  PRODUCT_IDENTITY_APPLY, EXPERIMENT_OPTION, productIdentityApply, experimentMayApplyIdentity,
  buildIdentityApplyVerification, emptyIdentityApplyVerification,
  type IdentityApplyVerification,
} from './identity-recovery-experiment';
export {
  extractIdentityDescriptor, scoreIdentityPair, scoreIdentityAgainstMemories, assertDescriptorFamily,
  type IdentityDescriptor,
} from './identity-descriptor';
export {
  describeEquipmentProxy, compareEquipmentProxy,
  type EquipmentProxyDescriptor, type EquipmentProxyCompare,
  type EquipmentProxyStatus, type EquipmentProxyZone, type EquipmentProxyZoneName,
} from './equipment-proxy';
export {
  describeColorAttributes, compareColorAttributes, decideColorAttribute,
  colorAttributeAgreement, quantizeColor, areAdjacentColors,
  toAttributeTarget, maskTargetsByVisibility,
  COLOR_ATTRIBUTE_LABELS, COLOR_ATTRIBUTE_CLASSES, COLOR_ATTRIBUTE_CLASS_COUNT,
  COLOR_ATTRIBUTE_POLICY,
  type ColorName, type ColorAttributeLabel, type ColorAttributeRegion,
  type ColorAttributeDescriptor, type ColorAttributeCompare, type ColorAttributeTarget,
} from './color-attribute';
export {
  maskedAttributeLoss, maskedBatchLoss, softmax,
  type MaskedAttributeSample, type MaskedAttributeLoss,
} from './masked-attribute-loss';
export {
  createAttributeHead, predictAttributes, trainStep, trainAttributeHead,
  evaluateAttributeHead, serializeAttributeHead, deserializeAttributeHead,
  buildAttributeFeatures,
  HILIT_ATTRIBUTE_SCHEMA_V1, EQUIPMENT_ATTRIBUTES, COLOR_ATTRIBUTES,
  ATTRIBUTE_FEATURE_LAYOUT,
  type AttributeSpec, type AttributeHeadWeights, type AttributePrediction,
  type AttributeTrainingSample, type AttributeTrainReport, type AttributeEvalReport,
} from './attribute-head';
export {
  makeSyntheticClip, CLIP_SCENARIOS, CLIP_W, CLIP_H,
  type ClipScenario, type ClipFrame, type SyntheticClip, type SportsSampler,
} from './synthetic-clip';
export {
  DETECTOR_SCORE_MIN, DETECTOR_THRESHOLD_BASIS, scoreMinFor,
  type DetectorPurpose,
} from './detector-thresholds';
export {
  makeSportsSample, makeSportsSet,
  SPORTS_IN_W, SPORTS_IN_H, SPORTS_IN_C,
  type SportsSynthOptions,
} from './hilit-sports-synth';
export {
  initPoseWeights, trainPoseNet, evaluatePoseNet, poseForward, decodePose,
  makePoseSample, poseTargetHeatmap, poseInputFromRgba, poseParamCount, poseSigmoid,
  POSE_NET_JOINTS, POSE_K, POSE_IN_W, POSE_IN_H, POSE_OUT_W, POSE_OUT_H,
  POSE_SCORE_MIN, POSE_VISIBILITY_MIN, POSE_MODEL_ID,
  type PoseWeights, type PoseNetJoint, type DecodedJoint, type PoseSample,
  type PoseTrainReport, type PoseEvalReport,
} from './hilit-pose-net';
export { loadPoseRuntime } from './pose-runtime';
export {
  predictionGate, predictionRejectOnly, assertEvidenceFreeOfPrediction,
  assertNeverAccepts, PREDICTION_GATE_POLICY,
  PREDICTION_VERDICT_ACCEPT, PRODUCIBLE_VERDICTS,
  type PredictionVerdict, type PredictionGateResult,
} from './prediction-identity-firewall';
export {
  TrackRegionPredictor, poseVelocity, fuseVelocity, TRACK_REGION_POLICY,
  OBSERVATION_CENTRIC_GAP_SEC,
  type TrackRegionObservation, type TrackRegionPrediction,
  type OcclusionState, type PredictionJoint, type PredictionBox, type PredictionPoint,
} from './track-region-prediction';
export {
  describeEmbeddingGroups, compareEmbeddingGroups, groupVisibility, groupStatuses,
  EMBEDDING_GROUPS, PRIMARY_GROUPS, LAST_RESORT_GROUP, PRIMARY_WEIGHT,
  LAST_RESORT_POLICY, GROUP_LAYOUT, CARRY_ZONE_NAMES,
  type EmbeddingGroupName, type EmbeddingGroupDescriptor, type GroupObservation,
  type GroupStatus, type GroupCompare, type GroupDecisionSource, type CarryZoneName,
} from './embedding-groups';
export {
  createConfirmedOtherGallery, fillFromAnchorFrame, addUserRejected, judgeAgainstConfirmedOthers,
  forgetIfScopeChanged, iou as galleryIoU,
  CONFIRMED_OTHER_POLICY, CONFIRMED_OTHER_MARGIN,
  type ConfirmedOtherGallery, type ConfirmedOtherEntry, type ConfirmedOtherVerdict,
  type AnchorProposal, type GalleryBox,
} from './confirmed-other-gallery';
export {
  IdentityHypothesisTracker, IDENTITY_HYPOTHESIS_POLICY,
  type IdentityHypothesis, type IdentityHypothesisFrame,
  type IdentityHypothesisLabel, type IdentityHypothesisSample,
} from './identity-hypothesis';
export {
  EDIT_SPAN_REENTRY_DEFAULT, EDIT_SPAN_REENTRY_EXPERIMENT, EDIT_SPAN_FAST_SEC, EDIT_SPAN_MID_SEC,
  EDIT_SPAN_MEASUREMENT, EDIT_SPAN_CAPS, PRODUCT_DEFAULT_RELEASE_GATES,
  planEditSpanBands, oldLookaheadEnd, runEditSpanSearch, reviseTrackingPoints, applyEditSpanChoice,
  runDevReentryDiagnostic, releaseGateTable, inclusionForEvent, wilsonInterval95, rateReport,
  bandProgressMessage, devReentryCases, runOneDevCase, exportGateForLinks,
  type EditSpanResult, type EditSpanQuestion, type ReentryEventLabel,
} from './edit-span-reentry';
export {
  reverseTrackVerify, createReverseFrameBuffer, pushReverseFrame, downsampleReverseGray,
  REVERSE_TRACK_BUDGET_SEC, REVERSE_MAX_FRAMES, REVERSE_MAX_SIDE, REVERSE_AGREE_IOU,
  type ReverseTrackFrame, type ReverseTrackResult, type ReverseFrameBuffer,
} from './reverse-track';
export {
  assignCandidatesToTracklets, runFixtureCandidates, runUnavailableCandidates,
  newCandidateId, queryFromLifecycle, nextSearchDue as candidateNextSearchDue,
  CANDIDATE_IOU_ASSIGN, CANDIDATE_CENTER_ASSIGN_BODIES,
  CANDIDATE_MAX_SIZE_RATIO, CANDIDATE_PREDICT_MAX_SEC,
  type PersistentCandidate, type CandidateTracklet,
} from './candidate-identity';
export {
  runIdentityRecoveryStep,
  type IdentityRecoveryStepInput, type IdentityRecoveryStepResult,
} from './identity-recovery-runtime';
export {
  evaluateReentryDecision, accumulateIdentityEval, emptyIdentityEvalTotals, formatRate,
  type IdentityGroundTruth, type IdentityEvalRow, type IdentityEvalTotals,
} from './identity-eval';
export { MultiViewReid, compareVisibleParts, REENTRY_POLICY,
  type AppearanceView, type ViewObservation, type ReentryCandidate } from './multiview-reid';
export {
  TEMPORAL_CONTEXT_VERSION, TEMPORAL_CONTEXT_POLICY, runTemporalContext, patchObservations, contextIou, planContextEvents,
  type ContextBox, type ContextFrame, type ContextCandidate, type TemporalContextInput, type TemporalContextResult,
} from './temporal-context';
export {SCOUT_JOINT_ORDER,scoutSequenceFeatures,validateScoutFeatureModel,predictScoutFeatures,
  type ScoutJoint,type ScoutFrame,type ScoutFeatureModel} from './scout-feature-mlp';
export {SCOUT_POSE_MAP,scoutPoseCrop,scoutPoseFrame,type ScoutPosePoint,type ScoutPoseCrop} from './scout-pose';
