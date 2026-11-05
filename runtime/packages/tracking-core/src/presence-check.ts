/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·600ea963 @license @preserve */
import { type NormalizedBBox, type TrackingPoint } from '@hilit/shared-types';
import { type TrackingGap } from './gaps';

/* 추적이 끝난 뒤 "상자 아래에 정말 사람이 있나" 를 본다 — 2026-09-24.
 *
 * ## 왜 필요한가
 *
 * 실사 22편에서 제품 추적을 정답과 맞춰 보니, 대상이 보이는 순간의 47.9% 에서
 * 상자가 배경(수풀·유리벽)에 붙어 있는데 상태는 TRACKING_OK 였다
 * (docs/tracking-research/2026-09-24-tracking-reid-real-footage-audit.md).
 * 추적기 스스로의 점수로는 그 자리를 못 가린다. 그래서 확인 화면(3단계)이
 * 떠야 할 때 뜨지 않았다.
 *
 * ## 무엇으로 보나
 *
 * 추적과 따로 도는 사람 검출기(MediaPipe, 실사 F1 0.73)다. 0.5초마다 한 장씩,
 * 추적 상자와 IoU 0.2 이상 겹치는 사람 상자가 있는지만 본다. 연속 두 장(1초)
 * 없으면 그 구간을 "확인이 필요한 장면" 으로 올린다.
 *
 * 같은 22편에서 잰 값(model-reviewed 정답, 시험대 audit-20260924):
 *
 *   틀린 상자를 잡아냄      70/77 (91%)
 *   맞은 상자를 괜히 물음    IoU 0.5 이상 맞은 것 2/27 (7%) · 느슨하게 맞은 것 포함 11/42 (26%)
 *   클립당 묻는 구간        1.7개
 *
 * ## 이것이 말하지 않는 것
 *
 * - **동일인 판정이 아니다.** 상자 아래 "사람이 있다" 만 본다. 다른 사람에게
 *   옮겨 붙은 경우(실사 77건 중 2건)는 여기서 잡히지 않는다.
 * - 검출기가 놓치는 사람(재현율 약 72~82%)이 있어, 사람이 있는데도 묻는 일이
 *   생긴다. 그래서 한 장이 아니라 연속 두 장을 요구한다.
 */

export const PRESENCE_CHECK = {
  /** 몇 초마다 한 장을 볼지. */
  intervalSec: 0.5,
  /** 사람 상자로 칠 검출 점수 하한. 화면에 띄우는 문턱(0.3)보다 낮다 — 여기서는 놓치는 쪽이 더 비싸다. */
  scoreMin: 0.15,
  /** 추적 상자와 이만큼 겹쳐야 "그 자리에 사람이 있다" 로 본다. */
  iouMin: 0.2,
  /** 연속으로 몇 장 없어야 묻는가. */
  missRun: 2,
} as const;

export interface PresenceCheckOptions { intervalSec: number; scoreMin: number; iouMin: number; missRun: number }

export interface PresenceSample {
  /** 원본 시각(초). */
  time: number;
  /** 그 프레임의 사람 상자(정규화). 검출기를 못 쓴 프레임은 null. */
  people: Array<NormalizedBBox & { score: number }> | null;
}

/** start~end 를 intervalSec 간격으로 나눈 시각들. 끝은 넣지 않는다. */
export function presenceSampleTimes(start: number, end: number, interval: number = PRESENCE_CHECK.intervalSec): number[] {
  if (!(end > start) || !(interval > 0)) return [];
  const out: number[] = [];
  for (let t = start; t < end - 1e-6; t += interval) out.push(Number(t.toFixed(3)));
  return out;
}

function iou(a: NormalizedBBox, b: NormalizedBBox): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function nearestPoint(points: readonly TrackingPoint[], time: number): TrackingPoint | undefined {
  let best: TrackingPoint | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const d = Math.abs(p.timestamp - time);
    if (d < gap) { best = p; gap = d; }
  }
  return gap <= 0.3 ? best : undefined;
}

/**
 * 사람이 없는 구간을 확인 대상으로 돌려준다.
 *
 * - 검출기를 못 쓴 프레임(`people: null`)은 판정하지 않는다 — 모르는 것을 "없다" 로 치지 않는다.
 * - 사용자가 직접 짚은 점(`manual`)은 묻지 않는다. 사람이 준 답을 기계가 다시 의심하지 않는다.
 * - 추적이 이미 놓침으로 표시한 점은 findTrackingGaps 가 묻는다. 여기서 겹쳐 세지 않는다.
 */
export function presenceGaps(
  points: readonly TrackingPoint[],
  samples: readonly PresenceSample[],
  options: Partial<PresenceCheckOptions> = {},
): TrackingGap[] {
  const o: PresenceCheckOptions = { ...PRESENCE_CHECK, ...options };
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const miss = sorted.map((s) => {
    if (!s.people) return false;
    const p = nearestPoint(points, s.time);
    if (!p || p.manual === true) return false;
    if (p.editSpanResolved === true && p.state !== 'TRACKING_OK' && p.state !== 'TRACKING_WARNING') return false;
    if (p.engineAbsent === true) return false;
    if (p.state === 'TARGET_LOST' || p.state === 'REACQUIRING') return false;
    return !s.people.some((person) => person.score >= o.scoreMin && iou(p.bbox, person) >= o.iouMin);
  });
  const gaps: TrackingGap[] = [];
  for (let i = 0; i < miss.length;) {
    if (!miss[i]) { i += 1; continue; }
    let j = i;
    while (j < miss.length && miss[j]) j += 1;
    if (j - i >= o.missRun) {
      const start = sorted[i].time;
      const end = Math.min(sorted[j - 1].time + o.intervalSec, sorted[sorted.length - 1].time + o.intervalSec);
      gaps.push({
        id: `absent-${gaps.length + 1}`,
        start,
        end,
        /* 가운데 프레임을 대표로 보여 준다. 첫 프레임은 아직 사람이 있을 수 있다. */
        worstAt: sorted[i + Math.floor((j - i) / 2)].time,
        minConfidence: 0,
        minReid: 0,
        reason: 'absent',
        frames: j - i,
      });
    }
    i = j;
  }
  return gaps;
}

/** 두 갭 목록을 시간순으로 합친다. 겹치거나 mergeWithin 안으로 붙은 것은 하나로. */
export function mergeGaps(a: readonly TrackingGap[], b: readonly TrackingGap[], mergeWithin = 0.8): TrackingGap[] {
  const all = [...a, ...b].sort((x, y) => x.start - y.start);
  const out: TrackingGap[] = [];
  for (const gap of all) {
    const last = out[out.length - 1];
    if (last && gap.start - last.end <= mergeWithin) {
      last.end = Math.max(last.end, gap.end);
      last.frames += gap.frames;
      /* 추적기 스스로의 사유(가려짐·놓침)가 있으면 그 말을 쓴다 — 더 구체적이다. */
      if (last.reason === 'absent' && gap.reason !== 'absent') { last.reason = gap.reason; last.worstAt = gap.worstAt; }
    } else {
      out.push({ ...gap });
    }
  }
  return out.map((gap, index) => ({ ...gap, id: `gap-${index + 1}` }));
}

/**
 * 재추적을 **건너뛴** 구간의 카메라 처리(2026-09-28, 따라가기 개선).
 *
 * 🔴 예전에는 건너뛴 구간을 wideOverSpans 로 화면 전체 상자로 바꿨다. 그러면 카메라가 그 구간에서 사람을
 *    전혀 따라가지 않고 원본 전체(가로 원본을 세로로 만들 때는 가운데)를 보여 줬다. 그런데 확인 구간은
 *    놓침뿐 아니라 가림·낮은 신뢰도(0.45 미만)·낮은 외형 점수까지 묶어 잡는다 — 실험실 검수에서 신뢰도 0.42 의
 *    「주의」 상자 23곳 중 22곳이 사람이 본 정답과 맞았다. 건너뛰기 한 번에 맞게 따라가던 구간까지 멈췄다.
 *
 * 이제 건너뛴 구간은 점마다 다룬다.
 *   - 추적 상자가 있는 점(정상·주의·가림)은 그대로 따라간다.
 *   - 놓침·재획득 중인 점은 카메라가 원래 하듯 마지막으로 믿은 자리를 붙잡는다(FollowCamera.plan).
 *   - 외형 점수가 낮은 점(0 < reid < minReid — 다른 사람일 수 있음)은 cameraHold 를 붙여 붙잡게 한다.
 * 「트래킹 해제」(사용자가 이 장면은 따라가지 말라고 고른 것)는 여전히 wideOverSpans 다.
 */
export function skippedFraming(
  points: readonly TrackingPoint[],
  spans: ReadonlyArray<{ start: number; end: number }>,
  { minReid = 0.5 } = {},
): TrackingPoint[] {
  if (!spans.length) return points as TrackingPoint[];
  return points.map((p) => {
    const inside = spans.some((s) => p.timestamp >= s.start && p.timestamp <= s.end);
    if (!inside) return p;
    const doubtful = p.reid_similarity > 0 && p.reid_similarity < minReid;
    return doubtful ? { ...p, cameraHold: true } : p;
  });
}

/** 전체 화면 상자. 추적 카메라가 이것을 따라가면 가장 넓게 보여 준다. */
export const WIDE_BOX: NormalizedBBox = { x: 0, y: 0, width: 1, height: 1 };

/**
 * 구간 안의 점을 "넓게 보기" 로 바꾼다 — 재추적을 건너뛴 구간·트래킹을 해제한 장면.
 *
 * 확대해 따라가지 않고 화면 전체를 대상으로 두므로, 카메라는 그 구간에서 가장
 * 넓은 화면을 보여 준다. 원본과 결과물의 비율이 같으면 원본 화면 그대로이고,
 * 가로 원본을 세로로 만들 때는 가운데를 가장 넓게 자른 화면이다.
 */
export function wideOverSpans(
  points: readonly TrackingPoint[],
  spans: ReadonlyArray<{ start: number; end: number }>,
): TrackingPoint[] {
  if (!spans.length) return points as TrackingPoint[];
  return points.map((p) => (spans.some((s) => p.timestamp >= s.start && p.timestamp <= s.end)
    ? { ...p, bbox: { ...WIDE_BOX }, state: 'TRACKING_OK', wide: true } as TrackingPoint
    : p));
}
