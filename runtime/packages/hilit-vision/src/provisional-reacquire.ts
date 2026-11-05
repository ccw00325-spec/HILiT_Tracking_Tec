/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·cd28394b @license @preserve */
/* 잠정 재획득. 앞뒤를 맞춰도 같은 타인을 양쪽으로 따른 것일 수 있다.

궤적 일치는 외형 신원을 대체하지 않는다. 장면 전환을 가로질러
역추적하지 않는다. 잠정 결과는 앵커를 갱신하지 않는다.
전체 10분 원본을 메모리에 올리지 않는다.
*/

import { extrapolateBackwardGeometry, refineOfflineTrajectory, type OfflineBox } from './offline-bidirectional';
import type { ReentryDecision } from './reentry-match';
import type { ReverseTrackResult } from './reverse-track';

export const LOOKAHEAD_BUDGET_SEC = 2;
export const LOOKAHEAD_BUDGET_LOW_SEC = 1;

export interface LookaheadSample {
  tSec: number;
  box: { x: number; y: number; width: number; height: number };
  sceneCut?: boolean;
}

export interface ProvisionalResult {
  status: 'provisional' | 'hold' | 'rejected';
  span: { start: number; end: number } | null;
  candidateId: string | null;
  updatesAnchor: false;
  identityConfirmed: false;
  reason: string;
  lookaheadSec: number;
}

export function planLookahead(input: {
  nowSec: number;
  videoEndSec: number;
  lowPower?: boolean;
}): { start: number; end: number; budget: number } {
  const budget = input.lowPower ? LOOKAHEAD_BUDGET_LOW_SEC : LOOKAHEAD_BUDGET_SEC;
  const start = input.nowSec;
  const end = Math.min(input.videoEndSec, input.nowSec + budget);
  return { start, end, budget };
}

export function refineProvisional(input: {
  decision: ReentryDecision;
  forward: readonly LookaheadSample[];
  candidateId: string | null;
  appearanceStillHolds: boolean;
  /** 실제 이전 프레임 역추적. 없으면 기하 외삽만 하고 역추적으로 보고하지 않는다. */
  reverseTrack?: ReverseTrackResult | null;
}): ProvisionalResult {
  if (input.decision.action !== 'provisional' || !input.candidateId) {
    return {
      status: input.decision.action === 'needs_user' ? 'hold' : 'rejected',
      span: null,
      candidateId: null,
      updatesAnchor: false,
      identityConfirmed: false,
      reason: input.decision.reason,
      lookaheadSec: 0,
    };
  }
  if (!input.appearanceStillHolds) {
    return {
      status: 'rejected',
      span: null,
      candidateId: input.candidateId,
      updatesAnchor: false,
      identityConfirmed: false,
      reason: 'appearance-failed-in-lookahead',
      lookaheadSec: spanSec(input.forward),
    };
  }
  if (input.forward.some((s) => s.sceneCut)) {
    const cut = input.forward.find((s) => s.sceneCut);
    return {
      status: 'hold',
      span: null,
      candidateId: input.candidateId,
      updatesAnchor: false,
      identityConfirmed: false,
      reason: 'scene-cut-blocks-backtrack',
      lookaheadSec: cut ? cut.tSec - input.forward[0].tSec : 0,
    };
  }
  if (input.forward.length < 2) {
    return {
      status: 'hold',
      span: null,
      candidateId: input.candidateId,
      updatesAnchor: false,
      identityConfirmed: false,
      reason: 'lookahead-too-short',
      lookaheadSec: spanSec(input.forward),
    };
  }
  if (input.reverseTrack) {
    if (input.reverseTrack.status === 'cancelled' || input.reverseTrack.status === 'timeout') {
      return {
        status: 'hold',
        span: null,
        candidateId: input.candidateId,
        updatesAnchor: false,
        identityConfirmed: false,
        reason: `reverse-track-${input.reverseTrack.status}`,
        lookaheadSec: input.reverseTrack.lookaheadSec,
      };
    }
    if (input.reverseTrack.status !== 'verified' && input.reverseTrack.status !== 'insufficient-frames') {
      return {
        status: 'hold',
        span: null,
        candidateId: input.candidateId,
        updatesAnchor: false,
        identityConfirmed: false,
        reason: input.reverseTrack.reason,
        lookaheadSec: input.reverseTrack.lookaheadSec,
      };
    }
  }
  const forwardBoxes: OfflineBox[] = input.forward.map((s) => ({
    t: s.tSec,
    x: s.box.x,
    y: s.box.y,
    width: s.box.width,
    height: s.box.height,
    observed: true,
  }));
  const geometric = extrapolateBackwardGeometry(forwardBoxes);
  const refined = refineOfflineTrajectory({ forward: forwardBoxes, backward: geometric });
  const disagree = refined.some((p) => p.state === 'lost' || p.reason === 'forward-backward-disagree' || p.reason.includes('disagree'));
  if (disagree || refined.length < 2) {
    return {
      status: 'hold',
      span: null,
      candidateId: input.candidateId,
      updatesAnchor: false,
      identityConfirmed: false,
      reason: 'trajectory-geometry-disagree',
      lookaheadSec: spanSec(input.forward),
    };
  }
  const reverseOk = !input.reverseTrack || input.reverseTrack.status === 'verified' || input.reverseTrack.status === 'insufficient-frames';
  if (!reverseOk) {
    return {
      status: 'hold',
      span: null,
      candidateId: input.candidateId,
      updatesAnchor: false,
      identityConfirmed: false,
      reason: 'reverse-track-not-verified',
      lookaheadSec: spanSec(input.forward),
    };
  }
  return {
    status: 'provisional',
    span: { start: input.forward[0].tSec, end: input.forward[input.forward.length - 1].tSec },
    candidateId: input.candidateId,
    updatesAnchor: false,
    identityConfirmed: false,
    reason: input.reverseTrack?.status === 'verified'
      ? 'provisional-pixel-reverse'
      : 'provisional-lookahead-geometry-only',
    lookaheadSec: spanSec(input.forward),
  };
}

function spanSec(samples: readonly LookaheadSample[]): number {
  if (samples.length < 2) return 0;
  return Math.max(0, samples[samples.length - 1].tSec - samples[0].tSec);
}

export function applyUserCorrection(input: {
  storeCleared: boolean;
  relatedSpanDropped: boolean;
}): { ok: boolean; updatesAnchor: false } {
  return { ok: input.storeCleared && input.relatedSpanDropped, updatesAnchor: false };
}
