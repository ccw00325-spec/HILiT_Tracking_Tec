/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·5b443bf7 @license @preserve */
/* 로컬 실험 경로. 운영 기본값을 바꾸지 않는다.

productMayApplyIdentity 는 항상 false.
실험 허용은 experimentEnabled && candidateReady 가 아니다.
검증 객체의 칸이 모두 맞을 때만 잠정 상자를 시험한다.
크레딧·권한·업로드 제한을 우회하지 않는다.
*/

import type { ReentryDecision } from './reentry-match';
import type { ProvisionalResult } from './provisional-reacquire';

export const PRODUCT_IDENTITY_APPLY = false;
export const EXPERIMENT_OPTION = 'identityRecoveryExperiment';

export function productIdentityApply(): false {
  return PRODUCT_IDENTITY_APPLY;
}

export interface IdentityApplyVerification {
  candidateIdMatch: boolean;
  spanVerified: boolean;
  appearanceMet: boolean;
  timeMet: boolean;
  /** 실제 이전 프레임을 읽었을 때만 true. 기하 외삽은 true가 아니다. */
  reverseTrackVerified: boolean | 'not-required';
  noSceneCut: boolean;
  memoryUpdateForbidden: boolean;
}

export function emptyIdentityApplyVerification(): IdentityApplyVerification {
  return {
    candidateIdMatch: false,
    spanVerified: false,
    appearanceMet: false,
    timeMet: false,
    reverseTrackVerified: false,
    noSceneCut: false,
    memoryUpdateForbidden: false,
  };
}

export function buildIdentityApplyVerification(input: {
  decision: ReentryDecision;
  provisional: ProvisionalResult | null;
  expectedCandidateId: string | null;
  timeReady: boolean;
  reverseTrackVerified: boolean | 'not-required';
  sceneCut: boolean;
}): IdentityApplyVerification {
  const p = input.provisional;
  const idOk = p != null
    && p.candidateId != null
    && p.candidateId === input.decision.candidateId
    && (input.expectedCandidateId == null || p.candidateId === input.expectedCandidateId);
  return {
    candidateIdMatch: idOk,
    spanVerified: p?.status === 'provisional' && p.span != null && p.span.end >= p.span.start,
    appearanceMet: input.decision.action === 'provisional'
      && input.decision.score != null
      && Number.isFinite(input.decision.score),
    timeMet: input.timeReady,
    reverseTrackVerified: input.reverseTrackVerified,
    noSceneCut: !input.sceneCut,
    memoryUpdateForbidden: p != null && p.updatesAnchor === false && p.identityConfirmed === false,
  };
}

export function experimentMayApplyIdentity(input: {
  experimentEnabled: boolean;
  decision: ReentryDecision;
  provisional: ProvisionalResult | null;
  verification?: IdentityApplyVerification;
}): boolean {
  if (!input.experimentEnabled) return false;
  if (input.decision.eligibleForProductAutoReacquire) return false;
  if (input.decision.action !== 'provisional') return false;
  if (!input.provisional || input.provisional.status !== 'provisional') return false;
  if (input.provisional.updatesAnchor) return false;
  if (input.provisional.identityConfirmed) return false;
  const v = input.verification;
  if (!v) return false;
  if (!v.candidateIdMatch) return false;
  if (!v.spanVerified) return false;
  if (!v.appearanceMet) return false;
  if (!v.timeMet) return false;
  if (v.reverseTrackVerified === false) return false;
  if (!v.noSceneCut) return false;
  if (!v.memoryUpdateForbidden) return false;
  return true;
}
