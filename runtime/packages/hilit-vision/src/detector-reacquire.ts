/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·dafac0e8 @license @preserve */
/* 검출 후보로 추적을 다시 붙일지 정하는 문.

검출 점수는 동일인 확률이 아니다. 후보가 하나라는 이유만으로
같은 사람이라고 확정하지 않는다. 외형이 약하면 사용자에게 묻는다.
잠정 후보로 사용자 앵커 기억은 갱신하지 않는다(appearance-memory).
*/

import type { ReidDecision } from './appearance-memory';

export type DetectorMode = 'off' | 'diagnose' | 'assist' | 'correct' | 'reacquire';

export type ReacquireAction = 'diagnose_only' | 'ask_user' | 'confirm';

export interface ReacquireProposal {
  detectorScore: number;
  appearanceSelf: number | null;
  appearanceOther: number | null;
  motionErrorBodies: number;
}

export interface ReacquireInput {
  mode: DetectorMode;
  proposals: readonly ReacquireProposal[];
  appearanceDecision: ReidDecision;
  gapSeconds: number;
  uniqueMargin: number;
}

export interface ReacquireDecision {
  action: ReacquireAction;
  reason: string;
  chosenIndex: number | null;
}

const UNIQUE_MARGIN = 0.08;
const MAX_MOTION_BODIES = 3;
const MAX_GAP_SECONDS = 8;

/** 실사 승격 전에는 자동 재획득을 켜지 않는다. */
export const AUTO_REACQUIRE_DEFAULT: DetectorMode = 'off';
export const AUTO_REACQUIRE_PROMOTION_REQUIRED = true;

export function productDetectorMode(realEvalPassed: boolean): DetectorMode {
  if (!realEvalPassed || AUTO_REACQUIRE_PROMOTION_REQUIRED) return AUTO_REACQUIRE_DEFAULT;
  return AUTO_REACQUIRE_DEFAULT;
}

export function uniqueAppearanceMargin(
  proposals: readonly ReacquireProposal[],
): number {
  const scores = proposals
    .map((p) => p.appearanceSelf)
    .filter((v): v is number => v != null)
    .sort((a, b) => b - a);
  if (scores.length === 0) return 0;
  if (scores.length === 1) return 0;
  return scores[0] - scores[1];
}

export function decideDetectorReacquire(input: ReacquireInput): ReacquireDecision {
  if (input.mode === 'off' || input.mode === 'diagnose' || input.mode === 'assist' || input.mode === 'correct') {
    return {
      action: 'diagnose_only',
      reason: `mode-${input.mode}`,
      chosenIndex: null,
    };
  }
  if (!input.proposals.length) {
    return { action: 'ask_user', reason: 'no-proposal', chosenIndex: null };
  }
  if (input.gapSeconds > MAX_GAP_SECONDS) {
    return { action: 'ask_user', reason: 'gap-too-long', chosenIndex: null };
  }
  if (input.appearanceDecision !== 'accept') {
    return { action: 'ask_user', reason: `appearance-${input.appearanceDecision}`, chosenIndex: null };
  }
  if (input.proposals.length === 1) {
    return { action: 'ask_user', reason: 'single-candidate-not-enough', chosenIndex: null };
  }
  const margin = input.uniqueMargin;
  if (!(margin >= UNIQUE_MARGIN)) {
    return { action: 'ask_user', reason: 'not-unique', chosenIndex: null };
  }
  let best = 0;
  let bestSelf = -1;
  input.proposals.forEach((p, i) => {
    const self = p.appearanceSelf ?? -1;
    if (self > bestSelf) { bestSelf = self; best = i; }
  });
  const chosen = input.proposals[best];
  if (chosen.motionErrorBodies > MAX_MOTION_BODIES) {
    return { action: 'ask_user', reason: 'motion-too-far', chosenIndex: null };
  }
  return { action: 'confirm', reason: 'appearance-unique-motion', chosenIndex: best };
}
