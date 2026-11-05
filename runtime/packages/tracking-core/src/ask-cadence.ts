/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·8fa1b98c @license @preserve */
import type { TrackingPoint } from '@hilit/shared-types';
import type { TrackingGap } from './gaps';

/**
 * 사용자에게 **몇 번, 어디서** 물을지 — 헷갈림 한 번에 질문 한 번(2026-09-28).
 *
 * 사용자 요청: 「놓친 구간에서 너무 0.1초 단위로 묻지 마라. 고르게 한 뒤 재추적하고, 다시 놓친 곳에서만 물어라.
 * 지금은 너무 촘촘해서 같은 지점을 묻는 느낌이다.」
 *
 * 확인 구간(findTrackingGaps)은 4프레임(≈0.3초)짜리 흔들림도 잡고 0.8초만 떨어져도 따로 둔다. 추적이 흔들리는 한
 * 장면(몇 초)이 질문 서너 개로 쪼개지고, 사용자가 고른 직후 추적기가 자리를 잡는 몇 프레임이 다시 확인 구간이 되어
 * 방금 답한 자리를 또 묻는다. 여기서 그것을 사용자에게 보일 질문으로 줄인다:
 *
 *   1. 가까운 구간(ASK_MERGE_WITHIN_SEC 안)은 한 질문으로 묶는다 — 가장 나쁜 순간(worstAt)을 보여 준다
 *   2. 짧은 흔들림(신뢰도 · 가림만, ASK_MIN_WEAK_SEC 미만)은 묻지 않는다 — 카메라가 붙잡고(cameraHold) 넘어간다
 *   3. 사용자가 이미 답한 자리(answered) 뒤는, 추적이 한 번 **확실히 잡힌 뒤(ASK_REARM_OK_SEC)** 에 다시 놓친 것만 묻는다.
 *      답한 직후 이어지는 짧은 흔들림은 같은 헷갈림의 연장으로 보고 기술이 덮는다. 단, 답한 뒤에도 길게
 *      놓쳤으면(ASK_REAL_LOSS_SEC 이상) 재추적이 실패한 것이므로 묻는다
 *
 * 🔴 이 함수는 묻지 않을 구간을 **숨길 뿐** 궤적을 고치지 않는다. 숨긴 구간도 카메라는 저장된 상자 · cameraHold 로
 *    따라가고, 「틀린 정상」을 줄이는 판정은 추적기 쪽 몫이다.
 */

/** 이 간격 안의 구간은 한 질문으로 묶는다. */
export const ASK_MERGE_WITHIN_SEC = 2.5;
/** 신뢰도 · 가림만인 흔들림은 이보다 짧으면 묻지 않는다. 놓침 · 외형 어긋남 · 없음은 길이와 무관하게 남긴다. */
export const ASK_MIN_WEAK_SEC = 0.6;
/** 답한 뒤 다시 묻기 전에 추적이 확실히 잡혀 있어야 하는 시간 — pipeline.js 의 askRearmSec 와 같은 값. */
export const ASK_REARM_OK_SEC = 1.5;
/** 답한 뒤에도 이만큼 이어서 놓치면 재추적 실패로 보고 다시 묻는다. */
export const ASK_REAL_LOSS_SEC = 1.5;
/** 한 편집에서 확인 단계가 묻는 최대 개수. 넘으면 가장 나쁜(신뢰도 낮은) 것부터 남긴다. */
export const ASK_MAX = 6;

export interface AnsweredAsk {
  /** 사용자가 답한 원본 구간 — 고른 시각(at)이면 start=end=at. 「여기 없어요」면 그 구간. */
  start: number;
  end: number;
}

export interface AskCadenceOptions {
  mergeWithin?: number;
  minWeakSec?: number;
  rearmOkSec?: number;
  realLossSec?: number;
  max?: number;
}

function confidentOk(p: TrackingPoint): boolean {
  return p.state === 'TRACKING_OK'
    && p.confidence >= 0.45
    && !(p.reid_similarity > 0 && p.reid_similarity < 0.5)
    && !p.cameraHold;
}

/** from~to 사이에서 「확실히 잡힌」 상태가 가장 길게 이어진 시간(초). */
export function longestConfidentRun(points: readonly TrackingPoint[], from: number, to: number): number {
  let best = 0;
  let runStart: number | null = null;
  let last = from;
  for (const p of points) {
    if (p.timestamp < from - 1e-6) continue;
    if (p.timestamp > to + 1e-6) break;
    if (confidentOk(p)) {
      if (runStart === null) runStart = p.timestamp;
      best = Math.max(best, p.timestamp - runStart);
    } else runStart = null;
    last = p.timestamp;
  }
  void last;
  return best;
}

/** 약한 구간 안에서 「정말 약한」 점 — 이 신뢰도 미만이거나 놓침·재획득. */
export const ASK_WEAK_CORE_CONF = 0.3;

/**
 * 약한(신뢰도 · 가림) 구간의 알맹이 — 정말 약한 점이 가장 길게 이어진 부분.
 *
 * 편집기 후처리는 확인 안 된 프레임의 신뢰도를 0.42 로 깎는다(tracking-postprocess). 확인 구간 문턱이 0.45 라,
 * 실측 24편 전부에서 영상 **전체가** 약한 구간 하나가 됐다(2026-09-28). 그러면 사용자가 한 번 고른 뒤 다시 추적한
 * 나머지가 또 통째로 약한 구간이 되어, 그 안에서 가장 낮은 점을 또 묻는다 — 「같은 지점을 계속 묻는다」.
 * 0.42 는 「확인은 못 했지만 따라가는 중」이다(실험실 검수: 주의 상자 23곳 중 22곳이 정답과 맞음). 그 안에서 정말
 * 떨어진 부분만 알맹이로 본다.
 */
function weakCore(points: readonly TrackingPoint[], g: TrackingGap): { start: number; end: number; worstAt: number; minConfidence: number } | null {
  type Core = { start: number; end: number; worstAt: number; minConfidence: number };
  let best: Core | null = null;
  let cur: Core | null = null;
  for (const p of points) {
    if (p.timestamp < g.start - 1e-6) continue;
    if (p.timestamp > g.end + 1e-6) break;
    const weak = p.state === 'TARGET_LOST' || p.state === 'REACQUIRING' || p.confidence < ASK_WEAK_CORE_CONF;
    if (!weak) { cur = null; continue; }
    if (!cur) cur = { start: p.timestamp, end: p.timestamp, worstAt: p.timestamp, minConfidence: p.confidence };
    cur.end = p.timestamp;
    if (p.confidence < cur.minConfidence) { cur.minConfidence = p.confidence; cur.worstAt = p.timestamp; }
    if (!best || cur.end - cur.start > best.end - best.start) best = { ...cur };
  }
  return best;
}

function mergeClose(gaps: readonly TrackingGap[], within: number): TrackingGap[] {
  const sorted = gaps.slice().sort((a, b) => a.start - b.start);
  const out: TrackingGap[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g.start - last.end <= within) {
      last.end = Math.max(last.end, g.end);
      last.frames += g.frames;
      last.absent = Boolean(last.absent && g.absent);
      if (g.minConfidence < last.minConfidence) {
        last.minConfidence = g.minConfidence;
        last.worstAt = g.worstAt;
        last.reason = g.reason;
      }
      last.minReid = Math.min(last.minReid, g.minReid);
    } else out.push({ ...g });
  }
  return out;
}

/**
 * 확인 단계에서 실제로 물을 구간.
 *
 * points 는 정렬된 궤적(편집기의 tracking), answered 는 이 편집에서 사용자가 이미 답한 자리들.
 */
export function askableGaps(
  gaps: readonly TrackingGap[],
  points: readonly TrackingPoint[],
  answered: readonly AnsweredAsk[] = [],
  options: AskCadenceOptions = {},
): TrackingGap[] {
  const mergeWithin = options.mergeWithin ?? ASK_MERGE_WITHIN_SEC;
  const minWeak = options.minWeakSec ?? ASK_MIN_WEAK_SEC;
  const rearm = options.rearmOkSec ?? ASK_REARM_OK_SEC;
  const realLoss = options.realLossSec ?? ASK_REAL_LOSS_SEC;
  const max = options.max ?? ASK_MAX;
  const sortedPoints = points.slice().sort((a, b) => a.timestamp - b.timestamp);
  const answers = answered.slice().sort((a, b) => a.start - b.start);

  /* 짧은 약한 흔들림은 묶기 **전에** 뺀다 — 묶은 뒤에 재면 0.4초짜리 셋이 3초짜리 하나가 되어 살아난다. */
  const soft = (g: TrackingGap) => g.reason === 'weak' || g.reason === 'occluded';
  /* 약한 구간: 그 자체가 짧으면(minWeak 미만) 묻지 않는다. 길면 정말 떨어진 곳(신뢰도 ASK_WEAK_CORE_CONF 미만)이
   * 있을 때만 **그 알맹이로 좁혀** 한 번 묻는다 — 0.42(확인 못 했지만 따라가는 중)만으로 된 구간은 묻지 않는다.
   * 🔴 알맹이가 짧아도 버리지 않는다. 모델 검수 정답(실사 22편)으로 대 보니, 알맹이가 0.6초 이상인 것만 남기면
   *    추적 상자가 틀린 영상 16편 중 질문이 틀린 곳을 가리키는 영상이 13편 → 7편으로 줄었다. 틀린 사람을 조용히
   *    따라가는 것이 더 나쁘다. 줄이는 것은 **답한 뒤** 다시 묻는 몫이다(아래 answered). */
  const meaningful = gaps.flatMap((g): TrackingGap[] => {
    if (g.absent || !soft(g)) return [g];
    if (g.end - g.start < minWeak) return [];
    const core = weakCore(sortedPoints, g);
    if (!core) return [];
    if (core.end - core.start >= minWeak) return [{ ...g, ...core }];
    /* 짧은 알맹이뿐이면 가장 나쁜 순간(그것이 정말 떨어진 점이면 구간 전체의 worstAt) 앞뒤로 좁혀 한 번 묻는다. */
    const at = g.minConfidence < ASK_WEAK_CORE_CONF ? g.worstAt : core.worstAt;
    const half = minWeak / 2;
    return [{ ...g, worstAt: at, minConfidence: Math.min(g.minConfidence, core.minConfidence),
      start: Math.max(g.start, at - half), end: Math.min(g.end, at + half) }];
  });
  const kept: TrackingGap[] = [];
  for (const g of mergeClose(meaningful, mergeWithin)) {
    const softOnly = soft(g);

    /* 이미 답한 자리와 겹치거나 바로 뒤에 이어지는가. */
    const before = [...answers].reverse().find((a) => a.start <= g.end + 1e-6);
    if (before) {
      /* 답한 구간 안쪽은 이미 답이 있다 — 그 뒤로 남는 몫만 본다. */
      const tailStart = Math.max(g.start, before.end);
      const tailLen = g.end - tailStart;
      if (tailLen <= 1e-3 && g.start >= before.start - 1e-3) continue;
      /* 답한 뒤 확실히 잡힌 적이 없고(같은 헷갈림의 연장), 길게 놓친 것도 아니면 기술이 덮는다. */
      const settled = longestConfidentRun(sortedPoints, before.end, tailStart) >= rearm;
      const longLoss = !softOnly && tailLen >= realLoss;
      if (!settled && !longLoss && !g.absent) continue;
      /* 보여 줄 순간은 답한 자리 그 자체가 아니다 — 답한 뒤 realLoss 초가 지나도 여전히 놓친 자리다(같은 장면을
       * 다시 보여 주면 「같은 지점을 또 묻는다」가 된다). 확실히 잡혔다가 다시 놓친 경우는 원래 가장 나쁜 순간. */
      const askAt = settled ? Math.max(g.worstAt, tailStart) : Math.min(g.end, Math.max(g.worstAt, tailStart + realLoss));
      kept.push({ ...g, start: tailStart, worstAt: askAt });
      continue;
    }
    kept.push({ ...g });
  }

  /* 너무 많으면 가장 나쁜 것만 — 나머지는 카메라가 붙잡고 넘어간다. */
  const limited = kept.length > max
    ? kept.slice().sort((a, b) => a.minConfidence - b.minConfidence).slice(0, max).sort((a, b) => a.start - b.start)
    : kept;
  return limited.map((g, i) => ({ ...g, id: `gap-${i + 1}` }));
}
