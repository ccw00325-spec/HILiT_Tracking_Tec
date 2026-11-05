/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·18d00ca2 @license @preserve */
/* HILIT Association — 후보 중에 누가 그 사람인가.
 *
 * 이 파일이 V2 의 심장이다. 검출기도 외형 서술자도 운동 모델도 결국
 * 여기에 **신호를 대는 것**이고, 판정은 여기서 한 번만 내린다.
 *
 * ## 한 가지 신호로 판정하지 않는다
 *
 * 이게 규칙이다. 이유는 각 신호가 언제 틀리는지가 다르기 때문이다.
 *
 *   색      같은 유니폼을 입은 팀에서는 쓸모가 없다
 *   위치    가림이 길면 예측이 엉뚱한 곳을 가리킨다
 *   크기    사람이 카메라 쪽으로 오면 커진다
 *   방향    멈춘 사람에게는 방향이 없다
 *
 * 어느 하나도 혼자서는 못 믿는다. 그런데 **동시에 틀리는 일은 드물다** —
 * 같은 유니폼이면서 예측 위치에 있고 크기까지 맞는 다른 사람은 흔치 않다.
 *
 * ## ByteTrack 착상 (MIT) — 낮은 신뢰도를 버리지 않는다
 *
 * 검출기가 확신하지 못한 상자를 그냥 버리면, 가려졌다 반쯤 나온 사람은
 * 영영 못 찾는다. 반쯤 가려진 사람의 검출 신뢰도는 원래 낮다.
 *
 * 그래서 두 겹으로 본다.
 *
 *   높은 신뢰도  1차 연결 — 여기서 답이 나오면 끝
 *   낮은 신뢰도  복구 연결 — 1차에서 못 찾았을 때만 본다
 *
 * 다만 낮은 신뢰도 후보가 ID 를 바꿔치지 못하게 **문턱을 높인다.**
 * 확신 없는 검출로 대상을 갈아타는 것이 가장 나쁜 실패다.
 */

import type { MotionBox } from './motion';

export interface Candidate {
  box: MotionBox;
  /** 검출기가 얼마나 확신하는가 (0~1). */
  confidence: number;
  /** 앵커와의 외형 유사도 (0~1). 없으면 0.5(모르겠다). */
  appearance?: number;
  /**
   * 그 외형 값을 얼마나 믿어도 되는가 (0~1). 서술자가 함께 낸다.
   *
   * ## 왜 필요한가 — 실측으로 드러났다
   *
   * 사용자가 준 영상 둘로 재 봤다.
   *
   *   테니스  대상이 화면의 4%, 상자가 몸에 맞는다
   *           같은 사람 0.71~0.93 / 다른 자리 0.30~0.53   분리도 +0.236
   *
   *   피겨    대상이 화면의 1%, 상자 안 대부분이 빙판이고
   *           다른 사람까지 들어온다
   *           같은 사람 0.08~0.46 / 다른 자리 0.07~0.32   분리도 -0.131
   *
   * 두 번째는 색 신호로 아예 가를 수 없다. 그런데 그걸 모르고 쓰면
   * 엉뚱한 사람을 고른다 — 없는 신호를 있는 것처럼 계산하는 것이
   * 신호가 없는 것보다 나쁘다.
   *
   * 서술자가 스스로 판단한다. 상자 안이 바깥과 비슷하면 낮게 낸다.
   * 실측 믿음도 중앙값: 테니스 0.51 / 피겨 0.32.
   */
  appearanceTrust?: number;
  /** 예측 자리에서 벗어난 정도 — 사람 크기 배수. HilitMotion.errorOf 값. */
  motionError: number;
  /**
   * 이 **정확한 자리**에서 무늬가 얼마나 맞는가. 없으면 판정에서 뺀다.
   *
   * ## 왜 따로 필요한가 — 실측으로 드러났다
   *
   * `appearance` 는 색 히스토그램이다. 화소를 세는 것이라 순서를 모르고,
   * 그래서 **조금 옮겨도 값이 거의 안 변한다.** "이 사람이 맞나" 에는
   * 강하지만 "정확히 어디인가" 는 못 가른다.
   *
   * 그 둘을 한 값으로 뭉쳐 두면 판정이 자리를 못 짚는다. 테니스 실측에서
   * 그 결과가 이렇게 나왔다.
   *
   *   프레임 3   무늬가 가장 잘 맞는 자리 0.489 (정답 0.484)
   *              그런데 실제로 고른 자리는 0.457
   *
   * 위치·크기·방향은 전부 **예측을 기준으로** 매기는 점수다. 예측이
   * 조금 뒤처져 있으면 그 셋이 한꺼번에 뒤쪽 후보를 밀어 준다. 무늬
   * 증거가 판정에 안 들어가 있으니 막을 것이 없다. 그렇게 매 프레임
   * 조금씩 뒤로 끌려가 30프레임 만에 화면 밖으로 나갔다.
   *
   * 그래서 무늬를 **따로** 낸다. 검출기 없는 경로에서는 NCC 상관값,
   * 앱의 V1 경로에서는 NanoTrack 이 내는 상관 점수가 여기 들어간다.
   *
   * 값은 후보들 사이에서 **상대적으로** 정규화해서 쓴다 — 절대값이
   * 아니라 "이 중 어디가 봉우리인가" 가 우리가 원하는 정보다.
   */
  shape?: number;
}

export interface AssociationContext {
  /** 마지막으로 확실히 본 뒤 흐른 시간(초). */
  gapSeconds: number;
  /** 대상이 향하던 쪽. 멈춰 있었으면 null. */
  heading?: { x: number; y: number } | null;
  /** 마지막으로 본 크기. 크기 비를 재는 기준이다. */
  lastSize?: { w: number; h: number };
  /** 카메라 보정 뒤에도 남은 흔들림(0~1). 클수록 위치 신호를 덜 믿는다. */
  cameraResidual?: number;
}

/** 이 값을 넘으면 높은 신뢰도로 본다. */
export const HIGH_CONFIDENCE = 0.5;

/** 1차 연결에서 이 점수를 넘어야 대상으로 인정한다. */
export const ACCEPT_PRIMARY = 0.55;

/**
 * 복구 연결의 문턱. 1차보다 높다.
 *
 * 확신 없는 검출로 대상을 갈아타는 것이 가장 나쁜 실패이기 때문이다.
 * "못 찾았다" 는 사용자가 알아채고 다시 짚을 수 있지만, "다른 사람으로
 * 갈아탔다" 는 완성된 영상을 보고 나서야 안다.
 */
export const ACCEPT_RECOVERY = 0.72;

export interface Scored {
  candidate: Candidate;
  score: number;
  /** 무엇 때문에 이 점수인가. 사람이 읽고 고칠 수 있어야 한다. */
  parts: { motion: number; appearance: number; size: number; direction: number; shape: number };
}

/** 예측에서 벗어난 정도를 0~1 점수로. 사람 크기 1배쯤이면 절반이다. */
function motionScore(error: number, cameraResidual: number): number {
  if (!Number.isFinite(error)) return 0;
  /* 카메라가 흔들렸으면 위치 신호를 관대하게 본다 — 그 흔들림은
   * 대상이 움직인 것이 아니라 화면이 움직인 것이다. */
  const tolerance = 1 + Math.min(1, Math.max(0, cameraResidual)) * 1.5;
  return 1 / (1 + Math.pow(error / tolerance, 2));
}

/** 크기가 얼마나 비슷한가. 1.5배까지는 살아 있다 — 사람은 다가온다. */
function sizeScore(box: MotionBox, last?: { w: number; h: number }): number {
  if (!last || last.w <= 0 || last.h <= 0) return 0.5;
  const ratio = Math.max(
    (box.w * box.h) / (last.w * last.h),
    (last.w * last.h) / (box.w * box.h),
  );
  return 1 / (1 + Math.pow(Math.max(0, ratio - 1) / 0.8, 2));
}

/** 가던 쪽으로 갔는가. 방향이 없으면 판단하지 않는다(0.5). */
function directionScore(
  box: MotionBox, heading: { x: number; y: number } | null | undefined,
  from: MotionBox | undefined,
): number {
  if (!heading || !from) return 0.5;
  const dx = box.cx - from.cx;
  const dy = box.cy - from.cy;
  const len = Math.hypot(dx, dy);
  /* 거의 안 움직였으면 방향으로 가릴 수 없다. */
  if (len < 1e-4) return 0.5;
  const dot = (dx / len) * heading.x + (dy / len) * heading.y;
  /* -1~1 을 0~1 로. 뒤로 간 후보도 0점은 아니다 — 사람은 되돌아온다. */
  return (dot + 1) / 2;
}

/**
 * 후보 하나를 점수 매긴다.
 *
 * 무게는 사람이 정한 값이다. 나중에 학습된 점수로 바꾼다
 * (docs/ASSOCIATION_ML_SPEC.md) — 그때 이 함수가 기준선이 된다.
 */
export function scoreCandidate(
  candidate: Candidate,
  context: AssociationContext,
  lastBox?: MotionBox,
): Scored {
  const motion = motionScore(candidate.motionError, context.cameraResidual ?? 0);
  const appearance = candidate.appearance ?? 0.5;
  const size = sizeScore(candidate.box, context.lastSize);
  const direction = directionScore(candidate.box, context.heading, lastBox);

  /* 오래 못 봤을수록 위치를 덜 믿고 외형을 더 믿는다.
   *
   * 방금까지 보고 있었다면 대상은 예측한 자리 근처에 있다 — 위치가
   * 가장 강한 단서다. 3초를 못 봤다면 어디로 갔는지 알 수 없고, 그때
   * 남는 것은 "어떻게 생겼나" 뿐이다. */
  const staleness = Math.min(1, Math.max(0, context.gapSeconds) / 2.5);

  /* 무늬 증거가 있으면 위치·크기·방향의 무게를 덜어 무늬에 준다.
   *
   * 저 셋은 전부 **예측을 기준으로** 매기는 점수다. 셋을 합쳐 0.75 를
   * 주면 판정이 사실상 "예측에 가까운 것" 을 고르는 일이 되고, 예측이
   * 조금이라도 치우쳐 있으면 그 치우침이 관측으로 되먹임된다.
   *
   * 무늬는 예측과 무관하게 화면에서 직접 읽은 증거다. 그래서 이 셋의
   * 되먹임 고리를 끊을 수 있는 유일한 신호다. */
  const hasShape = candidate.shape !== undefined;
  const wShape = hasShape ? 0.34 : 0;
  const wMotion = (0.50 - 0.25 * staleness) * (hasShape ? 0.62 : 1);
  let wAppearance = 0.25 + 0.25 * staleness;
  const wSize = hasShape ? 0.09 : 0.15;
  const wDirection = hasShape ? 0.06 : 0.10;

  /* 외형을 못 믿겠다고 하면 그만큼 무게를 뺀다.
   *
   * 뺀 무게는 위치로 옮긴다. 색이 쓸모없는 장면(대상이 작고 상자 안이
   * 배경투성이)에서는 "방금 여기 있었다" 가 남는 유일한 단서다.
   *
   * 🔴 이 줄이 없으면 피겨 같은 영상에서 **색 잡음이 판정을 지배한다.**
   *    실측에서 그 영상의 같은 사람 유사도가 0.24, 다른 자리가 0.22 였다 —
   *    거의 동전 던지기인데 무게 0.25~0.50 을 주고 있는 셈이다. */
  const trust = Math.min(1, Math.max(0, candidate.appearanceTrust ?? 1));
  const moved = wAppearance * (1 - trust);
  wAppearance -= moved;

  /* 외형을 못 믿을 때 남는 무게는 무늬로 보낸다 — 무늬가 있으면.
   * 무늬도 화면에서 직접 읽은 증거이고, 예측 되먹임에 걸리지 않는다. */
  const shape = candidate.shape ?? 0.5;
  const score = motion * (wMotion + (hasShape ? 0 : moved))
    + shape * (wShape + (hasShape ? moved : 0))
    + appearance * wAppearance + size * wSize + direction * wDirection;

  return { candidate, score, parts: { motion, appearance, size, direction, shape } };
}

export interface AssociationResult {
  /** 고른 후보. 아무것도 못 고르면 null — 억지로 고르지 않는다. */
  chosen: Scored | null;
  /** 복구 연결에서 골랐는가. 그랬다면 확신이 덜하다는 뜻이다. */
  viaRecovery: boolean;
  /** 점수 순 전체. 학습 표본을 남길 때 방해 후보로 쓴다. */
  ranked: Scored[];
}

/**
 * 후보들 중 대상을 고른다 — 두 겹으로.
 *
 * ## 왜 2등과의 차이를 보나
 *
 * 1등이 문턱을 넘었어도 **2등이 바짝 붙어 있으면 고르지 않는다.**
 * 두 후보가 비슷하게 그럴듯하다는 것은 신호가 둘을 가르지 못한다는
 * 뜻이고, 그때 찍으면 절반은 틀린다.
 *
 * 그리고 틀린 쪽의 대가가 훨씬 크다 — 못 찾으면 사용자가 다시 짚지만,
 * 갈아타면 완성된 영상을 보고 나서야 안다.
 */
export function associate(
  candidates: readonly Candidate[],
  context: AssociationContext,
  lastBox?: MotionBox,
): AssociationResult {
  /* 무늬 값은 **후보들 사이에서** 정규화한다.
   *
   * 상관값의 절대 크기는 장면에 따라 다르다. 코트처럼 무늬가 고른
   * 바닥에서는 어디를 대도 0.8 이 나오고, 관중석 앞에서는 맞는 자리도
   * 0.5 다. 절대값에 문턱을 걸면 장면마다 다시 맞춰야 한다.
   *
   * 우리가 알고 싶은 것은 "이 중 어디가 봉우리인가" 하나다. 가장 높은
   * 것을 1, 가장 낮은 것을 0 으로 펴면 그 정보만 남는다.
   *
   * 값이 다 같으면(봉우리가 없으면) 전부 0.5 를 준다 — 모르겠다는 뜻이고,
   * 그러면 판정은 나머지 신호로 넘어간다. */
  const shapes = candidates.map((c) => c.shape).filter((s): s is number => s !== undefined);
  let normalized: readonly Candidate[] = candidates;
  if (shapes.length === candidates.length && shapes.length > 1) {
    const lo = Math.min(...shapes);
    const hi = Math.max(...shapes);
    const span = hi - lo;
    normalized = candidates.map((c) => ({
      ...c,
      shape: span > 1e-6 ? ((c.shape as number) - lo) / span : 0.5,
    }));
  }

  const ranked = normalized
    .map((c) => scoreCandidate(c, context, lastBox))
    .sort((a, b) => b.score - a.score);

  const pick = (pool: Scored[], threshold: number): Scored | null => {
    if (!pool.length) return null;
    const [first] = pool;
    if (first.score < threshold) return null;

    /* 2등이 바짝 붙었으면 고르지 않는다 — **단, 떨어져 있을 때만.**
     *
     * 🔴 이 조건이 처음에는 없었고, 그래서 시뮬레이션에서 1111 프레임 중
     *    1110 번을 거부했다. 지역 탐색은 예측 자리 둘레를 격자로 훑으므로
     *    이웃한 후보들의 점수가 원래 비슷하다. 그 둘은 **경쟁하는 두 사람이
     *    아니라 같은 사람의 같은 자리**다. 그걸 "못 가리겠다" 로 읽으면
     *    추적기가 아무것도 못 고르고 예측만으로 흘러간다.
     *
     * 진짜 위험은 **멀리 떨어진** 두 후보가 비슷하게 그럴듯할 때다.
     * 그건 화면 안의 다른 사람일 가능성이 크고, 찍으면 절반은 틀린다.
     *
     * 그래서 사람 크기의 0.8배보다 멀리 있는 후보만 경쟁자로 센다. */
    const rival = pool.slice(1).find((s) => {
      const dx = s.candidate.box.cx - first.candidate.box.cx;
      const dy = s.candidate.box.cy - first.candidate.box.cy;
      const reach = Math.max(0.02, (first.candidate.box.w + first.candidate.box.h) / 2) * 0.8;
      return Math.hypot(dx, dy) > reach;
    });
    if (rival && rival.score > first.score * 0.92) return null;
    return first;
  };

  const high = ranked.filter((s) => s.candidate.confidence >= HIGH_CONFIDENCE);
  const primary = pick(high, ACCEPT_PRIMARY);
  if (primary) return { chosen: primary, viaRecovery: false, ranked };

  /* 1차에서 못 찾았다 — 낮은 신뢰도까지 본다. 문턱은 더 높다. */
  const recovery = pick(ranked, ACCEPT_RECOVERY);
  return { chosen: recovery, viaRecovery: Boolean(recovery), ranked };
}

/**
 * 학습 표본으로 남길 모양.
 *
 * 정답 후보만 모으면 "무엇이 아닌가" 를 못 배운다. 방해 후보를 함께
 * 남긴다(docs/ASSOCIATION_ML_SPEC.md).
 */
export interface AssociationSample {
  motionError: number;
  appearance: number;
  sizeScore: number;
  directionScore: number;
  confidence: number;
  gapSeconds: number;
  cameraResidual: number;
  rank: number;
  /** 이 후보가 정답이었는가. 사람이 확인한 뒤에만 채운다. */
  label?: 0 | 1;
}

export function toSamples(
  result: AssociationResult, context: AssociationContext,
): AssociationSample[] {
  return result.ranked.map((s, rank) => ({
    motionError: s.candidate.motionError,
    appearance: s.parts.appearance,
    sizeScore: s.parts.size,
    directionScore: s.parts.direction,
    confidence: s.candidate.confidence,
    gapSeconds: context.gapSeconds,
    cameraResidual: context.cameraResidual ?? 0,
    rank,
  }));
}
