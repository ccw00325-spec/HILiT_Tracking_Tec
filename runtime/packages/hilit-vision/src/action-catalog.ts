/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b35956b3 @license @preserve */
/* 6단계 기본 동작 목록.

지금 있는 신호만 넣는다. 관절이 필요한 동작은 미지원이다.
학습 모델이 아니다. 움직임이 적음을 휴식으로, 위로 감을 점프로 두지 않는다.
*/

export const ACTION_ANALYSIS_VERSION = 'action-index-0.91';

export const ACTION_THRESHOLDS = Object.freeze({
  moveSpeedPxPerSec: 40,
  stillSpeedPxPerSec: 16,
  enterRun: 2,
  exitRun: 2,
  minSpanSec: 0.2,
  mergeGapSec: 0.12,
  source: 'action-catalog.ts — 평가에서 다시 맞추지 않음',
});

export type SupportedActionKind =
  | 'subject_moving'
  | 'subject_still_screen'
  | 'hard_to_separate'
  | 'identity_uncertain';

export type UnsupportedActionKind =
  | 'body_lower'
  | 'arm_raise'
  | 'jump'
  | 'landing'
  | 'goal'
  | 'rest'
  | 'praise'
  | 'skill_success';

export interface ActionKindDef {
  kind: SupportedActionKind | UnsupportedActionKind;
  userName: string;
  supported: boolean;
  neededSignals: string[];
  startEnd: string;
  minCondition: string;
  confusedWith: string[];
  unsupportedCapture: string[];
  holdWhen: string[];
  evidenceTalk: string;
}

export const ACTION_DEFS: readonly ActionKindDef[] = [
  {
    kind: 'subject_moving',
    userName: '이동 중',
    supported: true,
    neededSignals: ['subjectId', 'box center', 'camera-compensated delta when usable', 'source dt'],
    startEnd: '보정 후 화면 속도가 문턱 이상인 연속 구간. 신원 보류·긴 간격에서 끊는다.',
    minCondition: `${ACTION_THRESHOLDS.enterRun}스텝 이상, ${ACTION_THRESHOLDS.minSpanSec}초 이상, 신원 확인`,
    confusedWith: ['카메라만 이동', '박스 흔들림'],
    unsupportedCapture: ['강한 줌·시차', '사람이 화면 대부분'],
    holdWhen: ['카메라 보정 실패', '신원 불확실'],
    evidenceTalk: '카메라 보정이 된 뒤에도 박스가 움직인 구간입니다. 뛰거나 점프한 것은 아닙니다.',
  },
  {
    kind: 'subject_still_screen',
    userName: '화면에서 거의 정지',
    supported: true,
    neededSignals: ['camera-compensated box speed', 'identityOk'],
    startEnd: '보정 후 속도가 낮은 연속 구간.',
    minCondition: `${ACTION_THRESHOLDS.enterRun}스텝, 신원 확인`,
    confusedWith: ['휴식', '포즈 유지', '홀드'],
    unsupportedCapture: ['카메라 보정 실패 시 정지 확정'],
    holdWhen: ['카메라 사용 불가'],
    evidenceTalk: '화면에서 박스가 거의 안 움직입니다. 휴식이나 자세 유지라고 하지 않습니다.',
  },
  {
    kind: 'hard_to_separate',
    userName: '카메라와 구분이 어려움',
    supported: true,
    neededSignals: ['raw box delta', 'camera.usable === false'],
    startEnd: '보정 실패인데 박스가 움직인 구간.',
    minCondition: '카메라 사용 불가 + 원시 이동 > 흔들림',
    confusedWith: ['대상 이동', '카메라 이동'],
    unsupportedCapture: [],
    holdWhen: ['항상 근사. 확정 이동이 아님'],
    evidenceTalk: '카메라 보정을 못 해 누가 움직였는지 가르지 못합니다.',
  },
  {
    kind: 'identity_uncertain',
    userName: '신원 불확실',
    supported: true,
    neededSignals: ['identityOk === false'],
    startEnd: '신원을 잇지 않는 구간. 동작으로 확정하지 않음.',
    minCondition: 'identity hold 연속',
    confusedWith: ['가림', '다른 사람'],
    unsupportedCapture: [],
    holdWhen: ['항상 확인 필요'],
    evidenceTalk: '사람이 바뀌었을 수 있어 동작으로 쓰지 않습니다.',
  },
  {
    kind: 'body_lower',
    userName: '몸 낮추기',
    supported: false,
    neededSignals: ['관절'],
    startEnd: '',
    minCondition: '관절 관측',
    confusedWith: ['앉기', '가림'],
    unsupportedCapture: ['관절 없음'],
    holdWhen: ['추정기 없음'],
    evidenceTalk: '관절이 없어 지원하지 않습니다.',
  },
  {
    kind: 'arm_raise',
    userName: '팔 올리기',
    supported: false,
    neededSignals: ['손목·어깨 관절'],
    startEnd: '',
    minCondition: '관절 관측',
    confusedWith: ['손 흔들기'],
    unsupportedCapture: ['관절 없음'],
    holdWhen: ['추정기 없음'],
    evidenceTalk: '관절이 없어 지원하지 않습니다.',
  },
  {
    kind: 'jump',
    userName: '점프',
    supported: false,
    neededSignals: ['관절', '발 접촉'],
    startEnd: '',
    minCondition: '상승+착지 근거',
    confusedWith: ['화면상 상승', '카메라 틸트'],
    unsupportedCapture: ['박스만 있는 영상'],
    holdWhen: ['관절·발 접촉 없음'],
    evidenceTalk: '화면에서 위로 간 것만으로 점프라고 하지 않습니다.',
  },
];

export function actionDef(kind: string): ActionKindDef | null {
  return ACTION_DEFS.find((row) => row.kind === kind) ?? null;
}

export function learnedActionAvailability(): {
  available: false;
  reason: 'rule-spans-only';
  needed: string[];
} {
  return {
    available: false,
    reason: 'rule-spans-only',
    needed: [
      '사람 검수 동작 구간 라벨(대상·종류·시작·종료·가림)',
      '촬영 세션을 학습/검증/평가로 나누지 않을 분량',
      '관절이 필요한 동작을 넣을 경우 승인된 추정기',
    ],
  };
}
