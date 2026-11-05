/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f0967945 @license @preserve */
/* 신원 복구의 실제 실행 경로.

관측만 받는다. 평가 정답은 넣지 않는다.
특징 추출 → 후보 궤적 → 재식별 → 역추적 → 실험 적용 게이트.
운영 제품 승격은 여기서도 항상 닫혀 있다.
*/

import { classifyIdentityLifecycle, advanceReentryState, mayUpdateUserAppearance, type IdentityLifecycleState, type LifecycleObservation } from './identity-lifecycle';
import { judgeReentry, temporalReady, composeReentryScore, type ReentryCandidateScore, type ReentryDecision } from './reentry-match';
import { refineProvisional, type ProvisionalResult, type LookaheadSample } from './provisional-reacquire';
import { experimentMayApplyIdentity, buildIdentityApplyVerification, productIdentityApply, type IdentityApplyVerification } from './identity-recovery-experiment';
import { extractIdentityDescriptor, scoreIdentityAgainstMemories, type IdentityDescriptor } from './identity-descriptor';
import { IdentityHypothesisTracker, type IdentityHypothesisFrame } from './identity-hypothesis';
import { reverseTrackVerify, type ReverseTrackFrame, type ReverseTrackResult } from './reverse-track';
import type { PersistentCandidate } from './candidate-identity';
import type { PixelBox } from './motion-tracker';
import { rankReentryCandidates, type RankSpatialRef } from './reentry-rank';
import type { FusionMode } from './space-appearance-fusion';
import type { SpatialQualityInput } from './spatial-quality';
import { StableViewSampler } from './stable-view-sampler';
import { nowMs, type ReidTimer } from './reid-timing';
import type { Descriptor } from './appearance';

export interface IdentityRecoveryStepInput {
  experimentEnabled: boolean;
  previousLifecycle: IdentityLifecycleState;
  observation: LifecycleObservation;
  memory: IdentityDescriptor | null;
  memories?: readonly IdentityDescriptor[];
  hypothesisTracker?: IdentityHypothesisTracker | null;
  pixels: { rgb: Uint8Array | Uint8ClampedArray; w: number; h: number; hasAlpha?: boolean } | null;
  candidates: readonly PersistentCandidate[];
  candidateCrops: ReadonlyArray<{
    id: string;
    rgb: Uint8Array | Uint8ClampedArray;
    w: number;
    h: number;
    hasAlpha?: boolean;
    overlapRisk?: number;
  }>;
  candidateTimes: readonly number[];
  sceneCut: boolean;
  longAbsence?: boolean;
  reverseFrames: readonly ReverseTrackFrame[] | null;
  forwardAt: ReadonlyArray<{ tSec: number; box: PixelBox }>;
  lookahead: readonly LookaheadSample[];
  signal?: { aborted?: boolean };
  /** 실험 경로 전용. 운영 자동 재획득을 켜지 않는다. */
  refine?: {
    fusionMode?: FusionMode;
    enableNeighborRerank?: boolean;
    spatialQuality?: SpatialQualityInput | null;
    spatialRef?: RankSpatialRef | null;
    sampler?: StableViewSampler | null;
    timer?: ReidTimer | null;
    /** 현재 추적 중인 대상 crop. 재등장 후보 crop 으로 표본을 만들지 않는다. */
    tracked?: {
      trackId: string;
      descriptor: Descriptor;
      quality: number;
      box: { x: number; y: number; width: number; height: number };
      rgb?: ArrayLike<number>;
      rgbW?: number;
      rgbH?: number;
      hasAlpha?: boolean;
    } | null;
  };
}

export interface IdentityRecoveryStepResult {
  lifecycle: IdentityLifecycleState;
  freezeMemory: boolean;
  mayUpdateMemory: boolean;
  extracted: IdentityDescriptor[];
  decision: ReentryDecision;
  hypotheses: IdentityHypothesisFrame | null;
  provisional: ProvisionalResult | null;
  reverse: ReverseTrackResult | null;
  verification: IdentityApplyVerification;
  mayApplyExperiment: boolean;
  productMayApply: false;
  trackerAdoptBox: { x: number; y: number; width: number; height: number } | null;
}

function cropToDescriptor(
  crop: IdentityRecoveryStepInput['candidateCrops'][number],
  cand: PersistentCandidate | undefined,
  frame: { width: number; height: number },
): IdentityDescriptor {
  return extractIdentityDescriptor(crop.rgb, crop.w, crop.h, {
    hasAlpha: crop.hasAlpha,
    box: cand?.box ?? { x: 0, y: 0, width: crop.w, height: crop.h },
    frame,
    overlapRisk: crop.overlapRisk,
  });
}

export function runIdentityRecoveryStep(input: IdentityRecoveryStepInput): IdentityRecoveryStepResult {
  const life = classifyIdentityLifecycle(input.previousLifecycle, {
    ...input.observation,
    sceneCut: input.sceneCut || input.observation.sceneCut,
  });
  const frame = input.observation.frame;
  const extracted: IdentityDescriptor[] = [];
  const scored: ReentryCandidateScore[] = [];

  for (const crop of input.candidateCrops) {
    const cand = input.candidates.find((c) => c.id === crop.id);
    const desc = cropToDescriptor(crop, cand, frame);
    extracted.push(desc);
    const memories = input.memories?.length ? input.memories : input.memory ? [input.memory] : [];
    if (!memories.length) continue;
    const pair = scoreIdentityAgainstMemories(memories, desc);
    if (!pair) continue;
    pair.evidence.exitEntryPlausible = cand?.enteredFromEdge ?? null;
    pair.evidence.trackletContinuous = (cand?.trackletHits ?? 0) >= 3;
    pair.evidence.knownOtherConflict = cand?.knownOtherConflict === true;
    pair.evidence.simultaneousPresenceConflict = cand?.simultaneousPresenceConflict === true;
    pair.evidence.confirmedOtherSimilarity = cand?.confirmedOtherSimilarity ?? null;
    scored.push({
      id: crop.id,
      box: cand?.box ?? { x: 0, y: 0, width: crop.w, height: crop.h },
      tSec: cand?.tSec ?? input.observation.tSec,
      quality: desc.quality.score,
      evidence: pair.evidence,
      combined: pair.combined ?? composeReentryScore(pair.evidence),
      observationTimes: input.candidateTimes,
    });
  }

  const time = temporalReady(input.candidateTimes);
  const refine = input.refine;
  const t0rank = refine?.timer ? nowMs() : 0;
  let ranked = scored;
  if (refine && ((refine.fusionMode && refine.fusionMode !== 'off') || refine.enableNeighborRerank)) {
    const descMap = new Map(extracted.map((d, i) => [input.candidateCrops[i]?.id, d.color] as const));
    const gallery = refine.sampler?.gallery().map((s) => ({
      id: `${s.source}:${s.tSec}`,
      descriptor: s.descriptor,
      source: s.source === 'user_anchor' ? 'user_anchor' as const : 'verified_auto' as const,
      trackId: s.trackId,
      tSec: s.tSec,
      hash: s.hash,
    })) ?? [];
    ranked = rankReentryCandidates({
      candidates: scored,
      descriptors: descMap,
      gallery,
      enableNeighborRerank: refine.enableNeighborRerank === true,
      fusionMode: refine.fusionMode ?? 'off',
      spatialQuality: refine.spatialQuality,
      spatialRef: refine.spatialRef,
    });
  }
  if (refine?.timer) refine.timer.mark('direct_compare', nowMs() - t0rank, { candidates: ranked.length });

  const hypotheses = input.hypothesisTracker
    ? input.hypothesisTracker.observe(input.observation.tSec, ranked)
    : null;
  const decision = judgeReentry({
    candidates: ranked,
    timeReady: time.ready,
    sceneCut: input.sceneCut,
    longAbsence: input.longAbsence,
    hypotheses,
  });

  let reverse: ReverseTrackResult | null = null;
  if (decision.action === 'provisional' && decision.candidateId && input.reverseFrames && input.reverseFrames.length) {
    const reverseStart = ranked.find((c) => c.id === decision.candidateId);
    reverse = reverseTrackVerify({
      frames: input.reverseFrames,
      startBox: reverseStart?.box ?? { x: 0, y: 0, width: 8, height: 8 },
      startVideoTSec: reverseStart?.tSec ?? input.observation.tSec,
      forwardAt: input.forwardAt,
      signal: input.signal,
    });
  }

  const appearanceStillHolds = decision.action === 'provisional'
    && decision.score != null
    && (reverse == null || reverse.status === 'verified' || reverse.status === 'insufficient-frames');
  const provisional = refineProvisional({
    decision,
    candidateId: decision.candidateId,
    appearanceStillHolds,
    forward: hypotheses?.h1?.samples.map((s) => ({ tSec: s.tSec, box: s.box })) ?? input.lookahead,
    reverseTrack: reverse,
  });

  const reverseVerified: boolean | 'not-required' = input.reverseFrames && input.reverseFrames.length
    ? reverse?.status === 'verified'
    : 'not-required';

  const verification = buildIdentityApplyVerification({
    decision,
    provisional,
    expectedCandidateId: decision.candidateId,
    timeReady: hypotheses ? hypotheses.h1?.futureVerified === true : time.ready,
    reverseTrackVerified: reverseVerified,
    sceneCut: input.sceneCut,
  });

  const mayApply = experimentMayApplyIdentity({
    experimentEnabled: input.experimentEnabled,
    decision,
    provisional,
    verification,
  });

  const nextState = advanceReentryState(
    life.state,
    mayApply ? 'provisional' : decision.action === 'needs_user' ? 'needs_user' : decision.action === 'provisional' ? 'verifying' : decision.action === 'reject' ? 'reject' : 'candidate',
  );

  const chosen = mayApply && decision.candidateId
    ? ranked.find((c) => c.id === decision.candidateId)
    : null;

  /* 후보 crop 은 표본이 아니다. 안정 추적 관측만 샘플러에 넣는다. */
  if (refine?.sampler && refine.tracked && !input.sceneCut) {
    const lost = !input.observation.observed || life.freezeMemory;
    const tracked = refine.tracked;
    const obs = {
      tSec: input.observation.tSec,
      trackId: tracked.trackId,
      descriptor: tracked.descriptor,
      quality: tracked.quality,
      visibility: [true, true, true] as [boolean, boolean, boolean],
      box: tracked.box,
      rgb: tracked.rgb,
      rgbW: tracked.rgbW,
      rgbH: tracked.rgbH,
      hasAlpha: tracked.hasAlpha,
      overlapOthers: (input.observation.overlapOthers ?? 0) > 0.22,
      crossing: (input.observation.overlapOthers ?? 0) > 0.35,
      appearanceJump: false,
      trajectoryBreak: false,
      knownOtherConflict: false,
      cameraOk: true,
      gmcOk: true,
      trackingLost: lost,
      rivalSimilarity: ranked.length > 1 ? (ranked[1].appearanceScore ?? null) : null,
    };
    refine.sampler.consider(obs);
    if (!lost) refine.sampler.verifyWithFuture(obs);
  }

  return {
    lifecycle: mayApply ? 'REACQUIRED_PROVISIONAL' : nextState,
    freezeMemory: life.freezeMemory || !mayUpdateUserAppearance(nextState),
    mayUpdateMemory: mayUpdateUserAppearance(nextState) && !mayApply,
    extracted,
    decision,
    hypotheses,
    provisional,
    reverse,
    verification,
    mayApplyExperiment: mayApply,
    productMayApply: productIdentityApply(),
    trackerAdoptBox: chosen ? { ...chosen.box } : null,
  };
}
