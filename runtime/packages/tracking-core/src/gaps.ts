/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b732a5e9 @license @preserve */
import { type TrackingPoint } from '@hilit/shared-types';

/* 추적을 놓친 구간 찾기.
 *
 * 자동 복구가 늘 되는 건 아니다. 대상이 오래 가려지거나 화면 밖으로
 * 나갔다 돌아오면 기계가 혼자 판단할 근거가 없다.
 *
 * 그럴 때 조용히 틀린 위치를 따라가는 것보다, **사용자에게 물어보는 게**
 * 낫다. 사용자는 자기가 어디 있었는지 안다. 그 한 번의 확인이 기계의
 * 어떤 추측보다 정확하다.
 *
 * 이 모듈은 "물어볼 구간" 을 찾는 일만 한다. 물어보는 방식은 화면이 정한다.
 */

export interface TrackingGap {
  id: string;
  /** 사용자가 이 구간에 「여긴 내가 없어요」라고 답했나. 건너뛴 구간 중 이것만 넓은 화면으로 둔다(2026-09-28). */
  absent?: boolean;
  /** 구간 시작·끝 (초). */
  start: number;
  end: number;
  /** 이 구간에서 가장 나빴던 시각. 여기를 먼저 보여준다. */
  worstAt: number;
  /** 구간 안 최저 신뢰도. */
  minConfidence: number;
  /** 구간 안 최저 Re-ID. */
  minReid: number;
  /** 왜 물어보는가 — 화면에 그대로 보여준다. */
  reason: 'lost' | 'occluded' | 'identity' | 'weak' | 'absent';
  frames: number;
}

export interface FindGapsOptions {
  /** 이 신뢰도 미만이면 의심 구간. */
  minConfidence?: number;
  /** 이 Re-ID 미만이면 신원이 의심스럽다. */
  minReid?: number;
  /** 이 프레임 수보다 짧으면 묻지 않는다. 잠깐 흔들린 것까지 묻으면 번거롭다. */
  minFrames?: number;
  /** 가까운 구간은 하나로 합친다 (초). */
  mergeWithin?: number;
}

const DEFAULTS: Required<FindGapsOptions> = {
  minConfidence: 0.45,
  minReid: 0.5,
  minFrames: 4,
  mergeWithin: 0.8,
};

/** 사용자에게 물어볼 만한 구간을 찾는다. */
export function findTrackingGaps(
  points: TrackingPoint[],
  options: FindGapsOptions = {},
): TrackingGap[] {
  const o = { ...DEFAULTS, ...options };
  if (points.length < 3) return [];

  const sorted = points.slice().sort((a, b) => a.timestamp - b.timestamp);

  const suspect = sorted.map((p) => {
    if (p.editSpanResolved === true && p.state !== 'TRACKING_OK' && p.state !== 'TRACKING_WARNING') return null;
    /* 연결 추적이 「화면에 없다」고 판단한 점은 묻지 않는다(2026-10-20). */
    if (p.engineAbsent === true && p.state === 'TARGET_LOST') return null;
    if (p.state === 'TARGET_LOST' || p.state === 'REACQUIRING') return 'lost' as const;
    if (p.state === 'OCCLUDED') return 'occluded' as const;
    if (p.reid_similarity > 0 && p.reid_similarity < o.minReid) return 'identity' as const;
    if (p.confidence < o.minConfidence) return 'weak' as const;
    return null;
  });

  const raw: TrackingGap[] = [];
  let i = 0;
  while (i < sorted.length) {
    if (!suspect[i]) { i++; continue; }
    let j = i;
    while (j < sorted.length && suspect[j]) j++;

    const span = sorted.slice(i, j);
    if (span.length >= o.minFrames) {
      /* 가장 나쁜 지점을 대표로 삼는다. 사용자에게 그 프레임을 먼저
       * 보여줘야 "왜 물어보는지" 가 바로 이해된다. */
      let worst = span[0];
      for (const p of span) if (p.confidence < worst.confidence) worst = p;

      // 구간 안에서 가장 자주 나온 이유를 대표로 쓴다.
      const counts: Record<string, number> = {};
      for (let k = i; k < j; k++) counts[suspect[k]!] = (counts[suspect[k]!] ?? 0) + 1;
      const reason = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as TrackingGap['reason'];

      raw.push({
        id: `gap-${raw.length + 1}`,
        start: span[0].timestamp,
        end: span[span.length - 1].timestamp,
        worstAt: worst.timestamp,
        minConfidence: Math.min(...span.map((p) => p.confidence)),
        minReid: Math.min(...span.map((p) => p.reid_similarity)),
        reason,
        frames: span.length,
      });
    }
    i = j;
  }

  /* 가까운 구간은 합친다.
   * 잠깐 회복했다가 다시 나빠지는 패턴이 흔한데, 그걸 따로 물으면
   * 같은 장면을 두세 번 확인하게 된다. */
  const merged: TrackingGap[] = [];
  for (const gap of raw) {
    const last = merged[merged.length - 1];
    if (last && gap.start - last.end <= o.mergeWithin) {
      last.end = gap.end;
      last.frames += gap.frames;
      if (gap.minConfidence < last.minConfidence) {
        last.minConfidence = gap.minConfidence;
        last.worstAt = gap.worstAt;
        last.reason = gap.reason;
      }
      last.minReid = Math.min(last.minReid, gap.minReid);
    } else {
      merged.push({ ...gap });
    }
  }

  return merged.map((gap, index) => ({ ...gap, id: `gap-${index + 1}` }));
}

/** 사람이 읽을 설명. 기계 상태 이름을 그대로 보여주지 않는다. */
export function describeGap(gap: TrackingGap): string {
  switch (gap.reason) {
    case 'lost': return '여기서 놓쳤어요';
    case 'occluded': return '가려져서 안 보였어요';
    case 'identity': return '같은 분인지 확신이 없어요';
    case 'absent': return '이 장면에서 나를 찾지 못했어요';
    default: return '흐릿해서 자신이 없어요';
  }
}

/** 확인 구간 주변으로 사용자가 훑어볼 범위. 넓힐 수 있게 단계로 준다. */
export const GAP_WINDOWS = [5, 15, 60] as const;

export function gapWindow(gap: TrackingGap, seconds: number, duration: number) {
  const half = seconds / 2;
  const start = Math.max(0, gap.worstAt - half);
  const end = Math.min(duration, Math.max(start + 0.5, gap.worstAt + half));
  return { start, end };
}
