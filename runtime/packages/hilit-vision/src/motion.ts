/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e627494c @license @preserve */
/* HILIT Motion — 대상이 다음에 어디 있을지.
 *
 * NanoTrack(권리 미확인 가중치)이 하던 일의 일부를 **가중치 없이** 한다.
 *
 * ## 무엇을 대체하나
 *
 * NanoTrack 은 template 과 지금 프레임을 비교해 대상의 자리를 찾는
 * 샴 네트워크다. 우리 파이프라인에서 그것이 하던 일은 둘이었다.
 *
 *   1. 프레임 사이를 이어 주기 — 검출을 매번 돌리지 않아도 자리를 안다
 *   2. 가림 동안 버티기 — 검출이 없어도 다음 자리를 짐작한다
 *
 * 둘 다 **운동 모델**로 할 수 있는 일이다. 2번은 원래 운동 모델의
 * 영역이고, 1번은 우리가 이미 3프레임마다 검출을 돌리고 있으므로
 * 그 사이를 메우는 문제다.
 *
 * ## 관측 중심으로 갱신한다 (OC-SORT 착상, MIT)
 *
 * 보통의 칼만 필터는 가림 동안 예측만 하며 나아간다. 그런데 예측은
 * 매 걸음 조금씩 틀리고, 그 오차가 쌓인다. 3초를 가려져 있다가 나오면
 * 예측 위치는 이미 엉뚱한 곳이다 — 그리고 그 엉뚱한 위치를 기준으로
 * 후보를 고르니 다른 사람을 잡는다.
 *
 * 관측 중심 착상은 이렇다: **가림이 끝나고 진짜 관측이 돌아오면,
 * 사라지기 직전의 관측과 지금 관측을 직선으로 이어 그 사이의 속도를
 * 다시 계산한다.** 쌓인 예측 오차를 버리고 실제로 일어난 일로 바꾼다.
 *
 * 우리 영상에서 이게 중요한 이유: 경기 중 사람은 등속으로 움직이지
 * 않는다. 급정지하고, 방향을 바꾸고, 점프한다. 등속 가정으로 3초를
 * 예측하면 반드시 틀린다.
 *
 * ## 왜 고정 이득인가
 *
 * 정식 칼만 필터는 공분산 행렬을 들고 다니며 이득을 매 걸음 계산한다.
 * 우리는 그러지 않는다 — 관측 잡음을 제대로 추정할 방법이 없고(검출기가
 * 얼마나 정확한지 우리도 모른다), 그 추정이 틀리면 계산한 이득이 오히려
 * 해롭다. 고정 이득은 단순하고, 무엇보다 **예측 가능하게** 틀린다.
 */

import {
  TrackRegionPredictor,
  type PredictionBox,
} from './track-region-prediction';

export interface Point { x: number; y: number }

/**
 * 상자를 화면 안에 붙잡아 둔다.
 *
 * 🔴 이 함수가 없어서 시뮬레이션에서 추적기가 **화면 밖 4.4배 위치까지
 *    달아났다.** 예측이 조금씩 앞서고, 그 예측 자리에서 잘라낸 조각은
 *    화면 밖이라 전부 같은 값이 나오고, 같은 값이니 늘 "찾았다" 고
 *    판정하며 계속 나아갔다. 되돌아올 방법이 없다.
 *
 * 사람은 화면 밖으로 나갈 수 있다. 하지만 **상자의 가운데가** 화면 밖
 * 멀리 있는 것은 추적이 아니라 폭주다. 가장자리에 걸치는 것까지만
 * 허용한다 — 몸 절반이 잘린 모습은 실제로 자주 있다.
 */
export function clampBox(box: MotionBox): MotionBox {
  return {
    cx: Math.max(-box.w / 2, Math.min(1 + box.w / 2, box.cx)),
    cy: Math.max(-box.h / 2, Math.min(1 + box.h / 2, box.cy)),
    w: Math.max(0.005, Math.min(1.5, box.w)),
    h: Math.max(0.005, Math.min(1.5, box.h)),
  };
}

export interface MotionBox {
  /** 중심 x (0~1). */
  cx: number;
  /** 중심 y (0~1). */
  cy: number;
  w: number;
  h: number;
}

export interface MotionState extends MotionBox {
  /** 초당 이동량. */
  vx: number;
  vy: number;
}

/** 위치를 관측 쪽으로 얼마나 끌어당길 것인가. */
const POS_GAIN = 0.55;
/** 속도를 새 값으로 얼마나 갈아탈 것인가. 위치보다 느리게 — 속도는 잡음이 크다. */
const VEL_GAIN = 0.30;
/** 크기는 가장 느리게. 사람 크기는 한 프레임에 크게 바뀌지 않는다. */
const SIZE_GAIN = 0.25;

/** 예측만으로 버티는 최대 시간(초). 이보다 길면 예측을 믿지 않는다. */
export const MAX_COAST_SECONDS = 2.5;

/**
 * 관측이 이만큼 끊기면 "가려졌다" 로 본다(초).
 *
 * 이 값을 넘긴 뒤 관측이 돌아오면 그동안의 예측을 버리고, 사라지기
 * 직전과 지금을 직선으로 이어 속도를 다시 만든다(관측 중심 갱신).
 *
 * 0.4초는 30fps 에서 12프레임이다. 우리 파이프라인이 3프레임마다
 * 검출을 돌리므로 정상 간격(0.1초)의 네 배다 — 정상 흐름을 가림으로
 * 오해하지 않으면서, 실제 끊김은 놓치지 않는 자리다.
 */
export const OCCLUSION_GAP = 0.4;

/**
 * 사람이 1초에 갈 수 있는 최대 거리 — **자기 몸 너비의 몇 배**인가.
 *
 * ## 왜 필요한가 — 실측으로 드러났다
 *
 * 이 상한이 없을 때 시뮬레이션에서 예측이 폭주했다.
 *
 *   프레임 5   정답 cx=0.492   예측 cx=0.502
 *   프레임 9   정답 cx=0.510   예측 cx=0.589   ← 벌써 몸 하나만큼 앞섬
 *   프레임 10  정답 cx=0.508   1등 cx=0.734    ← 다른 곳을 잡았다
 *
 * 원인은 관측의 떨림이다. 후보를 격자로 훑으므로 관측 자리가 격자 눈금에
 * 붙는데, 그 눈금 간격이 한 프레임의 실제 이동보다 훨씬 크다. 0.02 의
 * 떨림을 1/30 초로 나누면 **초속 0.6** 이 되고, 그건 화면을 1.7초에
 * 가로지르는 속도다. 사람이 그렇게 못 움직인다.
 *
 * 그래서 물리적으로 말이 되는 선을 긋는다. 자기 몸 너비의 6배면
 * 전력 질주다 — 그보다 빠른 값은 관측 잡음이지 움직임이 아니다.
 *
 * 몸 너비 기준인 이유: 멀리 있는 작은 사람은 화면에서 느리게 움직이고
 * 가까운 사람은 빠르게 움직인다. 화면 비율로 상한을 두면 먼 사람에게는
 * 너무 헐겁고 가까운 사람에게는 너무 빡빡하다.
 */
export const MAX_SPEED_BODIES = 6;

/**
 * 방향을 잴 때 되돌아보는 시간(초).
 *
 * ## 왜 한 프레임 차이로 방향을 재면 안 되는가 (OC-SORT 의 OCM)
 *
 * 한 프레임 사이의 이동은 대개 몇 화소다. 검출 상자의 떨림도 몇
 * 화소다. 즉 **신호와 잡음이 같은 크기**여서, 그렇게 잰 방향은 매
 * 프레임 튄다. 그 방향으로 후보를 걸러 내면 걸러지는 것이 잡음이다.
 *
 * 0.3초를 되돌아보면 사람은 자기 몸 하나쯤 움직였고, 상자 떨림은
 * 그 안에 묻힌다. OC-SORT 논문이 3프레임(30fps 에서 0.1초)을 쓰는데,
 * 우리 분석은 12~20fps 라 프레임 수가 아니라 **시간**으로 잡는다.
 * https://arxiv.org/abs/2203.14360
 */
export const HEADING_WINDOW = 0.3;

/** 관측 기록을 몇 개까지 들고 있을 것인가. 방향 계산에만 쓰므로 짧게. */
const HISTORY_MAX = 24;

/* 운동 상태는 `track-region-prediction.ts` 의 예측기 한 벌만 들고 있다.
 *
 * 예전에는 두 벌이었다. 이 파일의 고정 이득 모델과 추적 영역 예측기가
 * 각자 속도를 재고, 그중 이 파일 쪽은 **시험에서만 돌았다.** 값이 어긋나면
 * 어느 쪽이 맞는지 아무도 모른다.
 *
 * 그래서 상태(위치·속도·관측 중심 갱신·속도 상한)는 예측기가 갖고,
 * 이 클래스는 그 위에서 **후보 심사용 규칙**만 얹는다. 심사 규칙은
 * 프레이밍 규칙과 자가 다르다.
 *
 *   errorOf        사람 크기 배수로 잰다 — 멀리 있는 작은 사람이 늘
 *                  "말도 안 되는 곳으로 튀었다" 가 되지 않게
 *   observedHeading 창 안에서 몸 너비 1/4 도 못 움직였으면 방향이 없다 —
 *                  떨림을 방향이라고 부르면 진짜 후보를 떨어뜨린다
 *   virtualPath    두 관측 사이를 잇되 크기는 거리의 역수로 — 선형으로
 *                  이으면 중간이 늘 크게 잡힌다
 */

/** 정규화 좌표(0~1)를 예측기의 픽셀 좌표로 바꾸는 배율.
 *
 * 예측기의 잡음·가속 기본값은 픽셀 기준이다. 정규화 좌표를 그대로
 * 넣으면 관측잡음 3이 화면 세 개 폭이 되어 관측을 통째로 무시한다. */
const NORM_SCALE = 1000;
const NORM_FRAME = { width: NORM_SCALE, height: NORM_SCALE };

function toPixelBox(box: MotionBox): PredictionBox {
  return {
    x: (box.cx - box.w / 2) * NORM_SCALE,
    y: (box.cy - box.h / 2) * NORM_SCALE,
    width: Math.max(1e-3, box.w * NORM_SCALE),
    height: Math.max(1e-3, box.h * NORM_SCALE),
  };
}

export class HilitMotion {
  private readonly core = new TrackRegionPredictor();
  /** 마지막으로 **진짜 관측**을 본 시각과 그때의 자리. */
  private lastObserved: { at: number; box: MotionBox } | null = null;
  /** 최근 관측들. 방향을 시간 창으로 재기 위해 들고 있는다(OCM). */
  private history: Array<{ at: number; box: MotionBox }> = [];
  private lastAt = 0;
  private started = false;

  /** 처음 지목했을 때. 속도는 아직 모른다 — 0으로 두고 관측으로 배운다. */
  start(box: MotionBox, at: number): void {
    this.core.start(toPixelBox(box), at);
    this.lastAt = at;
    this.lastObserved = { at, box: { ...box } };
    this.history = [{ at, box: { ...box } }];
    this.started = true;
  }

  /** 지금 알고 있는 자리. 아직 시작 전이면 null. */
  current(): MotionState | null {
    const state = this.core.motionState();
    if (!state || !this.started) return null;
    return {
      ...clampBox({
        cx: state.cx / NORM_SCALE,
        cy: state.cy / NORM_SCALE,
        w: state.width / NORM_SCALE,
        h: state.height / NORM_SCALE,
      }),
      vx: state.vx / NORM_SCALE,
      vy: state.vy / NORM_SCALE,
    };
  }

  /**
   * 관측 없이 시간만 흐른다 — 가림 중이다.
   *
   * 속도를 조금씩 줄인다. 사람은 영원히 같은 속도로 가지 않고, 무엇보다
   * **오래 못 본 상태에서 멀리까지 예측하면 그 예측이 해롭다.**
   */
  coast(at: number): MotionState | null {
    if (!this.started) return null;
    if (at <= this.lastAt) return this.current();
    this.core.observe({
      tSec: at,
      center: null,
      box: null,
      detectionConfidence: null,
      occlusion: 'occluded',
      frame: NORM_FRAME,
    });
    this.lastAt = at;
    return this.current();
  }

  /**
   * 진짜 관측이 들어왔다.
   *
   * 관측 중심 갱신(가림이 길었으면 쌓인 예측 오차를 버리고 마지막 관측과
   * 지금 관측을 직선으로 이어 속도를 다시 만드는 것)과 신뢰도에 따른
   * 이득 조절은 예측기 안에 있다.
   *
   * @param confidence 이 관측을 얼마나 믿는가 (0~1). 생략하면 1.
   */
  observe(box: MotionBox, at: number, confidence = 1): MotionState {
    if (!this.started) {
      this.start(box, at);
      return this.current() as MotionState;
    }
    this.core.observe({
      tSec: at,
      center: null,
      box: toPixelBox(box),
      previousCenter: this.lastObserved
        ? { x: this.lastObserved.box.cx * NORM_SCALE, y: this.lastObserved.box.cy * NORM_SCALE }
        : null,
      detectionConfidence: Number.isFinite(confidence) ? confidence : 1,
      occlusion: 'visible',
      frame: NORM_FRAME,
    });
    this.lastAt = at;
    this.lastObserved = { at, box: { ...box } };
    this.history.push({ at, box: { ...box } });
    this.history = this.history.filter((h) => at - h.at <= 1.5).slice(-24);
    return this.current() as MotionState;
  }

  /**
   * 가림 동안 대상이 지났을 법한 자리.
   *
   * 크기는 선형으로 잇지 않고 **곡선**으로 잇는다. 사람이 멀어졌다
   * 가까워지는 동안 크기는 거리의 역수로 변한다. 선형으로 이으면
   * 중간에서 늘 크게 잡힌다.
   */
  virtualPath(box: MotionBox, at: number, steps: number): Array<{ at: number; box: MotionBox }> {
    const from = this.lastObserved;
    if (!from || steps < 1) return [];
    const span = at - from.at;
    if (span <= 1e-6) return [];

    const path: Array<{ at: number; box: MotionBox }> = [];
    for (let i = 1; i <= steps; i += 1) {
      const k = i / (steps + 1);
      path.push({
        at: from.at + span * k,
        box: clampBox({
          cx: from.box.cx + (box.cx - from.box.cx) * k,
          cy: from.box.cy + (box.cy - from.box.cy) * k,
          w: 1 / ((1 - k) / Math.max(1e-4, from.box.w) + k / Math.max(1e-4, box.w)),
          h: 1 / ((1 - k) / Math.max(1e-4, from.box.h) + k / Math.max(1e-4, box.h)),
        }),
      });
    }
    return path;
  }

  /**
   * 이 시각에 대상이 있을 만한 자리.
   *
   * 상태를 바꾸지 않는다 — 후보를 점수 매길 때 여러 번 물어보기 때문이다.
   */
  predict(at: number): MotionBox | null {
    const state = this.current();
    if (!state) return null;
    const dt = Math.max(0, at - this.lastAt);
    if (dt > MAX_COAST_SECONDS) return null;
    return clampBox({
      cx: state.cx + state.vx * dt,
      cy: state.cy + state.vy * dt,
      w: state.w,
      h: state.h,
    });
  }

  /**
   * 예측한 자리에서 얼마나 벗어났나 — 사람 크기로 나눈 값.
   *
   * 화면 비율이 아니라 **사람 크기 배수**로 재는 것이 중요하다. 멀리
   * 있는 작은 사람은 화면에서 조금만 움직여도 자기 몸 몇 배를 간 것이고,
   * 가까운 사람은 크게 움직여도 반 걸음이다.
   */
  errorOf(box: MotionBox, at: number): number {
    const guess = this.predict(at);
    if (!guess) return Infinity;
    const scale = Math.max(0.02, (guess.w + guess.h) / 2);
    return Math.hypot(box.cx - guess.cx, box.cy - guess.cy) / scale;
  }

  /**
   * 관측만으로 잰 방향 (OCM).
   *
   * 필터 상태의 속도가 아니라 **실제로 본 자리들**로 잰다. 필터 속도는
   * 예측이 섞여 있어 가림 중에도 값이 남아 있고, 그 값은 "사람이 그리로
   * 갔다" 가 아니라 "우리가 그렇게 짐작했다" 이다.
   */
  observedHeading(window = HEADING_WINDOW): Point | null {
    if (this.history.length < 2) return null;
    const last = this.history[this.history.length - 1];
    let first = last;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      first = this.history[i];
      if (last.at - first.at >= window) break;
    }
    if (first === last) return null;

    const dx = last.box.cx - first.box.cx;
    const dy = last.box.cy - first.box.cy;
    const len = Math.hypot(dx, dy);
    /* 창 전체에서 자기 몸 너비의 1/4 도 못 움직였으면 멈춰 있는 것이다.
     * 떨림을 방향이라고 부르면 그 방향으로 후보를 걸러 내다가 진짜를
     * 떨어뜨린다. */
    const scale = Math.max(0.01, (last.box.w + last.box.h) / 2);
    if (len < scale * 0.25) return null;
    return { x: dx / len, y: dy / len };
  }

  /** 대상이 향하는 쪽. 관측으로 잰 방향이 있으면 그쪽이 사실이다. */
  heading(): Point | null {
    const observed = this.observedHeading();
    if (observed) return observed;
    const state = this.current();
    if (!state) return null;
    const speed = Math.hypot(state.vx, state.vy);
    if (speed < 1e-3) return null;
    return { x: state.vx / speed, y: state.vy / speed };
  }

  reset(): void {
    this.core.reset();
    this.lastObserved = null;
    this.history = [];
    this.lastAt = 0;
    this.started = false;
  }
}
