/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·7de4414b @license @preserve */
import type { NormalizedBBox } from '@hilit/shared-types';

/**
 * 검출기가 준 상자를 편집기가 쓰는 비율 상자로 바꾼다.
 *
 * 파이프라인 detect() 는 { box:{x,y,width,height}, score } 다.
 * 예전 타입 선언은 {x,y,w,h} 였다. 둘 다 받는다 — 한쪽만 받으면
 * "여기서 나 찾기" 가 빈 목록이 된다.
 */

export interface PersonCandidate {
  id: string;
  label: string;
  box: NormalizedBBox;
  score: number;
}

/**
 * 사람 상자는 띄운 그 프레임에서만 맞다.
 *
 * 재생 막대 한 칸이 0.05초이고 브라우저의 되감기가 키프레임에 따라 조금
 * 흔들리므로 두 칸 남짓은 같은 장면으로 본다. 그보다 멀어지면 상자를 치운다 —
 * 옛 상자를 새 장면에 얹으면 추적이 첫 프레임부터 엉뚱한 곳을 따라간다.
 */
export const PERSON_PROPOSAL_TIME_TOLERANCE_SEC = 0.12;

/**
 * 늦은 검출 응답을 지금 화면에 붙일 수 있는지.
 * 요청 번호가 바뀌었거나(취소·다시 찾기·다른 영상), 시각이 0.12초를 넘으면 버린다.
 */
export function acceptFreshPersonResult(input: {
  epoch: number;
  currentEpoch: number;
  proposalTime: number | null | undefined;
  currentTime: number;
  requestVideoId?: string | null;
  currentVideoId?: string | null;
}): { ok: true } | { ok: false; reason: 'cancelled' | 'other-video' | 'time' } {
  if (input.epoch !== input.currentEpoch) return { ok: false, reason: 'cancelled' };
  if ((input.requestVideoId ?? '') !== (input.currentVideoId ?? '')) return { ok: false, reason: 'other-video' };
  if (!isPersonProposalCurrent(input.proposalTime, input.currentTime)) return { ok: false, reason: 'time' };
  return { ok: true };
}

export function isPersonProposalCurrent(proposalTime: number | null | undefined, currentTime: number): boolean {
  return typeof proposalTime === 'number' && Number.isFinite(proposalTime) && Number.isFinite(currentTime)
    && Math.abs(proposalTime - currentTime) <= PERSON_PROPOSAL_TIME_TOLERANCE_SEC;
}

type LooseHit = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  width?: number;
  height?: number;
  score?: number;
  box?: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    width?: number;
    height?: number;
  };
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampBox(box: NormalizedBBox): NormalizedBBox {
  const width = Math.max(0.04, Math.min(1, box.width));
  const height = Math.max(0.04, Math.min(1, box.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(1 - width, box.x)),
    y: Math.max(0, Math.min(1 - height, box.y)),
  };
}

export function hitToPixels(hit: unknown): { x: number; y: number; w: number; h: number; score: number } | null {
  if (!hit || typeof hit !== 'object') return null;
  const row = hit as LooseHit;
  const src = row.box ?? row;
  const x = Number(src.x);
  const y = Number(src.y);
  const w = Number(src.width ?? src.w);
  const h = Number(src.height ?? src.h);
  if (![x, y, w, h].every(Number.isFinite) || w < 2 || h < 2) return null;
  return { x, y, w, h, score: Number(row.score ?? 0) };
}

export function fromDetectorHits(
  hits: readonly unknown[],
  frameWidth: number,
  frameHeight: number,
): PersonCandidate[] {
  if (!(frameWidth > 1) || !(frameHeight > 1)) return [];
  const people: PersonCandidate[] = [];
  for (const hit of hits) {
    const px = hitToPixels(hit);
    if (!px) continue;
    people.push({
      id: `person-${people.length + 1}`,
      label: `사람 ${people.length + 1}`,
      score: px.score,
      box: clampBox({
        x: clamp01(px.x / frameWidth),
        y: clamp01(px.y / frameHeight),
        width: clamp01(px.w / frameWidth),
        height: clamp01(px.h / frameHeight),
      }),
    });
  }
  return people;
}

/** 후보는 한 명만 고른다. 다른 칸을 누르면 그게 유일한 선택이다. */
export function selectOnePerson(
  people: readonly PersonCandidate[],
  id: string,
): PersonCandidate | null {
  return people.find((row) => row.id === id) ?? null;
}
