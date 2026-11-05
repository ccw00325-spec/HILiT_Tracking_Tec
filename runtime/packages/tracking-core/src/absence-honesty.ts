/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·83d10360 @license @preserve */
/**
 * 1단계 격리 실험. 제품 기본값은 꺼져 있다.
 *
 * 가설: 추적기가 ‘정상’인데, 사람 검출이 상자 안에서 사람을 못 보고
 * 약한 신호가 세 번 이어지면 그 상자를 정상으로 두지 않고 사용자에게 묻는다.
 * 검출을 안 돌린 프레임(personInBox === null)은 바꾸지 않는다.
 * 자동 재획득은 하지 않는다. 위치 예측만으로 대상을 확정하지 않는다.
 */

export const ABSENCE_HONESTY_EXPERIMENT_DEFAULT = false;

export function decideAbsenceHonesty(input: {
  experiment: boolean;
  claimOk: boolean;
  personInBox: boolean | null;
  weakStreak: number;
}): 'unchanged' | 'ask-user' {
  if (input.experiment !== true) return 'unchanged';
  if (!input.claimOk) return 'unchanged';
  if (input.personInBox !== false) return 'unchanged';
  if (input.weakStreak < 3) return 'unchanged';
  return 'ask-user';
}
