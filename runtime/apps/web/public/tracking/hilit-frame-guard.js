/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·2f9624ea @license @preserve */
/* HILIT Frame Guard — 추적기가 화면 밖으로 달아나지 못하게. 가중치가 없다.
 *
 * 🔴 정본은 `packages/hilit-vision/src/frame-guard.ts` 다. 거기에 검사가
 *    붙어 있다(18개). 이 파일은 추적 엔진이 쓰는 **런타임 사본**이다 —
 *    엔진은 번들 밖의 ESM 이라 패키지를 import 할 수 없다.
 *    한쪽을 고치면 반드시 다른 쪽도 고친다(검사가 두 사본을 대조한다).
 *
 * ## 왜 생겼나 — 사용자 영상에서 잡은 것
 *
 * 아이스링크 영상(1920×1080 · 40초 · 스케이터 약 20명), 분석 1280×720.
 *
 *     t=17.67  cx 0.937  conf 0.993  TRACKING_OK
 *     t=18.08  cx 1.560  conf 0.792   <- 다섯 걸음 만에 화면 밖으로
 *     t=20.33  cx 1.548  conf 1.000   <- 빈 공간을 "신뢰도 1.0" 으로
 *     t=40.38  cx 2.447              <- 마지막 22초를 허공에서 보냈다
 *
 * 사용자에게는 "제자리에서 턴을 도는데 화면이 갑자기 옆으로 돌아가
 * 다른 사람을 쫓아간다" 로 보인다. 카메라가 그 상자를 따라 오른쪽 끝
 * 까지 밀려나기 때문이다.
 *
 * 원인은 셋이 연쇄한 것이다.
 *   1. 화면 경계를 지키는 코드가 런타임에 없었다
 *   2. 화면 밖에서 나온 신뢰도(가장자리 화소끼리의 상관값)를 믿었다
 *   3. 한 걸음에 허용한 이동이 몸 너비의 3배였다 — 옆 사람 간격이다
 */

export const MIN_VISIBLE = 0.35;
export const MAX_SPEED_BODIES = 6;
export const STATIONARY_BODIES = 0.6;
export const JITTER_BODIES = 0.25;

/** 상자가 화면 안에 얼마나 들어와 있나 (0~1). */
export function visibleRatio(box, frame) {
  const area = Math.max(1e-6, box.width * box.height);
  const iw = Math.min(box.x + box.width, frame.width) - Math.max(box.x, 0);
  const ih = Math.min(box.y + box.height, frame.height) - Math.max(box.y, 0);
  if (iw <= 0 || ih <= 0) return 0;
  return Math.max(0, Math.min(1, (iw * ih) / area));
}

/** 중심이 화면 밖이면 달아난 것이다. 가장자리에 걸친 것은 정상이다. */
export function hasEscaped(box, frame) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx < 0 || cx > frame.width || cy < 0 || cy > frame.height;
}

/** 중심만 화면 안으로 되돌린다. 상자 크기는 바꾸지 않는다. */
export function clampToFrame(box, frame) {
  const cx = Math.max(0, Math.min(frame.width, box.x + box.width / 2));
  const cy = Math.max(0, Math.min(frame.height, box.y + box.height / 2));
  return { x: cx - box.width / 2, y: cy - box.height / 2,
           width: box.width, height: box.height };
}

/** 최근 중심들로 "제자리에 있는가" 를 본다. */
export function isStationary(centres, bodyWidth) {
  if (centres.length < 3) return false;
  const body = Math.max(1, bodyWidth);
  const last = centres[centres.length - 1];
  let spread = 0;
  for (const c of centres) {
    spread = Math.max(spread, Math.hypot(c.x - last.x, c.y - last.y));
  }
  return spread / body <= STATIONARY_BODIES;
}

/** 한 걸음에 허용할 최대 이동(화소). */
export function maxStep({ dt, bodyWidth, stationary = false,
                          appearanceDiscriminative = true }) {
  const body = Math.max(1, bodyWidth);
  const step = Math.max(1e-3, dt);
  let bodies = JITTER_BODIES + MAX_SPEED_BODIES * step;
  if (stationary) bodies = JITTER_BODIES + STATIONARY_BODIES * 0.3;
  if (appearanceDiscriminative === false) bodies *= 0.6;
  return Math.max(body * JITTER_BODIES, body * bodies);
}

/** 이 걸음이 사람이 할 수 있는 일인가. */
export function judgeStep(from, to, frame, options) {
  const body = Math.max(1, options.bodyWidth);
  const moved = Math.hypot(
    (to.x + to.width / 2) - (from.x + from.width / 2),
    (to.y + to.height / 2) - (from.y + from.height / 2));
  const limit = maxStep(options);
  const bodies = moved / body;
  if (hasEscaped(to, frame)) {
    return { ok: false, bodies, limit: limit / body, reason: 'escaped' };
  }
  if (moved > limit) {
    return { ok: false, bodies, limit: limit / body, reason: 'teleport' };
  }
  return { ok: true, bodies, limit: limit / body, reason: 'ok' };
}

/** 화면 밖에 있는 만큼 신뢰도를 깎는다. */
export function discountByVisibility(confidence, box, frame) {
  const visible = visibleRatio(box, frame);
  return visible >= 0.95 ? confidence : confidence * visible;
}

/** 이동을 허용치까지만 인정한다 — 방향은 남기고 거리만 줄인다.
 *
 * 거절만 쓰면 진짜로 빠른 대상을 영영 못 따라가고 제자리에 얼어붙는다.
 * 줄이면 맞는 경우에는 몇 프레임 뒤에 따라잡고, 틀린 경우에는 그 방향
 * 으로 끌려가지 않는다. 맞을 때 조금 느린 것과 틀릴 때 갈아타는 것
 * 중에서는 언제나 전자다. */
export function limitStep(from, to, options) {
  const fx = from.x + from.width / 2, fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2, ty = to.y + to.height / 2;
  const moved = Math.hypot(tx - fx, ty - fy);
  const limit = maxStep(options);
  if (moved <= limit || moved < 1e-6) return to;
  const k = limit / moved;
  const cx = fx + (tx - fx) * k, cy = fy + (ty - fy) * k;
  return { x: cx - to.width / 2, y: cy - to.height / 2,
           width: to.width, height: to.height };
}

/** 크기도 순간이동하지 않는다 — 1초에 바뀔 수 있는 배율.
 *
 * 🔴 실측에서 상자가 대상 너비의 3.2배로 부풀었다. 크기가 부풀면
 *    이 파일의 모든 규칙이 함께 헐거워진다 — 전부 "몸 너비의 몇 배" 로
 *    재기 때문이다. 즉 상자가 스스로 안전장치를 풀어 버린다. */
export const MAX_SCALE_PER_SECOND = 1.6;

export function limitScale(from, to, dt, maxPerSecond = MAX_SCALE_PER_SECOND) {
  const step = Math.max(1e-3, dt);
  const limit = Math.pow(Math.max(1.01, maxPerSecond), step);
  const fw = Math.max(1e-3, from.width), fh = Math.max(1e-3, from.height);
  const ratio = Math.max(to.width / fw, to.height / fh,
                         fw / Math.max(1e-3, to.width),
                         fh / Math.max(1e-3, to.height));
  if (ratio <= limit) return to;
  /* 배율을 곱셈으로 자른다. 덧셈으로 섞으면 상한을 못 지킨다 —
   * 3.2배 요구를 1.04배 상한으로 섞으면 1.7배가 나온다. */
  const clampRatio = (r) => Math.min(limit, Math.max(1 / limit, r));
  const width = fw * clampRatio(to.width / fw);
  const height = fh * clampRatio(to.height / fh);
  const cx = to.x + to.width / 2, cy = to.y + to.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/* 기준 크기에서 벗어날 수 있는 폭.
 *
 * 🔴 속도 상한만으로는 못 막는 사고가 있었다. 상자는 한 번에 튀지 않고
 *    3초에 걸쳐 조금씩 0.034 -> 0.087 로 자랐다 — 프레임마다 보면 전부
 *    합법인데 3초 뒤에는 대상의 2.8배다. 큰 상자는 옆 사람을 품고,
 *    품은 무늬는 옆 사람과도 잘 맞는다. 그렇게 주인이 바뀐다. */
export const SIZE_BAND_LOW = 0.6;
export const SIZE_BAND_HIGH = 1.7;

export function limitToSizeBand(box, reference, low = SIZE_BAND_LOW, high = SIZE_BAND_HIGH) {
  const rw = Math.max(1e-3, reference.width);
  const rh = Math.max(1e-3, reference.height);
  const width = Math.min(rw * high, Math.max(rw * low, box.width));
  const height = Math.min(rh * high, Math.max(rh * low, box.height));
  if (width === box.width && height === box.height) return box;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}
