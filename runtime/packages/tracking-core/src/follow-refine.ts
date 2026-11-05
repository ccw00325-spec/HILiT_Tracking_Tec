/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·429aa574 @license @preserve */
import type { NormalizedBBox, TrackingPoint } from '@hilit/shared-types';

/**
 * 따라가기 카메라가 겨눌 상자를 사람 검출로 다듬는다 — 2026-09-28 따라가기 개선.
 *
 * ## 왜
 *
 * 실사 23편(운영 추적기 main 259e44f)에서 추적 상자 기준으로는 세로 출력의 77.5% 프레임이 사람을 가운데(±15%)에
 * 두는데, 사람이 확인한 정답 상자 기준으로는 54.7% 뿐이었다. 추적 상자가 사람을 **놓치지는 않지만 몸의 가운데를
 * 정확히 잡지 못하는** 순간(몸 일부만, 옆으로 조금 밀림)이 많다. 카메라는 그 상자의 가운데를 겨누므로 사람이 옆으로
 * 치우쳐 보인다.
 *
 * ## 무엇으로
 *
 * 편집기는 추적이 끝난 뒤 「상자 아래 사람이 있나」를 보려고 0.5초마다 사람 검출기(MediaPipe EfficientDet-Lite0,
 * Apache-2.0, 2026-09-24 사용자 승인)를 이미 돌린다(presence-check). 그 사람 상자를 버리지 않고 여기서 쓴다.
 * 새 모델·라이브러리·데이터는 없다.
 *
 * ## 규칙 — 재획득·신원 판정이 아니다
 *
 * - 그 시각 추적 상자와 IoU ≥ iouMin 으로 겹치는 사람 상자만 본다. 겹치지 않는 사람으로는 절대 옮기지 않는다.
 * - 가장 잘 겹치는 상자가 두 번째보다 ambiguity 이상 분명할 때만 받는다(두 사람이 겹치면 손대지 않는다).
 * - 받아들인 차이(중심 이동·크기 비)를 앞뒤 reachSec 안에서 시간에 따라 이어 붙이고, 멀어질수록 0 으로 줄인다.
 * - 중심 이동은 몸 높이의 maxShiftBodies 배를 넘지 않는다.
 * - 놓침·재획득 중·카메라 붙잡기·넓은 화면·사람이 직접 짚은 점은 건드리지 않는다.
 * 결과는 카메라(미리보기·저장본)에만 쓴다. 추적 결과·확인 판단·학습 데이터는 바꾸지 않는다.
 */

export interface DetectionSample {
  time: number;
  /** 그 프레임의 사람 상자(정규화). 검출기를 못 쓴 프레임은 null. */
  people: Array<NormalizedBBox & { score: number }> | null;
}

export const FOLLOW_REFINE = {
  iouMin: 0.35,
  scoreMin: 0.3,
  ambiguity: 0.15,
  reachSec: 0.75,
  /** 받은 차이를 얼마나 따를지(1 이면 검출 상자 그대로). 검출 상자도 흔들리므로 조금 덜 따른다. */
  blend: 0.8,
  maxShiftBodies: 0.6,
  /** 추적 점과 검출 시각이 이만큼 안에 있어야 짝을 짓는다. */
  pairSec: 0.3,
} as const;

export type FollowRefineOptions = Partial<typeof FOLLOW_REFINE>;

interface Correction { time: number; dx: number; dy: number; lw: number; lh: number }

function iou(a: NormalizedBBox, b: NormalizedBBox): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function usable(p: TrackingPoint): boolean {
  const wide = (p as TrackingPoint & { wide?: boolean }).wide === true;
  /* 의심으로 놓침에 내렸어도 추적기가 잰 상자(doubtFollow)는 카메라가 따라가므로 같이 다듬는다. */
  return (p.state !== 'TARGET_LOST' && p.state !== 'REACQUIRING' || p.doubtFollow === true)
    && !p.cameraHold && !wide && p.manual !== true
    && p.bbox.width > 0.002 && p.bbox.height > 0.002;
}

/** 검출 표본마다 받아들일 차이를 구한다. 시험·진단에서도 쓴다. */
export function refineCorrections(
  points: readonly TrackingPoint[],
  samples: readonly DetectionSample[],
  options: FollowRefineOptions = {},
): Correction[] {
  const o = { ...FOLLOW_REFINE, ...options };
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const out: Correction[] = [];
  for (const s of samples) {
    if (!s.people?.length) continue;
    let near: TrackingPoint | null = null;
    let gap = Infinity;
    for (const p of sorted) {
      const d = Math.abs(p.timestamp - s.time);
      if (d < gap) { gap = d; near = p; }
    }
    if (!near || gap > o.pairSec || !usable(near)) continue;
    const scored = s.people
      .filter((person) => person.score >= o.scoreMin)
      .map((person) => ({ person, o: iou(near!.bbox, person) }))
      .sort((a, b) => b.o - a.o);
    const best = scored[0];
    if (!best || best.o < o.iouMin) continue;
    if (scored[1] && best.o - scored[1].o < o.ambiguity) continue;
    const t = near.bbox, d = best.person;
    const dx = (d.x + d.width / 2) - (t.x + t.width / 2);
    const dy = (d.y + d.height / 2) - (t.y + t.height / 2);
    if (Math.hypot(dx, dy) > o.maxShiftBodies * t.height) continue;
    out.push({ time: s.time, dx, dy, lw: Math.log(d.width / t.width), lh: Math.log(d.height / t.height) });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** 카메라용 궤적 — 추적 상자를 사람 검출 쪽으로 부드럽게 다듬는다. 표본이 없으면 그대로 돌려준다. */
export function refineWithDetections(
  points: readonly TrackingPoint[],
  samples: readonly DetectionSample[],
  options: FollowRefineOptions = {},
): TrackingPoint[] {
  const o = { ...FOLLOW_REFINE, ...options };
  const fixes = refineCorrections(points, samples, o);
  if (!fixes.length) return points as TrackingPoint[];
  return points.map((p) => {
    if (!usable(p)) return p;
    let prev: Correction | null = null, next: Correction | null = null;
    for (const f of fixes) {
      if (f.time <= p.timestamp) prev = f;
      else { next = f; break; }
    }
    const within = (f: Correction | null) => f && Math.abs(f.time - p.timestamp) <= o.reachSec ? f : null;
    const a = within(prev), b = within(next);
    if (!a && !b) return p;
    let c: Omit<Correction, 'time'>;
    let weight: number;
    if (a && b) {
      const k = (p.timestamp - a.time) / Math.max(1e-6, b.time - a.time);
      c = { dx: a.dx + (b.dx - a.dx) * k, dy: a.dy + (b.dy - a.dy) * k, lw: a.lw + (b.lw - a.lw) * k, lh: a.lh + (b.lh - a.lh) * k };
      weight = 1;
    } else {
      const f = (a ?? b)!;
      c = f;
      weight = 1 - Math.abs(f.time - p.timestamp) / o.reachSec;
    }
    const g = o.blend * Math.max(0, Math.min(1, weight));
    const w = p.bbox.width * Math.exp(g * c.lw);
    const h = p.bbox.height * Math.exp(g * c.lh);
    const cx = p.bbox.x + p.bbox.width / 2 + g * c.dx;
    const cy = p.bbox.y + p.bbox.height / 2 + g * c.dy;
    const x = Math.max(0, Math.min(1 - w, cx - w / 2));
    const y = Math.max(0, Math.min(1 - h, cy - h / 2));
    return { ...p, bbox: { x, y, width: Math.min(1, w), height: Math.min(1, h) } };
  });
}
