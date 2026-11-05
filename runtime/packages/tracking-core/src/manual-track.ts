/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·56c68c03 @license @preserve */
import type { NormalizedBBox, TrackingPoint } from '@hilit/shared-types';
import { pchipAt, pchipSlopes } from './trajectory';

/* 수동 추적 — 놓친 구간을 사람이 직접 짚는다.
 *
 * ## 왜 필요한가
 *
 * 자동 추적은 언젠가 틀린다. 같은 유니폼을 입은 팀에서, 사람이 3초
 * 넘게 가려질 때, 대상이 화면의 1% 로 찍혔을 때 — 우리 실측이 전부
 * 그 경우들이다. 그때 사용자가 할 수 있는 일이 "다시 짚고 처음부터
 * 다시 돌리기" 뿐이면, 어려운 영상은 몇 번을 돌려도 안 된다.
 *
 * 그리고 사용자는 답을 알고 있다. **어느 게 자기인지 아는 사람은
 * 본인뿐이다.** 그 지식을 받을 창구가 있어야 한다.
 *
 * ## CapCut 이 하는 방식
 *
 * 캡컷의 모션 트래킹은 이렇게 돈다.
 *
 *   1. 네모를 대상에 올리고 [트래킹] 을 누른다 — 자동으로 따라간다
 *   2. 흐트러지면 그 시점에서 **키프레임**을 찍고 네모를 옮긴다
 *   3. 키프레임 사이는 앱이 알아서 이어 준다
 *
 * 전부 다시 돌리지 않는다. 틀린 구간만 사람이 두세 점 찍어 고친다.
 * 우리 4단계(구간 확인)와 결이 같다 — 사용자는 이미 "여기가 틀렸다"
 * 를 알고 있는 상태에서 이 화면에 온다.
 * https://www.capcut.com/resource/motion-camera-tracking
 *
 * ## 우리가 다르게 하는 것
 *
 * **두 점만 찍어도 쓸 수 있어야 한다.** 캡컷은 편집 도구라 사용자가
 * 열 개를 찍을 각오를 하고 들어오지만, 우리 사용자는 경기 끝나고
 * 휴대폰으로 30초 안에 끝내려는 사람이다. 그래서
 *
 *   키프레임 1개   그 시각의 어긋남만 고치고 앞뒤로 서서히 녹인다
 *   키프레임 2개+  그 사이를 단조 곡선으로 잇는다
 *
 * 그리고 키프레임 구간 밖으로 **튀지 않게** 이어 붙인다. 손으로 고친
 * 구간이 끝나는 순간 자동 궤적으로 홱 돌아가면 카메라가 한 프레임에
 * 점프하고, 그게 손으로 고치기 전보다 더 나빠 보인다.
 *
 * ## 왜 단조 보간인가
 *
 * 일반 3차 스플라인은 급한 변화 뒤에 오버슈트한다. 사람이 두 점을
 * 찍었을 때 그 사이를 지나쳤다 되돌아오는 궤적이 나오면, 사용자는
 * 자기가 찍은 대로 안 됐다고 느낀다. 단조 보간(Fritsch-Carlson)은
 * 찍은 값 사이에서 값이 튀지 않는다 — 궤적 다듬기(trajectory.ts)가
 * 같은 이유로 쓰는 방식이고, 같은 함수를 가져다 쓴다.
 */

export interface ManualKeyframe {
  /** 원본 영상의 시각(초). */
  timestamp: number;
  bbox: NormalizedBBox;
}

export interface ManualTrackOptions {
  /**
   * 손으로 고친 구간 앞뒤로 자동 궤적에 다시 얹히는 시간(초).
   *
   * 0 으로 두면 경계에서 카메라가 튄다. 0.5초면 30fps 에서 15프레임에
   * 걸쳐 녹아 들어가고, 사람 눈에는 경계가 보이지 않는다.
   */
  blend?: number;
  /** 이 시각 이후만 고친다. 구간 확인 화면에서 그 구간만 넘길 때 쓴다. */
  from?: number;
  /** 이 시각까지만 고친다. */
  to?: number;
}

export interface ManualTrackResult {
  points: TrackingPoint[];
  /** 손으로 고친 궤적 점의 수. */
  correctedFrames: number;
  /** 실제로 손이 닿은 구간. 화면에 표시한다. */
  span: { start: number; end: number } | null;
}

function clampBox(box: NormalizedBBox): NormalizedBBox {
  const width = Math.max(0.01, Math.min(1, box.width));
  const height = Math.max(0.01, Math.min(1, box.height));
  return {
    width, height,
    x: Math.max(0, Math.min(1 - width, box.x)),
    y: Math.max(0, Math.min(1 - height, box.y)),
  };
}

/** 상자를 중심·크기로. 보간은 중심으로 해야 크기가 바뀔 때 안 밀린다. */
function toCentre(box: NormalizedBBox) {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, w: box.width, h: box.height };
}

function toBox(c: { cx: number; cy: number; w: number; h: number }): NormalizedBBox {
  return clampBox({ x: c.cx - c.w / 2, y: c.cy - c.h / 2, width: c.w, height: c.h });
}

/**
 * 키프레임들로 궤적을 고쳐 쓴다.
 *
 * 원본 배열은 건드리지 않는다 — 사용자가 "되돌리기" 를 누를 수 있어야
 * 하고, 그러려면 자동 궤적이 그대로 남아 있어야 한다.
 */
export function applyManualKeyframes(
  points: readonly TrackingPoint[],
  keyframes: readonly ManualKeyframe[],
  options: ManualTrackOptions = {},
): ManualTrackResult {
  const keys = keyframes
    .filter((k) => Number.isFinite(k.timestamp))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!points.length || !keys.length) {
    return { points: points.slice(), correctedFrames: 0, span: null };
  }

  const blend = Math.max(0, options.blend ?? 0.5);
  const from = options.from ?? -Infinity;
  const to = options.to ?? Infinity;
  const first = keys[0].timestamp;
  const last = keys[keys.length - 1].timestamp;

  /* 키프레임이 하나뿐이면 "그 순간의 어긋남" 만 안다.
   *
   * 그 시각에서 자동 궤적과 사용자가 찍은 자리의 차이를 구하고, 그
   * 차이를 앞뒤로 서서히 녹인다. 두 점 이상이면 그 사이를 직접 잇는다. */
  const single = keys.length === 1;

  const xs = keys.map((k) => k.timestamp);
  const centres = keys.map((k) => toCentre(clampBox(k.bbox)));
  const series = {
    cx: centres.map((c) => c.cx), cy: centres.map((c) => c.cy),
    w: centres.map((c) => c.w), h: centres.map((c) => c.h),
  };
  const slopes = single ? null : {
    cx: pchipSlopes(xs, series.cx), cy: pchipSlopes(xs, series.cy),
    w: pchipSlopes(xs, series.w), h: pchipSlopes(xs, series.h),
  };

  /* 하나뿐일 때 쓸 어긋남. 자동 궤적에서 그 시각의 자리를 뽑아 뺀다. */
  const autoAt = (t: number) => {
    let closest = points[0];
    let delta = Infinity;
    for (const p of points) {
      const d = Math.abs(p.timestamp - t);
      if (d < delta) { closest = p; delta = d; }
    }
    return toCentre(closest.bbox);
  };
  const offset = single ? (() => {
    const a = autoAt(first);
    const target = centres[0];
    return { cx: target.cx - a.cx, cy: target.cy - a.cy, w: target.w / Math.max(1e-4, a.w),
             h: target.h / Math.max(1e-4, a.h) };
  })() : null;

  /* 녹이는 시간을 **고친 양에 맞춘다.**
   *
   * 2% 를 다듬은 것과 화면 절반을 옮긴 것을 같은 시간에 녹이면, 큰
   * 수정에서는 그 시간 안에 카메라가 빠르게 미끄러진다. 사람이 크게
   * 고쳤을수록 더 길게 녹여야 자연스럽다.
   *
   * 상한은 3배다. 그 이상 늘리면 틀린 자리를 오래 붙잡고 있게 되고,
   * 그건 고치기 전과 다를 바 없다. */
  const boundaryShift = (() => {
    const startAuto = autoAt(first);
    const endAuto = autoAt(last);
    const startWant = centres[0];
    const endWant = centres[centres.length - 1];
    return Math.max(
      Math.hypot(startWant.cx - startAuto.cx, startWant.cy - startAuto.cy),
      Math.hypot(endWant.cx - endAuto.cx, endWant.cy - endAuto.cy),
    );
  })();
  const melt = blend * (1 + Math.min(2, boundaryShift / 0.12));

  let corrected = 0;
  let spanStart = Infinity;
  let spanEnd = -Infinity;

  const out = points.map((point) => {
    const t = point.timestamp;
    if (t < from || t > to) return point;

    /* 얼마나 손을 댈 것인가 (0~1).
     *
     *   키프레임 구간 안        1   전부 사람 뜻대로
     *   구간 밖 blend 안        서서히 0 으로
     *   그 밖                   0   자동 궤적 그대로
     *
     * 🔴 이 녹임이 없으면 경계에서 카메라가 한 프레임에 점프한다. 손으로
     *    고쳤는데 결과가 더 나빠 보이는 가장 흔한 이유다. */
    let weight: number;
    if (t >= first && t <= last) weight = 1;
    else if (t < first) weight = melt > 0 ? Math.max(0, 1 - (first - t) / melt) : 0;
    else weight = melt > 0 ? Math.max(0, 1 - (t - last) / melt) : 0;
    if (weight <= 1e-6) return point;

    /* 부드럽게 녹인다. 선형으로 섞으면 경계에서 속도가 꺾여 그 자체가
     * 눈에 띈다. smoothstep 은 양 끝의 기울기가 0 이다. */
    const k = weight * weight * (3 - 2 * weight);

    const auto = toCentre(point.bbox);
    let wanted: { cx: number; cy: number; w: number; h: number };
    if (single && offset) {
      wanted = {
        cx: auto.cx + offset.cx, cy: auto.cy + offset.cy,
        w: auto.w * offset.w, h: auto.h * offset.h,
      };
    } else if (slopes) {
      wanted = {
        cx: pchipAt(xs, series.cx, slopes.cx, t),
        cy: pchipAt(xs, series.cy, slopes.cy, t),
        w: pchipAt(xs, series.w, slopes.w, t),
        h: pchipAt(xs, series.h, slopes.h, t),
      };
    } else {
      return point;
    }

    const blended = {
      cx: auto.cx + (wanted.cx - auto.cx) * k,
      cy: auto.cy + (wanted.cy - auto.cy) * k,
      w: auto.w + (wanted.w - auto.w) * k,
      h: auto.h + (wanted.h - auto.h) * k,
    };

    corrected += 1;
    spanStart = Math.min(spanStart, t);
    spanEnd = Math.max(spanEnd, t);

    const inside = t >= first && t <= last;
    return {
      ...point,
      bbox: toBox(blended),
      /* 사람이 짚은 구간은 확실하다. 그 사실을 숫자에도 적어야
       * findTrackingGaps 가 여기를 다시 "확인이 필요한 구간" 으로
       * 잡아내지 않는다 — 이미 사람이 확인한 자리다. */
      confidence: inside ? 1 : Math.max(point.confidence, k),
      tracking_health: inside ? 1 : Math.max(point.tracking_health, k),
      state: inside ? 'TRACKING_OK' : point.state,
      /* 어디를 사람이 고쳤는지 남긴다. 화면이 이걸로 표시하고,
       * 다음 자동 추적이 이 구간을 덮어쓰지 않는다. */
      manual: inside ? true : point.manual,
    } satisfies TrackingPoint;
  });

  /* 사용자가 찍은 시각에 궤적 점이 없으면 넣어 준다.
   *
   * 분석은 12~20fps 라 점 사이가 50~80ms 벌어진다. 사용자가 그 사이를
   * 찍었으면 그 자리는 어디에도 반영되지 않는다 — 정확히 찍은 사람이
   * "안 먹혔다" 고 느끼는 자리다. */
  for (const key of keys) {
    if (key.timestamp < from || key.timestamp > to) continue;
    const near = out.find((p) => Math.abs(p.timestamp - key.timestamp) < 1e-3);
    if (near) continue;
    const template = out.find((p) => p.timestamp >= key.timestamp) ?? out[out.length - 1];
    out.push({
      ...template,
      timestamp: key.timestamp,
      bbox: clampBox(key.bbox),
      confidence: 1, tracking_health: 1, state: 'TRACKING_OK', manual: true,
    });
    corrected += 1;
    spanStart = Math.min(spanStart, key.timestamp);
    spanEnd = Math.max(spanEnd, key.timestamp);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);

  return {
    points: out,
    correctedFrames: corrected,
    span: corrected > 0 ? { start: spanStart, end: spanEnd } : null,
  };
}

/**
 * 다음 키프레임을 어디에 찍으면 좋은가.
 *
 * 사용자에게 "여기를 봐 주세요" 를 하나 제시한다. 아무 안내가 없으면
 * 사용자는 구간 처음부터 끝까지 훑어야 하고, 그건 30초 안에 끝내려는
 * 사람에게 너무 긴 일이다.
 *
 * 고르는 기준은 **자동 궤적이 가장 못 믿는 자리**다. 신뢰도와 건강도가
 * 가장 낮은 점이 그 구간에서 가장 틀렸을 가능성이 크다. 이미 사람이
 * 고친 자리(manual)는 건너뛴다.
 */
export function suggestKeyframeAt(
  points: readonly TrackingPoint[], span?: { start: number; end: number },
): number | null {
  let worst: TrackingPoint | null = null;
  let score = Infinity;
  for (const p of points) {
    if (span && (p.timestamp < span.start || p.timestamp > span.end)) continue;
    if (p.manual) continue;
    const value = Math.min(p.confidence, p.tracking_health);
    if (value < score) { score = value; worst = p; }
  }
  return worst ? worst.timestamp : null;
}
