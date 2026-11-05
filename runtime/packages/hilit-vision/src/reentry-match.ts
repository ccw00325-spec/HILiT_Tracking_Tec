/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b0481a9b @license @preserve */
/* 재식별 근거를 칸마다 남긴다. 점수는 확률이 아니다.

평가 정답(화면 안 존재·정답 ID·정답 상자)은 받지 않는다.
한 명뿐이라고 유일하지 않다. 한 명뿐이라고 항상 거절하지도 않는다.
품질을 못 잰 경쟁자를 빼고 승자를 정하지 않는다.
머리 한 부위만으로 자동 재획득하지 않는다.
이전 이탈 상태만으로 모든 재진입을 거절하지 않는다.
*/

import { applyHsvAuxiliary, type HsvAuxCompare } from './hsv-aux';
import type { IdentityHypothesisFrame } from './identity-hypothesis';

export const REENTRY_SWEEP = Object.freeze({
  acceptance: [0.78, 0.82, 0.86, 0.90] as const,
  margin: [0.08, 0.12, 0.16] as const,
  minQuality: [0.50, 0.60, 0.70] as const,
  /** 개발 비교용 기본. 학습 임베딩에 이식하지 않는다. */
  defaultAccept: 0.82,
  defaultMargin: 0.12,
  defaultMinQuality: 0.60,
});

export const REENTRY_TIME = Object.freeze({
  minObservations: 3,
  minSpanSec: 0.2,
  maxGapSec: 0.5,
});

export interface ReentryEvidence {
  globalAppearance: number | null;
  visiblePartAppearance: number | null;
  colorConsistency: number | null;
  hsvAux: HsvAuxCompare | null;
  observationQuality: number | null;
  exitEntryPlausible: boolean | null;
  trackletContinuous: boolean | null;
  rivalMargin: number | null;
  knownOtherConflict: boolean;
  simultaneousPresenceConflict?: boolean;
  evidenceCount: number;
  headOnly: boolean;
  minEvidenceMet: boolean;
  bodyPartScores?: [number | null, number | null, number | null];
  bodyContradictions?: number;
  equipmentConsistency?: number | null;
  equipmentReliable?: boolean;
  equipmentContradictions?: number;
  unmaskedGlobalAppearance?: number | null;
  confirmedOtherSimilarity?: number | null;
  /** 부위 색 속성이 얼마나 같은 말을 하는지. unknown 부위는 빠진 값이다. */
  colorAttributeAgreement?: number | null;
  colorAttributeUsedRegions?: number;
  colorAttributeMaskedRegions?: number;
  colorAttributeContradictions?: number;
  /** 다섯 갈래(머리·상체·하체·정체성·휴대물품) 대조 결과. */
  groupAppearance?: number | null;
  /** 1차 네 갈래만으로 낸 점수. */
  groupPrimaryAppearance?: number | null;
  /** 정체성 갈래 값. 참고용이며 쓰였는지는 groupIdentityUsed 가 말한다. */
  groupIdentityAppearance?: number | null;
  groupDecidedBy?: 'primary' | 'primary-with-identity-hint' | 'identity-last-resort' | 'none';
  groupIdentityUsed?: boolean;
  groupUsedPrimary?: number;
  groupMasked?: number;
  groupContradictions?: number;
}

export interface ReentryCandidateScore {
  id: string;
  box: { x: number; y: number; width: number; height: number };
  tSec: number;
  quality: number | null;
  evidence: ReentryEvidence;
  combined: number | null;
  /** 이 후보 궤적의 실제 관측 시각. 없으면 timeReady만 본다. */
  observationTimes?: readonly number[];
  /** 순위용. 외형 문턱과 분리한다. 없으면 composeReentryScore. */
  rankScore?: number | null;
  appearanceScore?: number | null;
  fusionHold?: boolean;
}

export type ReentryAction = 'waiting' | 'needs_user' | 'provisional' | 'reject';

export interface ReentryDecision {
  action: ReentryAction;
  candidateId: string | null;
  reason: string;
  score: number | null;
  margin: number | null;
  identityConfirmed: false;
  eligibleForProductAutoReacquire: false;
  scoreIsProbability: false;
}

export function composeReentryScore(ev: ReentryEvidence): number | null {
  if (!ev.minEvidenceMet || ev.headOnly) return null;
  const base = ev.visiblePartAppearance ?? ev.globalAppearance;
  if (base == null) return null;
  const aux = ev.hsvAux
    ? applyHsvAuxiliary(ev.colorConsistency ?? base, ev.hsvAux).score
    : (ev.colorConsistency ?? base);
  if (aux == null) return null;
  return Math.max(0, Math.min(1, base * 0.78 + aux * 0.22));
}

export interface ReentryJudgeInput {
  candidates: readonly ReentryCandidateScore[];
  accept?: number;
  margin?: number;
  minQuality?: number;
  sceneCut?: boolean;
  longAbsence?: boolean;
  /** 관측 시간열 충족. 정답 재등장이 아니다. */
  timeReady?: boolean;
  /** H0/H1/H2 상태 추적 결과. 실제 실행 경로에서는 반드시 전달한다. */
  hypotheses?: IdentityHypothesisFrame | null;
}

function none(reason: string): ReentryDecision {
  const reject = reason === 'all-unsuitable'
    || reason === 'known-other-conflict'
    || reason === 'simultaneous-presence-conflict';
  return {
    action: reject ? 'reject' : 'waiting',
    candidateId: null,
    reason,
    score: null,
    margin: null,
    identityConfirmed: false,
    eligibleForProductAutoReacquire: false,
    scoreIsProbability: false,
  };
}

function hold(reason: string, score: number | null, margin: number | null): ReentryDecision {
  return {
    action: 'needs_user',
    candidateId: null,
    reason,
    score,
    margin,
    identityConfirmed: false,
    eligibleForProductAutoReacquire: false,
    scoreIsProbability: false,
  };
}

export function judgeReentry(input: ReentryJudgeInput): ReentryDecision {
  const accept = input.accept ?? REENTRY_SWEEP.defaultAccept;
  const margin = input.margin ?? REENTRY_SWEEP.defaultMargin;
  const minQ = input.minQuality ?? REENTRY_SWEEP.defaultMinQuality;

  if (!input.candidates.length) return none('no-candidate');
  if (input.candidates.some((c) => c.quality == null || !Number.isFinite(c.quality))) {
    return none('unmeasured-competitor');
  }
  if (input.candidates.some((c) => !Number.isFinite(c.tSec))) return none('invalid-time');

  const ranked = input.candidates
    .map((c) => ({
      c,
      appearance: c.appearanceScore ?? composeReentryScore(c.evidence),
      rank: c.rankScore ?? c.appearanceScore ?? composeReentryScore(c.evidence),
    }))
    .sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1));

  const best = ranked[0];
  const rival = ranked[1];
  /* 절대 문턱·1/2위 간격은 외형. 공간으로 수락 문턱을 넘기지 않는다. */
  const bestScore = best.appearance;
  const rivalScore = rival?.appearance ?? null;
  const gap = bestScore == null ? null : bestScore - (rivalScore ?? 0);

  if (best.c.fusionHold) return hold('appearance-and-space-weak-hold', bestScore, gap);
  if (best.c.quality != null && best.c.quality < minQ) return none('quality-below-min');
  if (best.c.evidence.headOnly) return none('head-only-forbidden');
  if (!best.c.evidence.minEvidenceMet) return none('min-evidence-not-met');
  if (best.c.evidence.knownOtherConflict) return none('known-other-conflict');
  if (best.c.evidence.simultaneousPresenceConflict === true) return none('simultaneous-presence-conflict');
  if (bestScore == null || bestScore < accept) return none('all-unsuitable');
  const winnerTime = best.c.observationTimes
    ? temporalReady(best.c.observationTimes)
    : { ready: input.timeReady !== false, reason: input.timeReady === false ? 'need-more-observations' : 'caller-time' };
  if (input.timeReady === false || winnerTime.ready === false) return none('need-more-observations');

  const indistinguishable = rivalScore != null
    && bestScore != null
    && Math.abs(bestScore - rivalScore) <= 0.02
    && rivalScore >= accept - 0.04;
  if (indistinguishable) {
    return hold('indistinguishable-appearance', bestScore, gap);
  }

  if (gap != null && rival && gap < margin) {
    return hold('close-rivals', bestScore, gap);
  }

  if (input.hypotheses) {
    const h = input.hypotheses;
    if (!h.h1 || h.h1.candidateId !== best.c.id) return hold('hypothesis-winner-mismatch', bestScore, gap);
    if ((h.gainOverH0 ?? -1) < 0.28) return hold('h1-not-above-h0', bestScore, h.gainOverH0);
    if (h.h2 && (h.runnerUpMargin ?? 0) < margin) return hold('h1-h2-too-close', bestScore, h.runnerUpMargin);
    if (!h.h1.stable) return hold('h1-temporal-unstable', bestScore, h.gainOverH0);
    if (!h.h1.futureVerified) return hold('h1-needs-future-observation', bestScore, h.gainOverH0);
    if (!h.decisionReady) return hold(h.reason, bestScore, h.gainOverH0);
  }

  const timeOk = winnerTime.ready;
  const trajectoryOk = best.c.evidence.trackletContinuous === true
    || best.c.evidence.exitEntryPlausible === true
    || input.longAbsence === true
    || input.sceneCut === true;
  const evidenceComplete = timeOk
    && best.c.evidence.minEvidenceMet
    && !best.c.evidence.headOnly
    && (best.c.quality ?? 0) >= minQ
    && bestScore >= accept;

  if (ranked.length === 1) {
    if (evidenceComplete && trajectoryOk && best.c.evidence.exitEntryPlausible !== false) {
      return {
        action: 'provisional',
        candidateId: best.c.id,
        reason: 'single-candidate-evidence-met',
        score: bestScore,
        margin: gap,
        identityConfirmed: false,
        eligibleForProductAutoReacquire: false,
        scoreIsProbability: false,
      };
    }
    return hold('single-candidate-needs-more-evidence', bestScore, gap);
  }

  if (best.c.evidence.exitEntryPlausible === false && !input.sceneCut && !input.longAbsence) {
    return none('implausible-reentry');
  }
  if (!evidenceComplete) return hold('insufficient-uniqueness-or-time', bestScore, gap);

  return {
    action: 'provisional',
    candidateId: best.c.id,
    reason: 'distinct-appearance-provisional',
    score: bestScore,
    margin: gap,
    identityConfirmed: false,
    eligibleForProductAutoReacquire: false,
    scoreIsProbability: false,
  };
}

export function motionTolerance(input: {
  dtSec: number;
  boxHeight: number;
  cameraMoving: boolean;
}): { maxCenterBodies: number; maxSizeRatio: number } {
  const dt = Math.max(0.04, input.dtSec);
  const base = 0.5 + 1.8 * Math.min(1, dt / 0.2);
  const cam = input.cameraMoving ? 1.35 : 1;
  const size = 1.4 + Math.min(0.5, dt * 0.8);
  return {
    maxCenterBodies: base * cam,
    maxSizeRatio: size * (input.cameraMoving ? 1.15 : 1),
  };
}

export function temporalReady(times: readonly number[]): { ready: boolean; reason: string } {
  if (times.some((t, i) => i > 0 && t <= times[i - 1])) return { ready: false, reason: 'non-increasing-time' };
  if (times.length < REENTRY_TIME.minObservations) return { ready: false, reason: 'need-more-observations' };
  const span = times[times.length - 1] - times[0];
  if (span + 1e-9 < REENTRY_TIME.minSpanSec) return { ready: false, reason: 'span-too-short' };
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] - times[i - 1] > REENTRY_TIME.maxGapSec) return { ready: false, reason: 'gap-too-long' };
  }
  return { ready: true, reason: 'temporal-ok' };
}
