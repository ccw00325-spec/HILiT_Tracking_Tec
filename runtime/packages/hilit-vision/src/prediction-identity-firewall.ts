/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·34ab2653 @license @preserve */
/* 예측과 신원 사이의 방화벽.

## 왜 이 파일이 있나

위치 예측을 넣으면 곧바로 생기는 뒷문이 있다. **예측 자리 근처의 사람을
대상으로 고르는 것**이다. 그럴듯해 보이지만, 그 순간 H0/H1/H2 가 막아
놓은 것을 통째로 우회한다.

  예측이 "대상은 여기쯤" 이라고 말한다
    → 그 자리에 옆 사람이 서 있다
    → 예측이 맞다고 여겨 그 사람을 대상으로 올린다
    → 외형은 보지도 않았는데 신원이 바뀐다

이건 강제 매칭이고, 우리가 H0(미복귀·판단불가) 가설을 따로 둔 이유가
정확히 이걸 막기 위해서였다.

## 규칙: 예측은 **거절만** 한다

예측은 후보를 떨어뜨릴 수는 있어도 올릴 수는 없다. 비대칭이 핵심이다.

  "예측에서 너무 멀다"  → 거절해도 안전하다. 틀려도 사용자에게 묻게 될 뿐이다.
  "예측에 가깝다"       → **아무 의미도 없다.** 그 자리에 누가 서 있든 가깝다.

그래서 이 파일의 판정 타입에는 `accept` 가 **아예 없다**. 실수로 쓰려고
해도 타입이 막는다.

## 규칙: 예측값은 증거 칸에 들어가지 않는다

`ReentryEvidence` 에 예측 관련 점수를 넣지 않는다. 한 칸이라도 들어가면
`composeReentryScore` 와 H0 지지도가 그 값을 먹고, 그때부터 예측이
신원 점수를 움직인다. `assertEvidenceFreeOfPrediction` 이 그걸 검사한다.

실험 경로의 소프트 순위는 증거 칸이 아니라 `rankScore` 다.
같은 위치 차이에 이 하드 거절과 소프트 감점을 함께 걸지 않는다.
*/

import type { ReentryEvidence } from './reentry-match';
import type { TrackRegionPrediction, PredictionBox } from './track-region-prediction';

/**
 * 예측 판정.
 *
 * 세 값을 **모두 적어 둔다.** 그래야 `accept` 가 빠진 것이 실수가 아니라
 * 의도라는 게 코드에 남는다. 예전에는 타입에 두 값만 있어서, 읽는 사람이
 * "빠뜨린 건가?" 하고 넣고 싶어졌다.
 *
 * 🔴 `accept` 는 **예약된 값이고 절대 반환되지 않는다.**
 *
 * 예측 자리에 가까운 후보를 승격시키면 H0/H1/H2 가설이 막아 놓은 것을
 * 통째로 우회한다 — 그 자리에는 누구든 서 있을 수 있기 때문이다. 그래서
 * 가까움은 아무것도 증명하지 않는다.
 *
 * `assertNeverAccepts()` 와 시험이 이 약속을 지킨다. 누가 나중에
 * accept 를 내도록 고치면 거기서 멈춘다.
 */
export type PredictionVerdict = 'reject' | 'neutral' | 'accept';

/** 예약값. 이 파일 밖에서 이 값을 만들어 신원 판정에 넣지 않는다. */
export const PREDICTION_VERDICT_ACCEPT: PredictionVerdict = 'accept';
/** 예측이 실제로 낼 수 있는 판정. accept 는 여기 없다. */
export const PRODUCIBLE_VERDICTS: readonly PredictionVerdict[] = Object.freeze(['reject', 'neutral']);

export interface PredictionGateResult {
  /** 실제로는 'reject' 아니면 'neutral' 이다. 'accept' 는 나오지 않는다. */
  verdict: PredictionVerdict;
  /** 예측 중심에서 몇 몸 떨어져 있나. 못 재면 null. */
  distanceBodies: number | null;
  reason: string;
  /** 이 판정으로 후보를 올릴 수 없다. 늘 false 다. */
  canPromote: false;
}

export const PREDICTION_GATE_POLICY = Object.freeze({
  /**
   * 예측 중심에서 이만큼 넘게 떨어지면 거절한다.
   *
   * 3.5 였다. 그런데 사람이 200px 인 720p 화면에서 3.5몸은 700px —
   * 화면 절반보다 넓다. 즉 **아무것도 거절하지 못했다.**
   *
   * 합성 대본 6종에서 반경을 훑어 봤다
   * (`scripts/eval-tracking-clips.mjs`, 2026-09-21).
   *
   *     반경(몸)  정답 오거절  먼 타인 거절
   *     0.75       0.0%        58.3%
   *     1.00       0.0%        42.3%
   *     1.50       0.0%        10.2%
   *     2.00~3.50  0.0%         0.0%
   *
   * 0.75 까지 좁혀도 합성에서는 정답을 하나도 안 놓친다. 그런데 그
   * 평가는 관측이 정답 그대로라 예측 오차가 0.9px 밖에 안 된다.
   * 실사에서는 훨씬 더 틀리고, 그때 좁은 반경은 **진짜 대상을 거절해
   * 사용자에게 묻는 횟수를 늘린다.**
   *
   * 그래서 가장 좁은 값이 아니라 **1.5** 로 둔다. 거절이 실제로 일어나기
   * 시작하는 지점이면서, 합성 최적값(0.75)보다 두 배 여유가 있다.
   * 아래 불확실성 여유가 여기에 더 붙으므로 실제 반경은 더 넓어진다.
   */
  maxDistanceBodies: 1.5,
  /** 불확실할수록 관대해진다. 불확실성 1몸당 이만큼 넓혀 준다. */
  uncertaintySlackBodies: 2.0,
  /** 이 배수를 넘게 넓히지는 않는다. */
  maxSlackBodies: 4.0,
});

function centerOf(box: PredictionBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * 예측으로 후보를 **거절만** 한다.
 *
 * 예측이 못 미더우면(`usable === false`) 아무 말도 하지 않는다. 못 믿는
 * 예측으로 후보를 떨어뜨리면 진짜 대상을 잃는다.
 *
 * 예측이 불확실할수록 거절 반경을 넓힌다. 좁게 두면 가림이 길었던
 * 경우에 정작 돌아온 진짜 대상을 떨어뜨린다.
 */
export function predictionGate(
  prediction: TrackRegionPrediction | null,
  candidateBox: PredictionBox,
  policy: Partial<typeof PREDICTION_GATE_POLICY> = {},
): PredictionGateResult {
  const P = { ...PREDICTION_GATE_POLICY, ...policy };
  if (!prediction) {
    return { verdict: 'neutral', distanceBodies: null, reason: 'no-prediction', canPromote: false };
  }
  if (!prediction.usable) {
    return { verdict: 'neutral', distanceBodies: null, reason: 'prediction-not-usable', canPromote: false };
  }
  const bodyHeight = Math.max(1, prediction.box.height);
  const candidate = centerOf(candidateBox);
  const distance = Math.hypot(
    candidate.x - prediction.center.x,
    candidate.y - prediction.center.y,
  ) / bodyHeight;

  const uncertaintyBodies = Number.isFinite(prediction.uncertaintyPx)
    ? prediction.uncertaintyPx / bodyHeight
    : P.maxSlackBodies;
  const slack = Math.min(P.maxSlackBodies, uncertaintyBodies * P.uncertaintySlackBodies);
  const limit = P.maxDistanceBodies + slack;

  if (distance > limit) {
    return {
      verdict: 'reject',
      distanceBodies: distance,
      reason: 'too-far-from-prediction',
      canPromote: false,
    };
  }
  /* 가깝다. 그래서 어떻다는 말은 하지 않는다 — 그 자리에는 누구든 있을 수 있다. */
  return {
    verdict: 'neutral',
    distanceBodies: distance,
    reason: 'within-prediction-radius-no-claim',
    canPromote: false,
  };
}

/**
 * 예측이 후보를 승격시키지 않는지 본다.
 *
 * 타입에 `accept` 가 있으니 누군가 반환하도록 고칠 수 있다. 그때 조용히
 * 지나가지 않게 여기서 잡는다. 시험과 빌드 게이트가 이 함수를 부른다.
 */
export function assertNeverAccepts(result: PredictionGateResult): boolean {
  return result.verdict !== 'accept' && result.canPromote === false;
}

/** 예측이 증거 칸에 새어 들어갔는지 본다. 하나라도 있으면 false. */
export function assertEvidenceFreeOfPrediction(evidence: ReentryEvidence): boolean {
  const banned = [
    'predictedCenter', 'predictionDistance', 'predictionScore', 'regionPrediction',
    'predictedBox', 'motionPrior', 'predictionAgreement', 'predictionSimilarity',
  ];
  const record = evidence as unknown as Record<string, unknown>;
  return !banned.some((key) => key in record);
}

/**
 * 예측을 신원 판정에 넘기기 전에 통과시키는 좁은 문.
 *
 * 나가는 것은 **거절 여부 하나뿐**이다. 점수도, 거리도, 예측 상자도
 * 넘기지 않는다. 숫자가 넘어가면 언젠가 누가 그 숫자로 가중치를 만든다.
 */
export function predictionRejectOnly(
  prediction: TrackRegionPrediction | null,
  candidateBox: PredictionBox,
): boolean {
  return predictionGate(prediction, candidateBox).verdict === 'reject';
}
