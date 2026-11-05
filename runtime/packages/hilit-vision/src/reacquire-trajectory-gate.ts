/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d7656487 @license @preserve */
/* 추적이 끝난 궤적에 재획득 확정 절차를 적용한다.

무엇을 막는가. 대상이 가려지거나 화면 밖으로 나갔다가 추적이 다시 붙을 때,
지금까지는 그 순간부터 바로 "같은 사람" 으로 취급했다. 다른 사람을 잡았어도
화면에는 정상 추적으로 보인다. 사용자는 틀렸다는 것을 알 방법이 없다.

여기서는 끊겼다 다시 붙은 구간을 곧바로 확정하지 않는다. 최소 관측 수와
최소 확인 시간을 채울 때까지는 잠정(REACQUIRED_PROVISIONAL / VERIFYING)으로
두고 신뢰도를 낮춘다. 그동안 화면은 계속 따라간다 — 추적을 멈추지 않는다.

이 모듈은 신원을 주장하지 않는다. 자동으로 "같은 사람이다" 라고 올리는 일도
하지 않는다([[reacquire-confirmation]] 의 autoConfirm 은 계속 꺼져 있다).
하는 일은 확신을 미루는 것뿐이다.

왜 묻는 구간을 아끼는가. 잘 따라가는 구간까지 "확인 필요" 로 칠하면 사용자는
매번 확인 창을 닫아야 한다. 실측에서 확인점 18개 중 14개가 그렇게 칠해진 적이
있다. 그래서 기본은 알려만 주는 등급(watch)이고, 공백이 길고 경쟁자가 있을
때만 묻는 등급(risk)으로 올린다.
*/

import { REACQUIRE_CONFIRM_POLICY } from './reacquire-confirmation';

/** 이 기능이 켜져 있는가. 끄면 예전 동작 그대로다. */
export const REACQUIRE_TRAJECTORY_GATE_ENABLED = true;

export interface TrajectoryGatePolicy {
  /** 확정에 필요한 최소 실관측 프레임 수. */
  minObservations: number;
  /** 단순한 짧은 공백 뒤 최소 확인 시간(초). */
  minConfirmSec: number;
  /** 경쟁자가 있거나 공백이 길 때의 최소 확인 시간(초). */
  minConfirmSecHard: number;
  /** 이보다 짧은 공백은 확정 절차를 열지 않는다(초). 깜빡임까지 잡지 않는다. */
  ignoreGapShorterThanSec: number;
  /** 이 시간을 넘는 공백은 어려운 장면으로 본다(초). */
  hardGapSec: number;
  /** 잠정 구간의 신뢰도 상한. */
  tentativeConfidenceCap: number;
}

/* 값은 calibration 전 초기 가설이다. 논문이 보장한 최적값이 아니다.

   숫자를 글자 그대로 적는다. 앱(HilitReacquireGate.java)과 값을 맞추는 검사기
   (scripts/check-android-tracking-parity.mjs)가 소스에서 숫자를 읽기 때문이다.
   참조로 써 두면 검사기가 값을 못 보고, 한쪽만 바뀌어도 통과해 버린다.
   확정 상태 기계와 같은 값이라는 것은 아래 assert 와 시험이 지킨다. */
export const TRAJECTORY_GATE_POLICY: Readonly<TrajectoryGatePolicy> = Object.freeze({
  minObservations: 3,
  minConfirmSec: 0.4,
  minConfirmSecHard: 0.8,
  ignoreGapShorterThanSec: 0.12,
  hardGapSec: 1,
  tentativeConfidenceCap: 0.55,
});

/** 확정 상태 기계와 값이 갈라지면 바로 터뜨린다. 조용히 갈라지는 쪽이 더 나쁘다. */
export function assertGatePolicyMatchesConfirmPolicy(): void {
  const mismatched: string[] = [];
  if (TRAJECTORY_GATE_POLICY.minObservations !== REACQUIRE_CONFIRM_POLICY.minObservations) mismatched.push('minObservations');
  if (TRAJECTORY_GATE_POLICY.minConfirmSec !== REACQUIRE_CONFIRM_POLICY.minConfirmSec) mismatched.push('minConfirmSec');
  if (TRAJECTORY_GATE_POLICY.minConfirmSecHard !== REACQUIRE_CONFIRM_POLICY.minConfirmSecHard) mismatched.push('minConfirmSecHard');
  if (mismatched.length) {
    throw new Error(`재획득 정책이 갈라졌습니다: ${mismatched.join(', ')}`);
  }
}

export interface TrajectoryGateInput {
  timestamp: number;
  /** 이 프레임에서 대상을 실제로 붙들고 있었는가. 예측만이면 false. */
  observed: boolean;
  /** 같은 프레임에 보인 다른 사람 상자 수. 신원이 아니라 경쟁 강도다. */
  competingCount: number;
}

export type TentativeLifecycle = 'REACQUIRED_PROVISIONAL' | 'VERIFYING';

export interface TrajectoryGateMark {
  index: number;
  /** 아직 확정하지 못한 잠정 구간인가. */
  tentative: boolean;
  lifecycle: TentativeLifecycle | null;
  /** 앞선 공백의 길이(초). */
  gapSec: number;
  /** 경쟁자가 있거나 공백이 길어 확인을 더 요구하는 상황인가. */
  hardScene: boolean;
}

export interface TrajectoryGateSpan {
  start: number;
  end: number;
  reason: string;
  /** watch = 알려만 준다 · risk = 사용자에게 묻는다. */
  level: 'watch' | 'risk';
  gapSec: number;
}

export interface TrajectoryGateResult {
  marks: TrajectoryGateMark[];
  spans: TrajectoryGateSpan[];
  /** 확정 절차를 연 재획득 구간 수. */
  reacquisitions: number;
  /** 그중 사용자에게 묻는 구간 수. */
  askedCount: number;
  /** 이 점수는 순위 근거이지 신원 확률이 아니다. */
  identityClaim: false;
}

/**
 * 끊겼다 다시 붙은 구간을 찾아 잠정 표시를 만든다.
 *
 * 입력은 시간 오름차순이라고 가정한다. 궤적을 바꾸지 않는다 — 어디를
 * 잠정으로 볼지만 알려준다. 실제 반영은 부르는 쪽이 한다.
 */
export function gateReacquisitions(
  points: readonly TrajectoryGateInput[],
  policy: Partial<TrajectoryGatePolicy> = {},
): TrajectoryGateResult {
  const p: TrajectoryGatePolicy = { ...TRAJECTORY_GATE_POLICY, ...policy };
  const marks: TrajectoryGateMark[] = [];
  const spans: TrajectoryGateSpan[] = [];
  let reacquisitions = 0;
  let askedCount = 0;

  let i = 0;
  while (i < points.length) {
    if (points[i].observed) { i += 1; continue; }

    /* 공백 구간을 끝까지 읽는다. */
    const gapStart = i;
    while (i < points.length && !points[i].observed) i += 1;
    if (i >= points.length) break;
    const gapEndExclusive = i;
    const gapSec = points[gapEndExclusive].timestamp - points[gapStart].timestamp;
    if (gapSec < p.ignoreGapShorterThanSec) continue;

    /* 다시 붙은 구간을 검증한다. */
    const resumeAt = points[i].timestamp;
    let competing = 0;
    let look = 0;
    for (let k = i; k < points.length && look < p.minObservations * 2; k += 1, look += 1) {
      if (points[k].observed) competing = Math.max(competing, points[k].competingCount);
    }
    const hardScene = competing > 0 || gapSec >= p.hardGapSec;
    const needSec = hardScene ? p.minConfirmSecHard : p.minConfirmSec;

    reacquisitions += 1;
    let observations = 0;
    let lastTentativeIndex = i;
    let confirmed = false;
    for (let k = i; k < points.length; k += 1) {
      /* 공백이 다시 열리면 이 재획득은 끝난 것으로 본다. 다음 회차가 맡는다. */
      if (!points[k].observed) break;
      observations += 1;
      const elapsed = points[k].timestamp - resumeAt;
      if (observations >= p.minObservations && elapsed >= needSec) { confirmed = true; break; }
      marks.push({
        index: k,
        tentative: true,
        lifecycle: hardScene ? 'VERIFYING' : 'REACQUIRED_PROVISIONAL',
        gapSec: Number(gapSec.toFixed(4)),
        hardScene,
      });
      lastTentativeIndex = k;
    }

    if (marks.length && marks[marks.length - 1].index === lastTentativeIndex) {
      /* 공백이 길고 **경쟁자까지 있을 때만** 묻는다.
         주위에 아무도 없으면 남을 잡았을 위험이 낮다. 그런 구간까지 물으면
         사용자는 확인 창만 닫게 된다. */
      const ask = competing > 0 && gapSec >= p.hardGapSec;
      if (ask) askedCount += 1;
      spans.push({
        start: resumeAt,
        end: points[lastTentativeIndex].timestamp,
        reason: confirmed
          ? (hardScene ? '가림이 끝난 뒤 같은 사람인지 확인하는 중' : '잠깐 끊긴 뒤 다시 붙는 중')
          : '끊긴 뒤 확인을 끝내지 못했다',
        level: ask ? 'risk' : 'watch',
        gapSec: Number(gapSec.toFixed(4)),
      });
    }
  }

  return { marks, spans, reacquisitions, askedCount, identityClaim: false };
}
