/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·6345aec9 @license @preserve */
/* 추적을 재는 자.
 *
 * ## 왜 표준 지표만으로는 부족한가
 *
 * MOTA·HOTA·IDF1 은 **여러 사람을 동시에 따라가는** 문제를 재려고 만든
 * 값이다. 우리 제품은 다르다 — 한 사람을 지목하고 그 사람만 끝까지
 * 따라간다. 다른 아홉 명을 얼마나 잘 따라갔는지는 우리에게 0점짜리
 * 정보다.
 *
 * 그래서 여기서는 **사용자가 실제로 겪는 실패**를 센다.
 *
 *   놓친 시간      화면이 나를 안 비춘 시간. 사용자가 "끊긴다" 고 하는 것
 *   바뀜           엉뚱한 사람을 따라간 횟수. 가장 나쁜 실패다
 *   되찾기         놓친 뒤 다시 찾았는가, 몇 초 만에 찾았는가
 *   흔들림         상자가 떨리는 정도. 정답과 무관하게 결과물의 품질이다
 *   컷 넘김        3분할에서 사람이 바뀌지 않았는가
 *
 * ## 흔들림은 정답이 없어도 잰다
 *
 * 중심과 넓이의 **2차 차분**을 본다. 등속으로 움직이는 상자는 2차
 * 차분이 0이고, 떨리는 상자는 커진다. 정답 궤적이 없어도 계산되므로
 * 사용자 영상에서도 바로 잴 수 있다 — 정답을 만드는 데는 사람 손이
 * 들지만 이건 안 든다.
 */

import type { GroundTruth, GtBox, GtFrame } from './ground-truth';

/** 추적기가 낸 한 시점의 답. */
export interface PredictedPoint {
  timestamp: number;
  bbox?: GtBox;
  /**
   * 이 시점에 추적기가 "같은 사람" 이라고 본 묶음의 id.
   *
   * 내부 분절을 진단한다. 실제 사람 전환은 별도로 주석한 방해 인물
   * 박스와 비교해야 한다. 내부 ID가 같다고 같은 사람은 아니다.
   */
  trackId?: string;
  /** False for predictions/interpolation that have not been identity-verified. */
  verified?: boolean;
  /** A cut, an absence, or an explicit lost observation must not be bridged. */
  discontinuity?: boolean;
}

/** 맞았다고 볼 겹침 정도. 0.5 는 MOT 관행이다. */
export const MATCH_IOU = 0.5;

/** 두 사각형이 얼마나 겹치는가(0~1). */
export function iou(a?: GtBox, b?: GtBox): number {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const over = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (over <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - over;
  return union > 0 ? over / union : 0;
}

export interface TrackingScore {
  /** 정답이 보이는 프레임 중 제대로 맞힌 비율(0~1). */
  targetAccuracy: number;
  /** 정답이 보이는데 못 맞힌 시간(초). */
  lostSeconds: number;
  /** 그 비율. 영상 길이가 다른 것끼리 비교하려면 이쪽이 필요하다. */
  lostRatio: number;
  /** Human-labelled distractor switches. Null without identity annotations. */
  idSwitches: number | null;
  /** Internal ID changes while matching the target; not a person switch. */
  trackFragmentations: number;
  identityEvaluated: number;
  wrongPersonSeconds: number | null;
  /** Incorrect localization that the caller explicitly marked verified. */
  silentFailureSeconds: number;
  /** 놓쳤다가 다시 찾은 비율(0~1). 놓친 적이 없으면 1이다. */
  reacquisitionRate: number;
  /** 되찾기까지 걸린 평균 시간(초). 못 찾은 것은 평균에서 뺀다. */
  reacquisitionLatency: number;
  /** 놓친 구간의 수. */
  lostSpans: number;
  /** 평가에 쓰인 프레임 수 — 표본이 몇 개인지 없이 비율만 보면 안 된다. */
  evaluated: number;
}

/**
 * 정답과 결과를 맞춰 본다.
 *
 * 시각으로 맞춘다. 프레임 번호가 아니다 — 가변 fps 영상과 프록시
 * 프레임에서는 번호가 서로 다른 것을 가리킨다.
 */
export function scoreTracking(
  gt: GroundTruth,
  predicted: readonly PredictedPoint[],
  matchIou = MATCH_IOU,
): TrackingScore {
  const sorted = [...predicted].sort((a, b) => a.timestamp - b.timestamp);
  const intervals = sorted.slice(1).map((p, i) => p.timestamp - sorted[i].timestamp)
    .filter((v) => v > 1e-6).sort((a, b) => a - b);
  const cadence = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0;
  const maxGap = Math.min(0.25, cadence * 1.6);
  const boundaries = (gt.events ?? []).filter((e) =>
    ['cutBoundary', 'screenExit', 'screenReentry'].includes(e.kind)).map((e) => e.timestamp);
  const nearest = (t: number): PredictedPoint | undefined => {
    if (!sorted.length) return undefined;
    const half = gt.fps > 0 ? 0.5 / gt.fps : 0.02;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].timestamp < t) lo = mid + 1; else hi = mid; }
    const a = sorted[lo - 1], b = sorted[lo];
    if (b && Math.abs(b.timestamp - t) < 1e-6) return b;
    if (a && b && a.bbox && b.bbox && !a.discontinuity && !b.discontinuity
        && a.verified !== false && b.verified !== false && a.trackId === b.trackId
        && b.timestamp - a.timestamp <= maxGap + 1e-6
        && !boundaries.some((cut) => cut > a.timestamp && cut <= b.timestamp)) {
      const k = (t - a.timestamp) / (b.timestamp - a.timestamp);
      const mix = (x: number, y: number) => x + (y - x) * k;
      return { ...a, timestamp: t, verified: a.verified === true && b.verified === true, bbox: {
        x: mix(a.bbox.x, b.bbox.x), y: mix(a.bbox.y, b.bbox.y),
        w: mix(a.bbox.w, b.bbox.w), h: mix(a.bbox.h, b.bbox.h),
      } };
    }
    const best = !a ? b : !b ? a : t - a.timestamp < b.timestamp - t ? a : b;
    // A final sample represents at most one normal sampling interval. Never
    // extend it across an explicit absence/cut or a large missing interval.
    const tolerance = !b && a && !a.discontinuity
      && !boundaries.some((cut) => cut > a.timestamp && cut <= t)
      ? Math.max(half, Math.min(0.1, cadence)) : Math.max(half, 0.02);
    return best && Math.abs(best.timestamp - t) <= tolerance + 1e-6 ? best : undefined;
  };

  /* 대상이 보이는 프레임만 채점한다. 안 보이는 동안 못 찾는 것은
   * 실패가 아니다 — 찾을 것이 없기 때문이다. */
  const target = gt.frames.filter((f): f is GtFrame & { bbox: GtBox } =>
    f.target && f.visible && Boolean(f.bbox));

  let hits = 0;
  let switches = 0;
  let fragmentations = 0, identityEvaluated = 0, wrongFrames = 0, silentFrames = 0;
  let previousWrong: string | null = null;
  let lastGoodTrack: string | undefined;
  const spans: { from: number; to?: number }[] = [];
  let inLoss = false;

  for (let i = 0; i < target.length; i += 1) {
    const frame = target[i];
    const pred = nearest(frame.timestamp);
    const good = iou(frame.bbox, pred?.bbox) >= matchIou;
    if (!good && pred?.verified === true) silentFrames += 1;

    if (good) {
      hits += 1;
      /* 맞히고 있는데 묶음 id 가 바뀌었다 = 다른 사람으로 갈아탔다가
       * 우연히 다시 맞은 것이거나, 추적기가 내부에서 끊긴 것이다.
       * 둘 다 사용자에게는 "화면이 튀었다" 로 보인다. */
      if (pred?.trackId && lastGoodTrack && pred.trackId !== lastGoodTrack) fragmentations += 1;
      if (pred?.trackId) lastGoodTrack = pred.trackId;
      if (inLoss) { spans[spans.length - 1].to = frame.timestamp; inLoss = false; }
    } else {
      if (!inLoss) { spans.push({ from: frame.timestamp }); inLoss = true; }
    }
  }

  // A wrong person is still wrong while the selected person is off-screen.
  // Localization scoring excludes absence; identity scoring must not.
  for (const frame of gt.frames) {
    if (!frame.target || frame.distractors === undefined) { previousWrong = null; continue; }
    identityEvaluated += 1;
    const pred = nearest(frame.timestamp);
    const overlaps = frame.distractors.map(d => ({ id: d.personId, overlap: iou(d.bbox, pred?.bbox) }))
      .sort((a, b) => b.overlap - a.overlap);
    const targetOverlap = frame.visible ? iou(frame.bbox, pred?.bbox) : 0;
    const wrong = overlaps[0]?.overlap >= matchIou && overlaps[0].overlap > targetOverlap + .05
      ? overlaps[0].id : null;
    if (wrong) { wrongFrames++; if (wrong !== previousWrong) switches++; }
    previousWrong = wrong;
  }

  /* 놓친 시간. 프레임 간격을 곱해 초로 바꾼다. */
  const step = gt.fps > 0 ? 1 / gt.fps : 0;
  const missed = target.length - hits;
  const lostSeconds = missed * step;

  const recovered = spans.filter((s) => s.to !== undefined);
  const latency = recovered.length
    ? recovered.reduce((sum, s) => sum + ((s.to as number) - s.from), 0) / recovered.length
    : 0;

  return {
    targetAccuracy: target.length ? hits / target.length : 0,
    lostSeconds,
    lostRatio: gt.duration > 0 ? lostSeconds / gt.duration : 0,
    idSwitches: identityEvaluated ? switches : null,
    trackFragmentations: fragmentations,
    identityEvaluated,
    wrongPersonSeconds: identityEvaluated ? wrongFrames * step : null,
    silentFailureSeconds: silentFrames * step,
    reacquisitionRate: spans.length ? recovered.length / spans.length : 1,
    reacquisitionLatency: latency,
    lostSpans: spans.length,
    evaluated: target.length,
  };
}

export interface StabilityScore {
  /** 중심이 떨리는 정도. 화면 폭 대비 값이라 해상도와 무관하다. */
  centerJitter: number;
  /** 넓이가 출렁이는 정도. 확대·축소가 덜컹거리면 커진다. */
  areaJitter: number;
  /** 상자 크기가 서서히 어긋나는 정도. 처음과 끝의 넓이 비다. */
  scaleDrift: number;
}

/**
 * 결과물이 얼마나 안정적인가 — 정답이 없어도 잰다.
 *
 * 2차 차분을 쓴다. 사람을 따라 **등속으로 움직이는** 상자는 2차 차분이
 * 0에 가깝고, 매 프레임 흔들리는 상자는 커진다. 1차 차분(속도)을 쓰면
 * 빨리 뛰는 사람을 잘 따라간 결과가 나쁘게 나온다 — 그건 흔들림이
 * 아니라 움직임이다.
 */
export function scoreStability(points: readonly PredictedPoint[]): StabilityScore {
  const boxes = points
    .filter((p): p is PredictedPoint & { bbox: GtBox } => Boolean(p.bbox))
    .map((p) => p.bbox);
  if (boxes.length < 3) return { centerJitter: 0, areaJitter: 0, scaleDrift: 0 };

  const cx = boxes.map((b) => b.x + b.w / 2);
  const cy = boxes.map((b) => b.y + b.h / 2);
  const area = boxes.map((b) => b.w * b.h);

  let center = 0;
  let areaJit = 0;
  for (let i = 2; i < boxes.length; i += 1) {
    const dx = cx[i] - 2 * cx[i - 1] + cx[i - 2];
    const dy = cy[i] - 2 * cy[i - 1] + cy[i - 2];
    center += Math.hypot(dx, dy);
    const base = Math.max(area[i - 1], 1e-6);
    areaJit += Math.abs(area[i] - 2 * area[i - 1] + area[i - 2]) / base;
  }
  const n = boxes.length - 2;

  const first = Math.max(area[0], 1e-6);
  const last = Math.max(area[area.length - 1], 1e-6);

  return {
    centerJitter: center / n,
    areaJitter: areaJit / n,
    /* 1 이면 안 변한 것이다. 2 면 두 배로 커졌다는 뜻 — 사람이 다가온
     * 것일 수도 있으므로 이 값 하나로 실패를 판정하지 않는다. */
    scaleDrift: last / first,
  };
}

/**
 * 컷을 넘어가며 같은 사람을 유지했는가(0~1).
 *
 * 3분할이 이 제품의 핵심 산출물인데, 컷마다 추적을 새로 시작하면 두
 * 번째 컷의 주인공이 다른 사람일 수 있다. 사용자는 완성된 영상을 보고
 * 나서야 그것을 안다 — 그래서 따로 잰다.
 *
 * 경계 **앞뒤**의 묶음 id 가 같으면 이어진 것으로 본다.
 */
export function cutIdentityContinuity(
  gt: GroundTruth,
  predicted: readonly PredictedPoint[],
  window = 0.5,
): number {
  const cuts = (gt.events ?? []).filter((e) => e.kind === 'cutBoundary');
  if (!cuts.length) return 1;

  const idAt = (from: number, to: number): string | undefined => {
    const inRange = predicted
      .filter((p) => p.timestamp >= from && p.timestamp <= to && p.trackId);
    return inRange.length ? inRange[Math.floor(inRange.length / 2)].trackId : undefined;
  };

  let kept = 0;
  for (const cut of cuts) {
    const before = idAt(cut.timestamp - window, cut.timestamp);
    const after = idAt(cut.timestamp, cut.timestamp + window);
    /* 한쪽이라도 없으면 이어졌다고 볼 수 없다. 모르는 것을 성공으로
     * 세면 이 지표는 언제나 좋아 보인다. */
    if (before && after && before === after) kept += 1;
  }
  return kept / cuts.length;
}
