/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·fc40e94f @license @preserve */
/* HILIT Tiling — 작게 찍힌 사람을 검출기가 볼 수 있게 만든다.
 *
 * 가중치가 없다. 검출기를 **어디에 대고 몇 번 부를지**만 정하는 계획
 * 코드다. 그래서 어떤 검출기를 쓰든 그대로 얹힌다.
 *
 * ## 왜 필요한가 — 우리 실패의 대부분이 여기서 났다
 *
 * 실측 두 건이 같은 곳을 가리킨다.
 *
 *   실제 농구 영상   사람 높이 69~85px / 프레임 높이 334px = 21~25%
 *                    모바일 재획득 0/17. 검출은 되는데 골라내지 못함
 *   피겨 영상        대상이 화면의 1%. 상자 안 대부분이 빙판
 *                    외형 분리도 -0.131 (동전 던지기)
 *
 * 원인이 하나다. 검출기는 프레임 전체를 **416×416 으로 찌그러뜨려**
 * 넣는다. 1920×1080 영상에서 높이 5% 인 사람은 54px 이고, 416 으로
 * 줄이면 **20px** 이 된다. 20px 짜리 사람에게서 뽑을 수 있는 특징이
 * 없다. 검출기 성능 문제가 아니라 입력 해상도 문제다.
 *
 * ## 어떻게 — 잘라서 다시 본다 (SAHI, Akyon et al. 2022)
 *
 * 큰 그림을 겹치게 잘라 각 조각을 따로 검출기에 넣고, 나온 상자를
 * 원본 좌표로 되돌려 합친다. 조각이 작으니 그 안의 사람은 상대적으로
 * 커지고, 검출기가 볼 수 있는 크기가 된다.
 *
 *   전체 한 번   1920×1080 -> 416   사람 20px   못 본다
 *   조각 한 번    480×480  -> 416   사람 47px   본다
 *
 * 논문은 이 방식으로 FCOS·VFNet·TOOD 에서 AP 를 5~7%p 올렸다. 우리는
 * 그보다 단순한 문제를 푼다 — 찾아야 할 사람이 **한 명**이고 그 사람이
 * 어디쯤 있을지 예측도 갖고 있다.
 * https://arxiv.org/abs/2202.06934
 *
 * ## 그래서 격자로 다 훑지 않는다
 *
 * 조각 수만큼 추론이 늘어난다. 모바일에서 4배는 낼 수 없는 비용이다.
 *
 * 우리에게는 운동 모델의 예측이 있다. 대상이 있을 만한 곳 하나를
 * **집중 조각**으로 자르고, 나머지는 전체 프레임 한 번으로 덮는다.
 * 예측이 없을 때(완전히 놓쳐 처음부터 다시 찾을 때)만 격자로 넓힌다.
 *
 * ## 정사각으로 자르는 것 자체가 이득이다
 *
 * 검출기 입력이 정사각인데 16:9 프레임을 통째로 넣으면 가로가 1.78배
 * 눌린다. 서 있는 사람이 옆으로 납작해져 학습 때 본 모습과 달라진다.
 * 정사각 조각은 그 왜곡이 없다 — 조각으로 자르는 것만으로 같은 사람이
 * 더 사람처럼 보인다.
 */

export interface Rect { x: number; y: number; width: number; height: number }

export interface Slice {
  /** 원본 픽셀 좌표에서 잘라낼 영역. */
  region: Rect;
  /**
   * 이 조각이 무엇을 노리는가. 진단과 시험에 쓴다.
   *
   *   full    화면 전체. 언제나 하나 있다.
   *   focus   **이전에 본 자리** 둘레. 추적기가 알려 준 곳이다.
   *   accept  **예측이 가리킨 자리** 둘레. 추적 영역 예측기가 낸 곳이다.
   *   grid    남은 자리를 겹치게 훑는다.
   *
   * 🔴 focus 와 accept 를 가르는 이유 — 둘은 출처가 다르다. focus 는
   * 우리가 실제로 본 자리고, accept 는 우리가 **짐작한** 자리다. 나중에
   * "이 후보가 어디서 나왔나" 를 따질 때 그 둘을 섞으면 짐작을 관측으로
   * 읽게 된다.
   *
   * 🔴 이름이 accept 여도 **신원을 올리지 않는다.** accept 조각에서 나온
   * 후보라고 해서 대상으로 승격되지 않는다 — 예측은 거절만 한다
   * (prediction-identity-firewall.ts). 조각 이름은 어디를 봤는지일 뿐이다.
   */
  kind: 'full' | 'focus' | 'accept' | 'grid';
}

/**
 * 대상이 프레임 높이의 이 비율보다 작을 때만 조각을 낸다.
 *
 * ## 🔴 처음에 0.22 로 뒀다가 실측으로 고쳤다
 *
 * 0.22 는 "실제 농구 영상의 대상이 21~25% 였고 거기서 재획득이 0/17
 * 이었다" 에서 온 값이었다. 그런데 그렇게 두면 **바로 그 영상에서
 * 조각이 안 난다** — 0.23 은 0.22 보다 크기 때문이다. 고치려던 사례를
 * 문턱이 정확히 비켜 갔다.
 *
 * 측정해 보고 알았다(`scripts/diag-sliced-detect.mjs`). 검사만 봤다면
 * 통과했을 것이다 — 단위 검사는 "0.5 면 조각을 안 낸다" 를 지킬 뿐이고,
 * 0.23 이 어느 쪽인지는 실제 영상 숫자를 알아야 판단할 수 있다.
 *
 * ## 그래서 0.35 인 근거
 *
 * 검출기 입력은 416 정사각이므로 **입력에서의 사람 높이는 언제나
 * `비율 × 416`** 이다. 원본 해상도와 무관하다.
 *
 *   비율 0.05 -> 21px    0.23 -> 96px    0.35 -> 146px
 *
 * 그리고 실측에서 무너진 원인은 크기 하나가 아니었다 — 붐비는 장면에서
 * 평균 3.6명만 잡혔다(실제 5명). 조각을 내면 조각 하나에 들어가는
 * 사람이 줄고, 16:9 를 정사각에 밀어 넣을 때 생기는 가로 눌림도
 * 사라진다. 둘 다 겹침에 직접 도움이 된다.
 *
 * 0.35 를 넘으면 사람이 입력에서 146px 이상이고 화면에 서너 명이
 * 들어갈 자리도 없다. 그때 추론을 세 번 하는 것은 배터리만 쓰는 일이다.
 */
export const SLICE_BELOW_SHARE = 0.35;

/**
 * 조각 안에서 대상이 차지했으면 하는 높이 비율.
 *
 * 1/3 이 목표다. 너무 크게 잡으면(1/2 이상) 조각이 사람에 딱 붙어
 * 예측이 조금만 빗나가도 사람이 조각 밖으로 나간다. 너무 작게 잡으면
 * 애초에 조각을 낸 이유가 사라진다.
 */
const FOCUS_SUBJECT_SHARE = 0.34;

/** 조각을 이 화소보다 작게 자르지 않는다. 잘라도 얻는 것이 없다. */
const MIN_SLICE_PX = 160;

/**
 * 조각을 낼 가치가 있는가.
 *
 * @param subjectHeight 대상이 프레임 높이에서 차지하는 비율(0~1).
 *                      모르면 null — 모를 때는 낸다. 놓친 상태에서
 *                      물어보는 경우가 대부분이고, 그때가 가장 필요하다.
 */
export function shouldSlice(subjectHeight: number | null | undefined): boolean {
  if (subjectHeight === null || subjectHeight === undefined) return true;
  if (!Number.isFinite(subjectHeight) || subjectHeight <= 0) return true;
  return subjectHeight < SLICE_BELOW_SHARE;
}

function clampRegion(region: Rect, frameW: number, frameH: number): Rect {
  const width = Math.min(frameW, Math.max(MIN_SLICE_PX, Math.round(region.width)));
  const height = Math.min(frameH, Math.max(MIN_SLICE_PX, Math.round(region.height)));
  return {
    width, height,
    x: Math.round(Math.max(0, Math.min(frameW - width, region.x))),
    y: Math.round(Math.max(0, Math.min(frameH - height, region.y))),
  };
}

export interface PlanOptions {
  /** 대상이 있을 것 같은 자리(원본 픽셀). 있으면 그 둘레를 집중해서 본다. */
  focus?: Rect | null;
  /** 대상이 프레임 높이에서 차지하는 비율. 조각 크기를 여기서 정한다. */
  subjectHeight?: number | null;
  /**
   * 조각을 최대 몇 개까지 낼 것인가(전체 프레임 한 번은 여기 포함).
   *
   * 기본 3 은 비용에서 온 값이다. 모바일에서 NanoDet 한 번이 대략
   * 40~60ms 이고, 재획득은 자주 도는 경로가 아니다. 3배면 한 번의
   * 재획득이 0.2초 안쪽이다 — 사용자가 못 느낀다.
   */
  maxSlices?: number;
  /** 격자로 훑을 때 조각끼리 겹치는 비율. 경계에 걸친 사람을 놓치지 않게. */
  overlap?: number;
  /**
   * focus 가 **예측**에서 왔는가.
   *
   * true 면 그 조각을 'accept' 로 적는다. 값 자체는 진단용이고, 어느
   * 쪽이든 조각을 만드는 규칙은 같다 — 짐작을 관측으로 읽지 않게
   * 이름만 갈라 둔다.
   */
  focusFromPrediction?: boolean;
  /**
   * true 면 대상이 커도 집중 조각을 낸다.
   * 기본 shouldSlice 는 416 입력 기준으로 큰 사람을 건너뛴다.
   * 64×96 자체 검출기는 큰 사람도 가로로 눌리므로, 평가·보조 경로에서만 켠다.
   */
  force?: boolean;
}

/**
 * 검출기를 어디에 댈지 정한다.
 *
 * 첫 번째는 **언제나 전체 프레임**이다. 조각이 놓치는 것을 전체가
 * 잡고, 전체가 놓치는 것을 조각이 잡는다. 둘 중 하나만 쓰면 그 방식이
 * 약한 자리가 그대로 구멍이 된다.
 */
export function planSlices(
  frameW: number, frameH: number, options: PlanOptions = {},
): Slice[] {
  const full: Slice = { region: { x: 0, y: 0, width: frameW, height: frameH }, kind: 'full' };
  if (frameW < MIN_SLICE_PX || frameH < MIN_SLICE_PX) return [full];

  const max = Math.max(1, Math.floor(options.maxSlices ?? 3));
  if (max <= 1) return [full];
  if (!options.force && !shouldSlice(options.subjectHeight)) return [full];

  const slices: Slice[] = [full];

  /* 대상 크기로 조각 크기를 정한다.
   *
   * 사람 높이가 프레임의 6% 이고 조각 안에서 34% 이길 원하면 조각
   * 높이는 프레임의 6/34 = 18% 다. 크기를 모르면(놓친 직후) 프레임의
   * 절반으로 둔다 — 격자와 같은 크기다. */
  const share = options.subjectHeight;
  const sliceH = share && share > 1e-4
    ? Math.max(MIN_SLICE_PX, Math.round(frameH * Math.min(1, share / FOCUS_SUBJECT_SHARE)))
    : Math.round(frameH * 0.5);
  /* 정사각으로 자른다. 검출기 입력이 정사각이라 그래야 왜곡이 없다. */
  const side = Math.min(Math.min(frameW, frameH), Math.max(MIN_SLICE_PX, sliceH));

  const focus = options.focus;
  if (focus && focus.width > 0 && focus.height > 0) {
    const cx = focus.x + focus.width / 2;
    const cy = focus.y + focus.height / 2;
    slices.push({
      region: clampRegion(
        { x: cx - side / 2, y: cy - side / 2, width: side, height: side }, frameW, frameH,
      ),
      kind: options.focusFromPrediction === true ? 'accept' : 'focus',
    });
    if (slices.length >= max) return slices;
  }

  /* 예측이 없거나 자리가 남으면 격자로 넓힌다.
   *
   * 화면을 겹치게 훑는다. 겹치지 않으면 경계에 선 사람이 두 조각에서
   * 각각 반쪽만 잡혀 어느 쪽에서도 사람으로 안 보인다. */
  const overlap = Math.min(0.5, Math.max(0, options.overlap ?? 0.2));
  const step = side * (1 - overlap);
  const cols = Math.max(1, Math.ceil((frameW - side) / step) + 1);
  const rows = Math.max(1, Math.ceil((frameH - side) / step) + 1);

  const grid: Slice[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      grid.push({
        region: clampRegion(
          { x: c * step, y: r * step, width: side, height: side }, frameW, frameH,
        ),
        kind: 'grid',
      });
    }
  }

  /* 자리가 모자라면 **가운데부터** 담는다. 경기 영상에서 대상은 대개
   * 화면 가운데 근처에 있고, 구석 조각은 관중석일 때가 많다. */
  const fcx = focus ? focus.x + focus.width / 2 : frameW / 2;
  const fcy = focus ? focus.y + focus.height / 2 : frameH / 2;
  grid.sort((a, b) => {
    const da = Math.hypot(a.region.x + a.region.width / 2 - fcx,
                          a.region.y + a.region.height / 2 - fcy);
    const db = Math.hypot(b.region.x + b.region.width / 2 - fcx,
                          b.region.y + b.region.height / 2 - fcy);
    return da - db;
  });

  for (const slice of grid) {
    if (slices.length >= max) break;
    /* 이미 담은 조각과 거의 같은 자리면 건너뛴다 — 같은 추론을 두 번
     * 하는 셈이다. */
    const same = slices.some((s) => s.kind !== 'full'
      && Math.abs(s.region.x - slice.region.x) < side * 0.35
      && Math.abs(s.region.y - slice.region.y) < side * 0.35);
    if (!same) slices.push(slice);
  }

  return slices;
}

export interface Detection {
  box: Rect;
  score: number;
}

/**
 * 조각 좌표의 상자를 원본 좌표로 되돌린다.
 *
 * 조각은 원본에서 잘라낸 사각형이므로 되돌리기는 더하기뿐이다. 조각을
 * 검출기 입력 크기로 늘리는 과정에서 생긴 배율은 검출기 쪽에서 이미
 * 되돌아온 상태라고 본다 — 그쪽이 자기 입력 크기를 안다.
 */
export function toFrame(box: Rect, region: Rect): Rect {
  return {
    x: box.x + region.x,
    y: box.y + region.y,
    width: box.width,
    height: box.height,
  };
}

function overlapOf(a: Rect, b: Rect): { iou: number; contain: number } {
  const iw = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const ih = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (iw <= 0 || ih <= 0) return { iou: 0, contain: 0 };
  const inter = iw * ih;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  return {
    iou: inter / Math.max(1e-6, areaA + areaB - inter),
    contain: inter / Math.max(1e-6, Math.min(areaA, areaB)),
  };
}

/**
 * 조각마다 나온 검출을 하나로 합친다.
 *
 * ## 왜 IoU 만으로는 안 되는가 — 실측으로 드러났다
 *
 * 조각과 전체에서 같은 사람이 두 번 잡히는데, 두 상자의 크기가 다르다.
 * 조각 쪽이 사람을 더 정확히 감싸고 전체 쪽은 헐겁다. 그러면 IoU 가
 * 낮게 나와 **다른 사람으로 남는다.**
 *
 *   나란히 선 두 사람을 검출기가 다르게 분할한 실제 사례
 *     P1 x=233 w=59 h=85 / P3 x=245 w=42 h=63 (P1 안에 완전히 포함)
 *     IoU     2646/5015           = 0.528  <- 임계 0.55 를 통과해버린다
 *     포함률  2646/min(5015,2646) = 1.00   <- 이걸로 걸린다
 *
 * 그래서 포함률을 함께 본다. 작은 상자가 큰 상자에 대부분 들어가 있으면
 * 같은 사람이다.
 *
 * ## 어느 쪽을 남기는가
 *
 * **점수가 높은 쪽**이다. 조각에서 나온 검출은 대체로 점수가 높다 —
 * 그 안에서 사람이 크게 보였기 때문이고, 상자도 그만큼 정확하다.
 */
export function mergeDetections(
  detections: readonly Detection[],
  { iouThreshold = 0.55, containRatio = 0.80 } = {},
): Detection[] {
  const sorted = detections.slice().sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const d of sorted) {
    const dup = kept.some((k) => {
      const o = overlapOf(k.box, d.box);
      return o.iou >= iouThreshold || o.contain >= containRatio;
    });
    if (!dup) kept.push(d);
  }
  return kept;
}

/**
 * 조각 경계에 걸려 잘린 상자인가.
 *
 * 조각 가장자리에 딱 붙은 상자는 사람의 일부만 담고 있을 가능성이
 * 크다. 그런 상자를 그대로 후보로 쓰면 크기가 실제의 절반이라 크기
 * 신호가 거짓말을 한다.
 *
 * 전체 프레임 조각에서는 판단하지 않는다 — 화면 가장자리에 걸친 사람은
 * 실제로 흔하고, 그건 잘린 것이 아니라 원래 그렇게 찍힌 것이다.
 */
export function isClipped(box: Rect, slice: Slice, tolerance = 2): boolean {
  if (slice.kind === 'full') return false;
  const r = slice.region;
  return box.x <= r.x + tolerance
    || box.y <= r.y + tolerance
    || box.x + box.width >= r.x + r.width - tolerance
    || box.y + box.height >= r.y + r.height - tolerance;
}
