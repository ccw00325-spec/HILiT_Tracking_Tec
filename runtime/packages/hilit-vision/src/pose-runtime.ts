/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b2766473 @license @preserve */
/* 자세 추론 런타임.

2026-09-21 부터 **자체 추정기(HilitPoseNet)** 가 돈다. 그 전까지 이
파일은 "추정기가 없다" 만 말하는 껍데기였다.

지키는 것은 그대로다.
  - 탭마다 모델을 복제해 로드하지 않는다. 하나를 나눠 쓴다.
  - Cloud 로 몰래 보내지 않는다. 추론은 이 기기 안에서 끝난다.
  - 가중치가 없으면 `loaded: false` 이고, 그때는 관절을 만들지 않는다.
    상자에서 가상 관절을 만들어 채우지 않는다.

외부 가중치(MediaPipe·MoveNet·OpenPose)를 받지 않는다. 받을 자리도
두지 않았다 — 실을 수 있는 것은 우리가 학습한 `PoseWeights` 뿐이다.
*/

import {
  decodePose,
  poseForward,
  poseInputFromRgba,
  POSE_NET_JOINTS,
  POSE_SCORE_MIN,
  POSE_VISIBILITY_MIN,
  type DecodedJoint,
  type PoseWeights,
} from './hilit-pose-net';

export interface PoseRuntimeHandle {
  loaded: boolean;
  instances: number;
  cloudFallback: false;
  deviceAccel: 'unknown' | 'cpu-js';
  modelId: string | null;
  joints: readonly string[];
  note: string;
  /**
   * crop 하나에서 관절을 뽑는다. 가중치가 없으면 null 이다.
   *
   * 돌려주는 좌표는 crop 안 상대값(0~1)이다. 화면 좌표로 바꾸는 것은
   * 부르는 쪽 몫이다 — 여기서 상자를 모르기 때문이다.
   */
  estimate(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
  ): DecodedJoint[] | null;
}

const EMPTY: PoseRuntimeHandle = {
  loaded: false,
  instances: 0,
  cloudFallback: false,
  deviceAccel: 'unknown',
  modelId: null,
  joints: POSE_NET_JOINTS,
  note: '자세 추정 가중치를 아직 싣지 않았습니다. 관절을 만들지 않습니다.',
  estimate: () => null,
};

let handle: PoseRuntimeHandle | null = null;
let loadedWeights: PoseWeights | null = null;

export function sharedPoseRuntime(): PoseRuntimeHandle {
  if (!handle) handle = EMPTY;
  return handle;
}

/**
 * 우리 가중치를 싣는다. 두 번 불러도 인스턴스는 하나다.
 *
 * `scoreMin`·`visibilityMin` 의 기본값은 합성 평가에서 **잰** 값이다
 * (`scripts/eval-hilit-posenet.mjs`). 임의로 낮추면 가려진 관절이
 * 좌표를 갖게 되고, 그 좌표가 몸통 속도에 섞인다.
 */
export function loadPoseRuntime(
  weights: PoseWeights,
  opts?: { scoreMin?: number; visibilityMin?: number },
): PoseRuntimeHandle {
  if (handle?.loaded && loadedWeights === weights) return handle;
  const scoreMin = opts?.scoreMin ?? POSE_SCORE_MIN;
  const visibilityMin = opts?.visibilityMin ?? POSE_VISIBILITY_MIN;
  loadedWeights = weights;
  handle = {
    loaded: true,
    instances: 1,
    cloudFallback: false,
    deviceAccel: 'cpu-js',
    modelId: weights.modelId,
    joints: POSE_NET_JOINTS,
    note: `${weights.modelId} · 기기 안에서만 추론합니다. 관절 ${POSE_NET_JOINTS.length}개.`,
    estimate(rgba, width, height) {
      if (!loadedWeights) return null;
      if (!(width > 0) || !(height > 0)) return null;
      const input = poseInputFromRgba(rgba, width, height);
      return decodePose(poseForward(input, loadedWeights), scoreMin, visibilityMin);
    },
  };
  return handle;
}

export function disposePoseRuntime(): void {
  handle = null;
  loadedWeights = null;
}

export function samplingQualityNote(everyN: number): string {
  if (everyN <= 1) return '매 분석 프레임. 빠른 동작을 덜 놓치지만 시간과 메모리가 늘어납니다.';
  return `${everyN}프레임마다 보면 시간과 메모리는 줄지만 ${everyN}프레임보다 짧은 동작은 빠질 수 있습니다.`;
}
