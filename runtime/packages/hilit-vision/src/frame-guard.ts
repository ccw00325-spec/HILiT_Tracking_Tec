/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·9f13b782 @license @preserve */
/* HILIT Frame Guard — 추적기가 화면 밖으로 달아나지 못하게.
 *
 * ## 이 파일이 생긴 이유 — 실제 영상에서 잡은 것
 *
 * 사용자가 준 아이스링크 영상(1920×1080, 40초, 스케이터 약 20명)에서
 * 실측한 궤적이다. 분석 해상도는 1280×720.
 *
 *     t=17.67  cx 0.937  conf 0.993  TRACKING_OK
 *     t=17.75  cx 1.061  conf 0.990  TRACKING_OK   <- 화면 오른쪽 밖으로 나갔다
 *     t=17.83  cx 1.186  conf 0.970  TRACKING_OK
 *     t=17.92  cx 1.310  conf 0.947  TRACKING_OK
 *     t=18.00  cx 1.435  conf 0.981  TRACKING_OK
 *     t=18.08  cx 1.560  conf 0.792  USER_CONFIRMATION
 *     ...
 *     t=20.33  cx 1.548  conf 1.000  TRACKING_OK   <- 22초 동안 빈 공간을
 *     t=40.38  cx 2.447  conf ~1.0                     "신뢰도 1.0" 으로 추적
 *
 * **40초 영상의 마지막 22초를 화면 밖 허공을 따라가며 보냈고, 그동안
 * 신뢰도는 1.000 이었다.** 사용자에게는 "갑자기 화면이 옆으로 돌아가
 * 다른 사람을 쫓아간다" 로 보인다 — 카메라가 그 상자를 따라 오른쪽
 * 끝까지 밀려나 거기 있는 사람이 화면에 담기기 때문이다.
 *
 * ## 왜 아무도 못 막았나 — 결함 셋이 연쇄했다
 *
 * **1. 화면 경계를 지키는 코드가 런타임에 없었다.**
 * `motion.ts` 의 `clampBox` 가 정확히 이 폭주를 막으려고 쓰인 함수이고
 * 그 주석에 "화면 밖 4.4배까지 달아났다" 고 적혀 있다. 그런데 그건
 * 패키지 쪽이고, 실제로 도는 파이프라인은 자기 칼만 필터를 따로 갖고
 * 있었다. 사본이 둘이면 한쪽만 고쳐진다.
 *
 * **2. 화면 밖에서 나온 신뢰도를 믿었다.**
 * 상자가 밖으로 나가면 잘라낸 조각이 전부 가장자리 화소라 서로 비슷해
 * 진다. 비슷하니 상관값이 높고, 추적기는 "잘 찾고 있다" 고 말한다.
 * 신호가 없어진 것이지 좋아진 것이 아닌데 숫자는 반대로 나온다.
 *
 * **3. 한 걸음에 허용한 이동이 몸 너비의 3배였다.**
 * 게이트 상한이 `3.0 × 박스 너비` 였다. 이 영상에서 스케이터들은 서로
 * 2~4 몸 너비 간격으로 서 있다 — 즉 **한 걸음마다 옆 사람으로 건너뛸
 * 수 있는 거리**다. 게다가 다들 파란 헬멧에 검은 옷이라 외형으로도
 * 못 가린다. 실측에서 한 걸음에 160px(2.24 몸)씩 다섯 번 건너뛰어
 * 화면 밖으로 나갔다.
 *
 * ## 여기서 정하는 규칙
 *
 * 사람은 물리 법칙을 따른다. 그 사실을 코드에 적는다.
 *
 *   - 몸의 절반 이상이 화면 밖이면 그건 관측이 아니다
 *   - 한 걸음에 갈 수 있는 거리는 **자기 몸 크기 × 시간**으로 정해진다
 *   - 제자리에 있던 사람은 다음 걸음에도 대체로 제자리에 있다
 *
 * 이 규칙들은 외형·검출·재식별이 전부 실패해도 살아 있다. 그래서
 * 마지막 방어선으로 쓸 수 있다.
 */

export interface GuardBox {
  /** 왼쪽 위 x (화소). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * 상자가 화면 안에 얼마나 들어와 있나 (0~1).
 *
 * 1 이면 전부 안에, 0 이면 전부 밖에 있다. 화면 가장자리에 반쯤 걸친
 * 사람은 0.5 다 — 그건 정상이고 흔하다.
 */
export function visibleRatio(box: GuardBox, frame: FrameSize): number {
  const area = Math.max(1e-6, box.width * box.height);
  const iw = Math.min(box.x + box.width, frame.width) - Math.max(box.x, 0);
  const ih = Math.min(box.y + box.height, frame.height) - Math.max(box.y, 0);
  if (iw <= 0 || ih <= 0) return 0;
  return Math.max(0, Math.min(1, (iw * ih) / area));
}

/**
 * 이 아래로 보이면 "관측이 아니다" 로 본다.
 *
 * 0.35 는 몸의 3분의 1 남짓이다. 화면 가장자리에서 반쯤 잘린 사람은
 * 실제로 자주 있으므로 그보다 낮게 잡아야 하고, 그렇다고 0.1 까지
 * 내리면 손끝만 걸친 상태를 관측으로 인정하게 된다.
 */
export const MIN_VISIBLE = 0.35;

/**
 * 상자를 화면 안으로 되돌린다.
 *
 * 🔴 상자 전체를 화면 안에 밀어 넣지 않는다. **중심**만 화면 안에
 *    붙잡는다 — 몸 절반이 화면 밖으로 나간 모습은 실제로 흔하고,
 *    그걸 억지로 안으로 밀면 상자가 사람을 벗어난다.
 *
 * 막으려는 것은 "가장자리에 걸친 사람" 이 아니라 **중심이 화면 밖 멀리
 * 달아나는 것**이다.
 */
export function clampToFrame(box: GuardBox, frame: FrameSize): GuardBox {
  const cx = Math.max(0, Math.min(frame.width, box.x + box.width / 2));
  const cy = Math.max(0, Math.min(frame.height, box.y + box.height / 2));
  return {
    x: cx - box.width / 2,
    y: cy - box.height / 2,
    width: box.width,
    height: box.height,
  };
}

/** 상자가 화면 밖으로 달아났는가 — 중심이 화면 밖이면 그렇다. */
export function hasEscaped(box: GuardBox, frame: FrameSize): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx < 0 || cx > frame.width || cy < 0 || cy > frame.height;
}

/**
 * 사람이 1초에 갈 수 있는 최대 거리 — 자기 **몸 너비**의 몇 배인가.
 *
 * `motion.ts` 의 `MAX_SPEED_BODIES` 와 같은 값이고 같은 이유다. 화면
 * 비율로 상한을 두면 멀리 있는 작은 사람에게는 너무 헐겁고 가까운
 * 사람에게는 너무 빡빡하다.
 *
 * 6배면 전력 질주다. 스케이트는 그보다 빠를 수 있지만, 그때는 카메라도
 * 같이 움직이고 우리는 카메라 보정을 따로 한다.
 */
export const MAX_SPEED_BODIES = 6;

/**
 * 제자리에 있다고 볼 이동량 — 몸 너비 배수.
 *
 * 이 영상의 대상은 **제자리에서 턴**을 돈다. 그때 중심은 거의 안
 * 움직이는데 외형은 크게 바뀐다(앞→옆→뒤). 그 상태를 알아보는 것이
 * 중요하다 — 외형이 흔들려도 **위치는 확실하다**는 뜻이기 때문이다.
 */
export const STATIONARY_BODIES = 0.6;

/**
 * 최근 관측으로 "제자리에 있는가" 를 판단한다.
 *
 * @param centres 최근 중심들(오래된 것 → 최신). 화소 좌표.
 * @param bodyWidth 대상의 몸 너비(화소).
 */
export function isStationary(
  centres: ReadonlyArray<{ x: number; y: number }>, bodyWidth: number,
): boolean {
  if (centres.length < 3) return false;
  const body = Math.max(1, bodyWidth);
  let maxSpread = 0;
  const last = centres[centres.length - 1];
  for (const c of centres) {
    maxSpread = Math.max(maxSpread, Math.hypot(c.x - last.x, c.y - last.y));
  }
  return maxSpread / body <= STATIONARY_BODIES;
}

export interface StepLimitOptions {
  /** 한 걸음의 시간(초). */
  dt: number;
  /** 대상의 몸 너비(화소). */
  bodyWidth: number;
  /** 제자리에 있다고 판단됐는가. */
  stationary?: boolean;
  /**
   * 외형으로 사람을 가를 수 있는가.
   *
   * 못 가르는 장면(같은 유니폼 · 같은 헬멧)에서는 위치가 유일한 단서다.
   * 그때 이동 허용치를 키우면 옆 사람으로 건너뛰는 문을 여는 것이다.
   */
  appearanceDiscriminative?: boolean;
}

/**
 * 한 걸음에 허용할 최대 이동 거리(화소).
 *
 * 🔴 실측에서 여기가 뚫려 있었다. 게이트 상한이 `3.0 × 몸 너비` 였고,
 *    그 영상의 스케이터 간격이 2~4 몸 너비였다. 즉 한 걸음마다 옆
 *    사람으로 건너뛸 수 있었고, 실제로 다섯 번 건너뛰어 화면을 벗어났다.
 */
export function maxStep(options: StepLimitOptions): number {
  const body = Math.max(1, options.bodyWidth);
  const dt = Math.max(1e-3, options.dt);

  /* 검출 상자 자체가 떨리는 양.
   *
   * 사람이 가만히 있어도 검출 상자는 프레임마다 조금씩 흔들린다. 그
   * 떨림까지 "이동" 으로 세면 정상 추적이 막힌다. 그래서 속도와 무관한
   * 여유를 따로 둔다 — 속도 상한에 섞으면 고fps 에서 허용치가 0 에
   * 가까워지고, 저fps 에서는 필요 이상으로 커진다. */
  let bodies = JITTER_BODIES + MAX_SPEED_BODIES * dt;

  /* 제자리에 있던 사람은 다음 걸음에도 제자리다.
   * 턴 · 점프처럼 자리를 지키는 동작이 여기 들어온다. */
  if (options.stationary) bodies = JITTER_BODIES + STATIONARY_BODIES * 0.3;

  /* 외형으로 못 가리는 장면에서는 더 좁힌다 — 위치가 유일한 단서인데
   * 그 단서를 헐겁게 쓰면 아무 단서도 없는 것과 같다. */
  if (options.appearanceDiscriminative === false) bodies *= 0.6;

  return Math.max(body * JITTER_BODIES, body * bodies);
}

/**
 * 검출 상자가 제자리에서도 흔들리는 양 — 몸 너비 배수.
 *
 * 이 값이 없으면 고fps 에서 허용치가 0 에 수렴해 정상 추적이 막힌다.
 * 있으면 저fps 에서 조금 헐거워지는데, 그쪽이 안전한 방향이다 —
 * 막아서 못 찾는 것은 사용자가 알아채지만, 정상 프레임을 거절해
 * 추적이 아예 안 붙는 것은 "기능이 없는 것" 으로 보인다.
 */
export const JITTER_BODIES = 0.25;

export interface StepVerdict {
  ok: boolean;
  /** 실제 이동 — 몸 너비 배수. 기록과 진단에 쓴다. */
  bodies: number;
  /** 허용치 — 몸 너비 배수. */
  limit: number;
  reason: 'ok' | 'teleport' | 'escaped';
}

/**
 * 이 걸음이 사람이 할 수 있는 일인가.
 *
 * 거절은 "못 찾았다" 로 이어진다. 그게 맞다 — 못 찾은 것은 사용자가
 * 알아채고 다시 짚을 수 있지만, 옆 사람으로 갈아탄 것은 완성된 영상을
 * 보고 나서야 안다. 둘 중 하나를 골라야 하면 언제나 전자다.
 */
export function judgeStep(
  from: GuardBox, to: GuardBox, frame: FrameSize, options: StepLimitOptions,
): StepVerdict {
  const body = Math.max(1, options.bodyWidth);
  const moved = Math.hypot(
    (to.x + to.width / 2) - (from.x + from.width / 2),
    (to.y + to.height / 2) - (from.y + from.height / 2),
  );
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

/**
 * 이동을 허용치까지만 인정한다 — 방향은 남기고 거리만 줄인다.
 *
 * ## 왜 거절이 아니라 줄이기인가
 *
 * 거절(이전 자리 유지)만 쓰면 진짜로 빠르게 움직이는 대상을 영영 못
 * 따라간다. 매 프레임 "너무 멀다" 로 거절되어 제자리에 얼어붙는다.
 *
 * 줄이기는 다르다. 한 걸음에 갈 수 있는 만큼만 따라가고, 대상이 정말
 * 그쪽에 있으면 다음 걸음에서 또 따라간다 — 몇 프레임이면 따라잡는다.
 * 반대로 옆 사람으로 건너뛴 것이면, 그 방향으로 계속 끌려가지 않고
 * 다음 관측에서 제자리로 돌아온다.
 *
 * 즉 **맞는 경우에는 조금 느릴 뿐이고, 틀린 경우에는 막는다.** 추적에서
 * 이런 비대칭이 있는 선택은 거의 언제나 옳다.
 */
export function limitStep(
  from: GuardBox, to: GuardBox, options: StepLimitOptions,
): GuardBox {
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const moved = Math.hypot(tx - fx, ty - fy);
  const limit = maxStep(options);
  if (moved <= limit || moved < 1e-6) return to;

  const k = limit / moved;
  const cx = fx + (tx - fx) * k;
  const cy = fy + (ty - fy) * k;
  return {
    x: cx - to.width / 2,
    y: cy - to.height / 2,
    width: to.width,
    height: to.height,
  };
}

/**
 * 크기도 순간이동하지 않는다 — 1초에 바뀔 수 있는 배율.
 *
 * ## 왜 필요한가 — 실측에서 상자가 3배로 부풀었다
 *
 * 아이스링크 영상에서 대상의 너비는 화면의 0.031 인데, 20초쯤 지나
 * 추적 상자가 0.099 가 됐다. **3.2배**다.
 *
 * 크기가 부푸는 것은 그 자체로도 문제지만, 진짜 피해는 **다른 모든
 * 방어선이 함께 헐거워진다**는 데 있다. 이 파일의 규칙은 전부 "몸
 * 너비의 몇 배" 로 재기 때문이다.
 *
 *     한 걸음 상한   몸 너비 × 0.75  ->  3배 커진 몸 너비 × 0.75
 *     제자리 판정    몸 너비 × 0.6   ->  3배 넓은 범위가 "제자리"
 *     재획득 반경    몸 너비 기준    ->  3배 먼 곳까지 후보
 *
 * 즉 상자가 부풀면 **스스로 안전장치를 풀어 버린다.** 실제로 그 뒤에
 * 한 걸음에 0.051(화면 비율)씩 끌려가 다시 화면 끝까지 갔다.
 *
 * ## 1.6배/초인 근거
 *
 * 사람이 카메라 쪽으로 걸어오면 화면에서 커진다. 초당 1.6배면 2초에
 * 2.5배이고, 그건 성큼성큼 다가오는 속도다. 그보다 빠른 변화는 사람이
 * 움직여서가 아니라 **상자가 다른 것을 물었기** 때문이다.
 */
export const MAX_SCALE_PER_SECOND = 1.6;

/**
 * 크기 변화를 허용치까지만 인정한다. 중심은 유지한다.
 *
 * 위치와 같은 이유로 거절이 아니라 줄이기다 — 진짜로 다가오는 사람은
 * 몇 프레임이면 따라잡고, 상자가 남을 문 경우에는 그쪽으로 자라지
 * 않는다.
 */
export function limitScale(
  from: GuardBox, to: GuardBox, dt: number,
  maxPerSecond = MAX_SCALE_PER_SECOND,
): GuardBox {
  const step = Math.max(1e-3, dt);
  const limit = Math.pow(Math.max(1.01, maxPerSecond), step);
  const fw = Math.max(1e-3, from.width);
  const fh = Math.max(1e-3, from.height);
  const ratio = Math.max(to.width / fw, to.height / fh,
                         fw / Math.max(1e-3, to.width),
                         fh / Math.max(1e-3, to.height));
  if (ratio <= limit) return to;

  /* 배율을 곱셈으로 자른다.
   *
   * 🔴 처음에는 "요구한 크기까지 k 만큼만 다가간다" 는 식으로 섞었는데,
   *    그건 상한을 지키지 못한다. 3.2배 요구를 1.04배 상한으로 섞으면
   *    1.7배가 나온다 — 덧셈으로 섞고 곱셈으로 재기 때문이다.
   *    그래서 배율 자체를 [1/상한, 상한] 안으로 자른다.
   *
   * 폭과 높이를 따로 자르므로 한 프레임에서는 비율이 상한만큼(12fps 에서
   * 4%) 어긋날 수 있지만, 몇 프레임이면 요구한 모양에 닿는다. 억지로
   * 예전 비율을 유지하면 오히려 목표 모양에 영원히 못 닿는다. */
  const clampRatio = (r: number) => Math.min(limit, Math.max(1 / limit, r));
  const width = fw * clampRatio(to.width / fw);
  const height = fh * clampRatio(to.height / Math.max(1e-3, fh));
  const cx = to.x + to.width / 2;
  const cy = to.y + to.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/* 기준 크기에서 벗어날 수 있는 폭. 아래 limitToSizeBand 설명 참조.
 *
 * 이 값은 재서 정했다. 더 조이면(0.65~1.45) 오히려 나빠진다 — 같은
 * 영상에서 정확도가 97.7% 에서 31.5% 로 떨어졌다. 상자를 억지로 줄이면
 * 몸 너비가 작아지고, 몸 너비로 재는 걸음 상한까지 함께 조여져서
 * 정상적인 따라가기가 막히기 때문이다. 방어선끼리도 서로 묶여 있다. */
export const SIZE_BAND_LOW = 0.6;
export const SIZE_BAND_HIGH = 1.7;

/**
 * 기준 크기에서 너무 멀어진 상자를 띠 안으로 되돌린다. 중심은 유지한다.
 *
 * 🔴 속도 상한(limitScale)만으로는 못 막는 사고가 있다. 실측에서 상자는
 *    한 번에 튀지 않고 **3초에 걸쳐 조금씩** 0.034 에서 0.087 로 자랐다.
 *    프레임마다 보면 전부 합법이다(1.04배 미만). 그런데 3초 뒤에는 대상의
 *    2.8배가 되어 있고, 그 큰 상자는 옆 사람까지 품는다. 품으면 무늬가
 *    섞이고, 섞인 무늬는 옆 사람과도 잘 맞는다 — 그렇게 주인이 바뀐다.
 *
 * 그래서 **절대 기준**을 하나 둔다. 사용자가 직접 고른 상자의 크기다.
 * 그보다 크게 벗어날 수 없게 하되, 기준 자체는 확인된 프레임에서만
 * 아주 천천히 따라가게 한다(파이프라인 쪽). 사람이 카메라 쪽으로
 * 다가오는 진짜 변화는 몇 초에 걸쳐 일어나므로 기준이 따라잡는다.
 * 몇 프레임 만에 부푸는 가짜 변화는 따라잡지 못하고 잘린다.
 */
export function limitToSizeBand(
  box: GuardBox, reference: { width: number; height: number },
  low = SIZE_BAND_LOW, high = SIZE_BAND_HIGH,
): GuardBox {
  const rw = Math.max(1e-3, reference.width);
  const rh = Math.max(1e-3, reference.height);
  const width = Math.min(rw * high, Math.max(rw * low, box.width));
  const height = Math.min(rh * high, Math.max(rh * low, box.height));
  if (width === box.width && height === box.height) return box;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/**
 * 화면 밖에 있는 만큼 신뢰도를 깎는다.
 *
 * 🔴 실측에서 상자가 화면 밖으로 나간 뒤에도 신뢰도가 1.000 이었다.
 *    잘라낸 조각이 전부 가장자리 화소라 서로 비슷해지고, 비슷하면
 *    상관값이 높기 때문이다. **신호가 사라진 것을 신호가 좋아진 것으로
 *    읽는다** — 추적에서 가장 위험한 종류의 거짓말이다.
 *
 * 그래서 보이는 비율을 곱한다. 절반만 보이면 신뢰도도 절반이다.
 */
export function discountByVisibility(
  confidence: number, box: GuardBox, frame: FrameSize,
): number {
  const visible = visibleRatio(box, frame);
  if (visible >= 0.95) return confidence;
  return confidence * visible;
}
