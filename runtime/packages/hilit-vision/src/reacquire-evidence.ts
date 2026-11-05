/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·8f75a66a @license @preserve */
/* 재탐색 근거. 검출과 동일인 판단을 한 칸에 넣지 않는다.

사람이 보였다고 해서 지정한 사람을 다시 잡은 것이 아니다.
제품 경로는 이 단계에서 상자를 자동으로 바꾸지 않는다.
*/

import type { ReacquireDecision } from './detector-reacquire';

export type SearchIdentityState =
  | 'person_detected'
  | 'target_candidate'
  | 'identity_confirmed'
  | 'hold'
  | 'detect_failed';

export interface ReacquireEvidence {
  proposalCount: number;
  searchScope: string;
  gapSeconds: number;
  motionErrorBodies: number | null;
  appearanceSelf: number | null;
  appearanceDecision: 'accept' | 'reject' | 'hold';
  uniqueMargin: number;
  detectorDecision: ReacquireDecision['action'];
  detectorReason: string;
  identityState: SearchIdentityState;
  appliedToTracker: false;
}

export function classifySearchState(input: {
  outcome: string;
  proposalCount: number;
  decision: ReacquireDecision;
}): SearchIdentityState {
  if (input.outcome === 'error' || input.outcome === 'unavailable' || input.outcome === 'cancelled') {
    return 'detect_failed';
  }
  if (input.outcome === 'empty' || input.proposalCount === 0) return 'detect_failed';
  if (input.decision.action === 'confirm') return 'identity_confirmed';
  if (input.decision.reason === 'not-unique' || input.decision.reason.startsWith('appearance-')) {
    return input.decision.reason === 'not-unique' ? 'target_candidate' : 'hold';
  }
  if (input.proposalCount >= 1) return 'person_detected';
  return 'detect_failed';
}

/** 이번 단계 제품 정책. confirm 이 나와도 추적용 상자를 바꾸지 않는다. */
export function productMayApplyIdentity(_state: SearchIdentityState): false {
  return false;
}

export function buildReacquireEvidence(input: {
  outcome: string;
  proposalCount: number;
  searchScope: string;
  gapSeconds: number;
  motionErrorBodies: number | null;
  appearanceSelf: number | null;
  appearanceDecision: 'accept' | 'reject' | 'hold';
  uniqueMargin: number;
  decision: ReacquireDecision;
}): ReacquireEvidence {
  const identityState = classifySearchState({
    outcome: input.outcome,
    proposalCount: input.proposalCount,
    decision: input.decision,
  });
  return {
    proposalCount: input.proposalCount,
    searchScope: input.searchScope,
    gapSeconds: input.gapSeconds,
    motionErrorBodies: input.motionErrorBodies,
    appearanceSelf: input.appearanceSelf,
    appearanceDecision: input.appearanceDecision,
    uniqueMargin: input.uniqueMargin,
    detectorDecision: input.decision.action,
    detectorReason: input.decision.reason,
    identityState,
    appliedToTracker: false,
  };
}
