/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b6716ed3 @license @preserve */
/* 평가 정답은 여기만 본다. 판정기·실험 적용 게이트에 넣지 않는다.

같은 관측이면 정답 라벨이 바뀌어도 판정은 같다.
정답만 바꾸면 평가 점수만 달라진다.
모두 거절해서 얻은 오수락 0은 성공이 아니다.
*/

import type { ReentryDecision } from './reentry-match';
import type { IdentityLifecycleState } from './identity-lifecycle';

export interface IdentityGroundTruth {
  subjectInFrame: boolean;
  subjectId: string | null;
  lookalikeIds: readonly string[];
  recoverableReappearance: boolean;
}

export interface IdentityEvalRow {
  decisionAction: ReentryDecision['action'];
  candidateId: string | null;
  falseReacquire: boolean;
  falseReacquireWhileAbsent: boolean;
  correctRecovery: boolean;
  held: boolean;
  rejectedAll: boolean;
  rejectOnlyNotSuccess: boolean;
  identityConfirmedClaim: false;
}

export function evaluateReentryDecision(
  decision: ReentryDecision,
  truth: IdentityGroundTruth,
): IdentityEvalRow {
  const accepted = decision.action === 'provisional' && decision.candidateId != null;
  const id = decision.candidateId;
  const isSubject = id != null && id === truth.subjectId;
  const isLookalike = id != null && truth.lookalikeIds.includes(id);
  const falseReacquire = accepted && !isSubject;
  const falseReacquireWhileAbsent = falseReacquire && !truth.subjectInFrame;
  const correctRecovery = accepted && isSubject && truth.subjectInFrame && truth.recoverableReappearance;
  const held = decision.action === 'needs_user' || decision.action === 'waiting';
  const rejectedAll = decision.action === 'reject' || (decision.action === 'waiting' && decision.reason === 'all-unsuitable');
  const rejectOnlyNotSuccess = rejectedAll && truth.recoverableReappearance;
  return {
    decisionAction: decision.action,
    candidateId: id,
    falseReacquire,
    falseReacquireWhileAbsent,
    correctRecovery,
    held,
    rejectedAll,
    rejectOnlyNotSuccess,
    identityConfirmedClaim: false,
  };
}

export interface IdentityEvalTotals {
  reacquireDecisions: number;
  falseReacquires: number;
  falseReacquireWhileAbsent: number;
  recoverableReappearances: number;
  correctRecoveries: number;
  recoveryRate: number | null;
  falseReacquireRate: number | null;
  holdOrUser: number;
  rejectOnlyNotSuccess: number;
  idSwitches: number;
}

export function emptyIdentityEvalTotals(): IdentityEvalTotals {
  return {
    reacquireDecisions: 0,
    falseReacquires: 0,
    falseReacquireWhileAbsent: 0,
    recoverableReappearances: 0,
    correctRecoveries: 0,
    recoveryRate: null,
    falseReacquireRate: null,
    holdOrUser: 0,
    rejectOnlyNotSuccess: 0,
    idSwitches: 0,
  };
}

export function accumulateIdentityEval(
  totals: IdentityEvalTotals,
  row: IdentityEvalRow,
  truth: IdentityGroundTruth,
): IdentityEvalTotals {
  const next = { ...totals };
  if (row.decisionAction === 'provisional') next.reacquireDecisions += 1;
  if (row.falseReacquire) next.falseReacquires += 1;
  if (row.falseReacquireWhileAbsent) next.falseReacquireWhileAbsent += 1;
  if (truth.recoverableReappearance) next.recoverableReappearances += 1;
  if (row.correctRecovery) next.correctRecoveries += 1;
  if (row.held) next.holdOrUser += 1;
  if (row.rejectOnlyNotSuccess) next.rejectOnlyNotSuccess += 1;
  next.recoveryRate = next.recoverableReappearances === 0
    ? null
    : next.correctRecoveries / next.recoverableReappearances;
  next.falseReacquireRate = next.reacquireDecisions === 0
    ? null
    : next.falseReacquires / next.reacquireDecisions;
  return next;
}

export function formatRate(num: number | null): string {
  return num == null ? 'N/A' : `${(num * 100).toFixed(1)}%`;
}

export function lifecycleIsEstimated(_state: IdentityLifecycleState): true {
  return true;
}
