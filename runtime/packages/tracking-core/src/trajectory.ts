/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·dd46a68a @license @preserve */
import { clamp01, type TrackingPoint } from '@hilit/shared-types';

/* 궤적 후처리.
 *
 * 왜 여기서 하는가
 * ----------------
 * 우리는 실시간 카메라 워크를 하는 게 아니다. 추적이 **다 끝난 뒤에**
 * 렌더한다. 즉 미래를 이미 알고 있다.
 *
 * 실시간 필터는 미래를 모르니 지연을 감수하거나 흔들림을 남긴다.
 * 오프라인에서는 그 제약이 없다 — 지연 없는(zero-phase) 평활이 가능하고,
 * 가려진 구간은 앞뒤를 이어 **보간**할 수 있다. 앞만 보고 외삽하면
 * 반드시 흘러가지만, 양쪽을 알면 정확히 이어진다.
 *
 * 실측 (수정 전, 농구 7초 / 107프레임)
 *   평균 속도  0.00473
 *   평균 저크  0.00706   <- 속도보다 크다. 실제 이동보다 방향 전환이 잦다
 *   방향 전환  19회 (17.8%)
 *
 * 순서
 *   1. 이상치 제거   Hampel (중앙값 + MAD). 한 프레임 튐은 ID 오인일 때가 많다
 *   2. 구간 보간     가려진 구간을 앞뒤 값으로 잇는다 (단조 3차, 오버슈트 없음)
 *   3. 지연 없는 평활 정방향 + 역방향 지수 평활 — 위상 지연이 상쇄된다
 *   4. 크기 평활     박스 크기는 위치보다 더 떨리므로 따로, 더 세게
 *
 * 전부 O(n) 이고 n 은 보통 100~300 이다. 비용은 사실상 0 이다.
 */

export interface RefineOptions {
  /** 이상치 판정 창 반경 (프레임). */
  hampelWindow?: number;
  /** 중앙값에서 MAD 몇 배까지 정상으로 볼 것인가. */
  hampelSigma?: number;
  /** 위치 평활 강도 0~1. 클수록 원본을 따른다. */
  positionAlpha?: number;
  /** 크기 평활 강도. 위치보다 작게 둔다 (더 세게 평활). */
  sizeAlpha?: number;
  /** 이 프레임 수보다 긴 공백은 잇지 않는다. 다른 사람일 수 있다. */
  maxBridgeFrames?: number;
  /** 이 값 미만이면 그 프레임을 믿지 않는다. */
  minHealth?: number;
}

const DEFAULTS: Required<RefineOptions> = {
  hampelWindow: 3,
  hampelSigma: 3,
  positionAlpha: 0.35,
  sizeAlpha: 0.18,
  maxBridgeFrames: 45,
  minHealth: 0.5,
};

/** 중앙값. 작은 배열이라 정렬로 충분하다. */
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* Hampel 이상치 검출.
 *
 * 각 점을 이웃의 중앙값과 비교한다. MAD(중앙값 절대편차)의 sigma 배를
 * 넘으면 이상치로 보고 중앙값으로 바꾼다.
 *
 * 평균·표준편차를 쓰지 않는 이유: 이상치 자신이 평균을 끌고 가서
 * 정작 그 이상치를 못 잡는다. 중앙값은 그 영향을 받지 않는다. */
function hampel(values: number[], window: number, sigma: number): number[] {
  const out = values.slice();
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(values.length, i + window + 1);
    const win = values.slice(lo, hi);
    const med = median(win);
    const mad = median(win.map((v) => Math.abs(v - med)));
    // 1.4826 은 정규분포에서 MAD 를 표준편차로 환산하는 상수다.
    const threshold = sigma * 1.4826 * mad;
    if (threshold > 1e-9 && Math.abs(values[i] - med) > threshold) out[i] = med;
  }
  return out;
}

/* 지연 없는 평활 (forward-backward).
 *
 * 지수 평활을 정방향으로 한 번, 역방향으로 한 번 돌린다. 각 방향에서
 * 생긴 위상 지연이 서로 상쇄되어 결과가 원래 위치에 남는다.
 * 실시간에서는 불가능하고 오프라인에서만 되는 방법이다. */
function zeroPhaseSmooth(values: number[], alpha: number): number[] {
  if (values.length < 3) return values.slice();
  const fwd = new Array<number>(values.length);
  let acc = values[0];
  for (let i = 0; i < values.length; i++) { acc += alpha * (values[i] - acc); fwd[i] = acc; }
  const out = new Array<number>(values.length);
  acc = fwd[fwd.length - 1];
  for (let i = fwd.length - 1; i >= 0; i--) { acc += alpha * (fwd[i] - acc); out[i] = acc; }
  return out;
}

/* 단조 3차 보간 (Fritsch-Carlson, PCHIP).
 *
 * 일반 3차 스플라인은 급한 변화 뒤에 오버슈트한다. 카메라 경로에서는
 * 대상을 지나쳤다가 되돌아오는 것처럼 보여서 오히려 더 흔들린다.
 * 단조 보간은 구간 안에서 값이 튀지 않는다. */
export function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  if (n < 2) return new Array(n).fill(0);
  const h: number[] = []; const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(Math.max(1e-9, xs[i + 1] - xs[i]));
    delta.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array<number>(n).fill(0);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) { m[i] = 0; continue; }   // 극점에서는 평평하게
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
  }
  return m;
}

export function pchipAt(xs: number[], ys: number[], m: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0; let hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const h = xs[hi] - xs[lo];
  const t = (x - xs[lo]) / h;
  const t2 = t * t; const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[lo]
       + (t3 - 2 * t2 + t) * h * m[lo]
       + (-2 * t3 + 3 * t2) * ys[hi]
       + (t3 - t2) * h * m[hi];
}

export interface RefineResult {
  points: TrackingPoint[];
  /** 앞뒤를 이어 채운 프레임 수. 화면에 알려주기 위해 남긴다. */
  bridgedFrames: number;
  /** 이상치로 보고 고친 프레임 수. */
  repairedFrames: number;
}

/** 궤적을 다듬는다. 원본 배열은 건드리지 않는다. */
export function refineTrajectory(points: TrackingPoint[], options: RefineOptions = {}): RefineResult {
  const o = { ...DEFAULTS, ...options };
  if (points.length < 3) return { points: points.slice(), bridgedFrames: 0, repairedFrames: 0 };

  const sorted = points.slice().sort((a, b) => a.timestamp - b.timestamp);
  const t = sorted.map((p) => p.timestamp);

  /* 믿을 수 있는 프레임을 고른다.
   * 가려졌거나 놓친 구간의 박스는 예측값이라 실제 위치가 아니다.
   * 그런 점을 그대로 평활에 넣으면 잘못된 위치로 카메라를 끌고 간다. */
  const trusted = sorted.map((p) =>
    p.state !== 'TARGET_LOST' && p.state !== 'REACQUIRING'
    && p.tracking_health >= o.minHealth);

  const cx = sorted.map((p) => p.bbox.x + p.bbox.width / 2);
  const cy = sorted.map((p) => p.bbox.y + p.bbox.height / 2);
  const bw = sorted.map((p) => p.bbox.width);
  const bh = sorted.map((p) => p.bbox.height);

  // --- 1. 이상치 제거 -------------------------------------------------
  const before = [cx.slice(), cy.slice()];
  const cxH = hampel(cx, o.hampelWindow, o.hampelSigma);
  const cyH = hampel(cy, o.hampelWindow, o.hampelSigma);
  let repairedFrames = 0;
  for (let i = 0; i < cx.length; i++) {
    if (Math.abs(before[0][i] - cxH[i]) > 1e-6 || Math.abs(before[1][i] - cyH[i]) > 1e-6) repairedFrames++;
  }

  // --- 2. 믿을 수 있는 점만으로 보간해 공백을 메운다 ------------------
  const anchorIdx: number[] = [];
  for (let i = 0; i < sorted.length; i++) if (trusted[i]) anchorIdx.push(i);

  let bridgedFrames = 0;
  const series = [cxH, cyH, bw, bh];
  if (anchorIdx.length >= 2) {
    const ax = anchorIdx.map((i) => t[i]);
    for (const values of series) {
      const ay = anchorIdx.map((i) => values[i]);
      const slopes = pchipSlopes(ax, ay);
      for (let i = 0; i < values.length; i++) {
        if (trusted[i]) continue;
        /* 공백이 너무 길면 잇지 않는다.
         * 오래 가려졌다가 나타난 사람이 같은 사람이라는 보장이 없다.
         * 그런 구간까지 매끄럽게 이으면 "틀린 위치를 자신 있게" 보여준다. */
        const prev = anchorIdx.filter((k) => k < i).pop();
        const next = anchorIdx.find((k) => k > i);
        if (prev === undefined || next === undefined) continue;   // 양 끝은 그대로 둔다
        if (next - prev > o.maxBridgeFrames) continue;
        values[i] = pchipAt(ax, ay, slopes, t[i]);
      }
    }
    for (let i = 0; i < sorted.length; i++) {
      if (trusted[i]) continue;
      const prev = anchorIdx.filter((k) => k < i).pop();
      const next = anchorIdx.find((k) => k > i);
      if (prev !== undefined && next !== undefined && next - prev <= o.maxBridgeFrames) bridgedFrames++;
    }
  }

  // --- 3. 지연 없는 평활 ---------------------------------------------
  const cxS = zeroPhaseSmooth(cxH, o.positionAlpha);
  const cyS = zeroPhaseSmooth(cyH, o.positionAlpha);
  // 박스 크기는 위치보다 더 떨린다. 더 세게 평활한다.
  const bwS = zeroPhaseSmooth(bw, o.sizeAlpha);
  const bhS = zeroPhaseSmooth(bh, o.sizeAlpha);

  const out: TrackingPoint[] = sorted.map((p, i) => ({
    ...p,
    bbox: {
      x: clamp01(cxS[i] - bwS[i] / 2),
      y: clamp01(cyS[i] - bhS[i] / 2),
      width: clamp01(bwS[i]),
      height: clamp01(bhS[i]),
    },
  }));

  return { points: out, bridgedFrames, repairedFrames };
}

/* 카메라가 멈춰 있어야 할 구간을 찾는다.
 *
 * 사람은 계속 미세하게 움직인다. 그걸 그대로 따라가면 화면이 끊임없이
 * 미끄러진다 — 보는 사람은 그걸 "흔들린다" 고 느낀다.
 *
 * 실제 촬영에서 카메라는 **고정하거나 확실히 패닝하거나** 둘 중 하나다.
 * 그 사이의 어정쩡한 미세 이동이 가장 보기 나쁘다.
 * (Grundmann et al. 2011 의 L1 최적 경로가 같은 관찰에서 출발한다.
 *  거기서는 선형계획법으로 구간을 나누지만, 여기서는 히스테리시스로
 *  가볍게 근사한다 — 모바일에서 매 프레임 돌려야 하기 때문이다.)
 *
 * 반환값은 각 프레임의 "고정 여부" 다. */
export function holdSegments(
  points: TrackingPoint[],
  { enter, exit, minHoldFrames = 6 }: {
    enter?: number; exit?: number; minHoldFrames?: number } = {},
): boolean[] {
  const n = points.length;
  const hold = new Array<boolean>(n).fill(false);
  if (n < 3) return hold;

  const cx = points.map((p) => p.bbox.x + p.bbox.width / 2);
  const cy = points.map((p) => p.bbox.y + p.bbox.height / 2);

  /* 문턱을 고정 상수로 두면 영상마다 틀린다.
   *
   * 처음에는 0.012 / 0.028 을 썼는데, 실제 농구 영상의 프레임당 평균
   * 이동이 0.0047 이었다. 모든 구간이 문턱 아래라 전부 "고정" 으로
   * 판정됐다 — 카메라가 아예 움직이지 않는다. 흔들리는 것보다 나쁘다.
   *
   * 그래서 그 영상의 **중앙값 속도에 비례**해 잡는다. 느린 영상에서는
   * 문턱도 낮아지고, 빠른 영상에서는 높아진다. */
  const speeds: number[] = [];
  for (let i = 1; i < n; i++) speeds.push(Math.hypot(cx[i] - cx[i - 1], cy[i] - cy[i - 1]));
  const med = median(speeds);

  /* 상대 기준만 쓰면 등속 이동에서 무너진다.
   * 대상이 일정한 속도로 화면을 가로지르면 중앙값이 곧 그 속도라
   * 어떤 프레임도 "중앙값의 1.25배" 를 넘지 못하고 전부 고정으로 판정된다.
   * 그러면 대상이 화면 밖으로 나가는데 카메라는 가만히 있는다.
   *
   * 그래서 절대 기준과 함께 본다. 둘 중 하나만 넘어도 패닝이다.
   *   0.010/프레임 이면 15fps 기준 초당 화면의 15% 다 — 분명한 이동이다. */
  const enterT = enter ?? Math.min(0.004, Math.max(0.0015, med * 0.5));
  const exitT = exit ?? Math.min(0.010, Math.max(0.004, med * 1.25));

  let holding = true;
  let runStart = 0;
  for (let i = 1; i < n; i++) {
    const speed = Math.hypot(cx[i] - cx[i - 1], cy[i] - cy[i - 1]);
    /* 들어가는 문턱과 나오는 문턱을 다르게 둔다 (히스테리시스).
     * 같으면 문턱 근처에서 고정/패닝이 매 프레임 번갈아 바뀐다 —
     * 그게 바로 지금 보이는 떨림이다. */
    if (holding && speed > exitT) { holding = false; runStart = i; }
    else if (!holding && speed < enterT) { holding = true; runStart = i; }
    hold[i] = holding;
  }
  hold[0] = hold[1] ?? true;

  // 너무 짧은 고정 구간은 오히려 튄다. 최소 길이를 못 채우면 패닝으로 본다.
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && hold[j] === hold[i]) j++;
    if (hold[i] && j - i < minHoldFrames) for (let k = i; k < j; k++) hold[k] = false;
    i = j;
  }
  void runStart;
  return hold;
}
