/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c9ff7e4b @license @preserve */
/* 대상 부재와 신원 불확실을 정상 상태로 둔다.

항상 한 사람을 고르지 않는다. 예측 상자가 화면 밖으로 나갔다는
사실만으로 이탈을 확정하지 않는다. 장면 전환은 상태가 아니라 사건이다.
*/

export const IDENTITY_LIFECYCLE_VERSION = 1;

export type IdentityLifecycleState =
  | 'TRACKING'
  | 'OCCLUDED'
  | 'OUT_OF_VIEW'
  | 'LOST_UNCERTAIN'
  | 'REENTRY_CANDIDATE'
  | 'VERIFYING'
  | 'REACQUIRED_PROVISIONAL'
  | 'NEEDS_USER_CONFIRMATION';

export type IdentityLifecycleEvent = 'SCENE_CUT' | 'USER_CORRECTED' | 'MEMORY_CLEARED';

export interface EdgeRelation {
  /** 상자와 가장자리의 최근접 거리. 화면 짧은 변 대비. */
  edgeGap: number;
  /** 속도가 그 가장자리를 향하는가. */
  headingOut: boolean;
  side: 'left' | 'right' | 'top' | 'bottom' | 'none';
}

export interface LifecycleObservation {
  tSec: number;
  observed: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
  frame: { width: number; height: number };
  /** 실제 관측 궤적이 가장자리로 향했는가. 예측만으로는 안 된다. */
  observedHeadingOut?: boolean;
  edge?: EdgeRelation;
  overlapOthers?: number;
  insideFrame?: boolean;
  sceneCut?: boolean;
}

export interface LifecycleDecision {
  state: IdentityLifecycleState;
  event: IdentityLifecycleEvent | null;
  freezeMemory: boolean;
  mayAutoAssign: false;
  reason: string;
  /** 확실히 카메라 밖 vs 현재 확인 안 됨 */
  absence: 'out_of_view' | 'unconfirmed' | 'none';
}

export const EDGE_GAP_OUT = 0.04;
export const OVERLAP_OCCLUSION = 0.22;

export function edgeRelation(
  box: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
  velocity?: { vx: number; vy: number } | null,
): EdgeRelation {
  const left = box.x;
  const right = frame.width - (box.x + box.width);
  const top = box.y;
  const bottom = frame.height - (box.y + box.height);
  const short = Math.max(1, Math.min(frame.width, frame.height));
  const gaps = [
    { side: 'left' as const, gap: left / short },
    { side: 'right' as const, gap: right / short },
    { side: 'top' as const, gap: top / short },
    { side: 'bottom' as const, gap: bottom / short },
  ].sort((a, b) => a.gap - b.gap);
  const nearest = gaps[0];
  let headingOut = false;
  if (velocity && nearest.gap <= EDGE_GAP_OUT * 4) {
    if (nearest.side === 'left') headingOut = velocity.vx < 0;
    if (nearest.side === 'right') headingOut = velocity.vx > 0;
    if (nearest.side === 'top') headingOut = velocity.vy < 0;
    if (nearest.side === 'bottom') headingOut = velocity.vy > 0;
  }
  return {
    edgeGap: nearest.gap,
    headingOut,
    side: nearest.gap <= EDGE_GAP_OUT * 3 ? nearest.side : 'none',
  };
}

/**
 * 예측 상자가 경계를 넘었다는 사실만으로 OUT_OF_VIEW 를 확정하지 않는다.
 * 실제 관측 궤적 + 가장자리 관계 + 이후 관측 소실이 함께 있어야 한다.
 */
export function classifyIdentityLifecycle(
  prev: IdentityLifecycleState,
  obs: LifecycleObservation,
): LifecycleDecision {
  if (obs.sceneCut) {
    return {
      state: prev === 'TRACKING' ? 'LOST_UNCERTAIN' : prev === 'REACQUIRED_PROVISIONAL' ? 'VERIFYING' : 'LOST_UNCERTAIN',
      event: 'SCENE_CUT',
      freezeMemory: true,
      mayAutoAssign: false,
      reason: 'scene-cut-reverify',
      absence: 'unconfirmed',
    };
  }

  if (obs.observed && obs.box && (obs.insideFrame ?? true)) {
    if (prev === 'REACQUIRED_PROVISIONAL' || prev === 'VERIFYING' || prev === 'REENTRY_CANDIDATE') {
      return {
        state: prev === 'REACQUIRED_PROVISIONAL' ? 'REACQUIRED_PROVISIONAL' : 'VERIFYING',
        event: null,
        freezeMemory: true,
        mayAutoAssign: false,
        reason: prev === 'REACQUIRED_PROVISIONAL' ? 'provisional-still-open' : 'verifying-observation',
        absence: 'none',
      };
    }
    if (prev === 'NEEDS_USER_CONFIRMATION') {
      return {
        state: 'NEEDS_USER_CONFIRMATION',
        event: null,
        freezeMemory: true,
        mayAutoAssign: false,
        reason: 'awaiting-user',
        absence: 'unconfirmed',
      };
    }
    return {
      state: 'TRACKING',
      event: null,
      freezeMemory: false,
      mayAutoAssign: false,
      reason: 'observed-inside',
      absence: 'none',
    };
  }

  const overlap = obs.overlapOthers ?? 0;
  const edge = obs.edge;
  const heading = obs.observedHeadingOut === true && edge?.headingOut === true;
  const atEdge = edge != null && edge.edgeGap <= EDGE_GAP_OUT && edge.side !== 'none';

  if (!obs.observed && heading && atEdge) {
    return {
      state: 'OUT_OF_VIEW',
      event: null,
      freezeMemory: true,
      mayAutoAssign: false,
      reason: 'observed-exit-at-edge',
      absence: 'out_of_view',
    };
  }

  if (!obs.observed && (obs.insideFrame ?? true) && overlap >= OVERLAP_OCCLUSION) {
    return {
      state: 'OCCLUDED',
      event: null,
      freezeMemory: true,
      mayAutoAssign: false,
      reason: 'lost-inside-with-overlap',
      absence: 'unconfirmed',
    };
  }

  if (!obs.observed && (obs.insideFrame ?? true) && overlap < OVERLAP_OCCLUSION) {
    return {
      state: 'LOST_UNCERTAIN',
      event: null,
      freezeMemory: true,
      mayAutoAssign: false,
      reason: 'lost-inside-no-occlusion-evidence',
      absence: 'unconfirmed',
    };
  }

  return {
    state: 'LOST_UNCERTAIN',
    event: null,
    freezeMemory: true,
    mayAutoAssign: false,
    reason: 'unconfirmed-absence',
    absence: 'unconfirmed',
  };
}

export function advanceReentryState(
  current: IdentityLifecycleState,
  step: 'candidate' | 'verifying' | 'provisional' | 'needs_user' | 'reject',
): IdentityLifecycleState {
  if (step === 'reject') return current === 'OUT_OF_VIEW' || current === 'OCCLUDED' ? current : 'LOST_UNCERTAIN';
  if (step === 'needs_user') return 'NEEDS_USER_CONFIRMATION';
  if (step === 'provisional') return 'REACQUIRED_PROVISIONAL';
  if (step === 'verifying') return 'VERIFYING';
  return 'REENTRY_CANDIDATE';
}

export function mayUpdateUserAppearance(state: IdentityLifecycleState): boolean {
  return state === 'TRACKING';
}

export function mapPipelineStateToLifecycle(state: string, searching = false): IdentityLifecycleState {
  const s = String(state || '').toUpperCase();
  if (s.includes('PROVISIONAL')) return 'REACQUIRED_PROVISIONAL';
  if (s.includes('VERIFY')) return 'VERIFYING';
  if (s.includes('REENTRY') || s.includes('REACQUIR')) return searching ? 'REENTRY_CANDIDATE' : 'VERIFYING';
  if (s.includes('ASK') || s.includes('USER_CONFIRM') || s.includes('NEEDS')) return 'NEEDS_USER_CONFIRMATION';
  if (s.includes('OUT') || s.includes('EXIT')) return 'OUT_OF_VIEW';
  if (s.includes('OCCLU')) return 'OCCLUDED';
  if (s.includes('LOST') || s.includes('WARN')) return s.includes('LOST') ? 'LOST_UNCERTAIN' : 'LOST_UNCERTAIN';
  if (s.includes('OK') || s.includes('TRACKING')) return 'TRACKING';
  return 'LOST_UNCERTAIN';
}
