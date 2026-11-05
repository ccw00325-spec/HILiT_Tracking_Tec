/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·850512d7 @license @preserve */
/* 하이라이트·Agent 에 넘길 신원 상태.

부재를 사용자 동작으로 설명하지 않는다.
잠정 후보를 "사용자를 찾았습니다"로 말하지 않는다.
불확실 구간은 자동 하이라이트에서 보류한다.
원본 600초·결과 90초 계약은 여기서 바꾸지 않는다.
*/

import type { IdentityLifecycleState } from './identity-lifecycle';

export type HighlightIdentityPresence =
  | 'observed_confirmed'
  | 'provisional'
  | 'uncertain'
  | 'absent'
  | 'needs_user';

export interface HighlightIdentityFact {
  presence: HighlightIdentityPresence;
  identityHold: boolean;
  allowAutoHighlight: boolean;
  agentCopy: string;
  treatBoxMotionAsSubjectAction: boolean;
}

export const SOURCE_MAX_SECONDS = 600;
export const RESULT_MAX_SECONDS = 90;

export function highlightIdentityFromLifecycle(state: IdentityLifecycleState): HighlightIdentityFact {
  if (state === 'TRACKING') {
    return {
      presence: 'observed_confirmed',
      identityHold: false,
      allowAutoHighlight: true,
      agentCopy: '지정한 대상을 이 구간에서 추적 중입니다. 동작을 지어내지 않습니다.',
      treatBoxMotionAsSubjectAction: true,
    };
  }
  if (state === 'REACQUIRED_PROVISIONAL') {
    return {
      presence: 'provisional',
      identityHold: true,
      allowAutoHighlight: false,
      agentCopy: '잠정 후보입니다. 사용자를 찾았다고 확정하지 않았습니다.',
      treatBoxMotionAsSubjectAction: false,
    };
  }
  if (state === 'NEEDS_USER_CONFIRMATION' || state === 'VERIFYING' || state === 'REENTRY_CANDIDATE') {
    return {
      presence: 'needs_user',
      identityHold: true,
      allowAutoHighlight: false,
      agentCopy: '신원을 확인해야 합니다. 자동 하이라이트에 넣지 않았습니다.',
      treatBoxMotionAsSubjectAction: false,
    };
  }
  if (state === 'OUT_OF_VIEW') {
    return {
      presence: 'absent',
      identityHold: true,
      allowAutoHighlight: false,
      agentCopy: '대상이 화면 밖으로 보인 구간입니다. 사용자 동작으로 설명하지 않습니다.',
      treatBoxMotionAsSubjectAction: false,
    };
  }
  if (state === 'OCCLUDED') {
    return {
      presence: 'uncertain',
      identityHold: true,
      allowAutoHighlight: false,
      agentCopy: '가림으로 대상이 확인되지 않습니다. 없는 동작을 만들지 않습니다.',
      treatBoxMotionAsSubjectAction: false,
    };
  }
  return {
    presence: 'uncertain',
    identityHold: true,
    allowAutoHighlight: false,
    agentCopy: '지금 지정한 사람을 확인하지 못했습니다. 비슷한 사람을 넣지 않았습니다.',
    treatBoxMotionAsSubjectAction: false,
  };
}

export function highlightIdentityFromTrackState(state: string | undefined): HighlightIdentityFact {
  const s = String(state || '').toUpperCase();
  if (s.includes('PROVISIONAL')) return highlightIdentityFromLifecycle('REACQUIRED_PROVISIONAL');
  if (s.includes('ASK') || s.includes('USER_CONFIRM') || s.includes('NEEDS')) {
    return highlightIdentityFromLifecycle('NEEDS_USER_CONFIRMATION');
  }
  if (s.includes('OUT') || s.includes('EXIT')) return highlightIdentityFromLifecycle('OUT_OF_VIEW');
  if (s.includes('OCCLU')) return highlightIdentityFromLifecycle('OCCLUDED');
  if (s.includes('LOST') || s.includes('REACQUIR') || s.includes('WARN')) {
    return highlightIdentityFromLifecycle('LOST_UNCERTAIN');
  }
  if (s.includes('OK') || s === 'TRACKING') return highlightIdentityFromLifecycle('TRACKING');
  return highlightIdentityFromLifecycle('LOST_UNCERTAIN');
}

export function keepDurationContract(sourceSec: number, resultSec: number): {
  ok: boolean;
  reason: string;
} {
  if (sourceSec > SOURCE_MAX_SECONDS) return { ok: false, reason: 'source-over-600' };
  if (resultSec > RESULT_MAX_SECONDS) return { ok: false, reason: 'result-over-90' };
  return { ok: true, reason: 'ok' };
}
