/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·a4074a76 @license @preserve */
/* 검출기 경계. 휴리스틱을 사람 검출로 두지 않는다.

실사용 가중치가 없으면 unavailable. fixture 시험은 실제 검출이 아니다.
원본→재획득 제품 검증은 BLOCKED.
*/

export type DetectorProviderKind = 'unavailable' | 'fixture' | 'heuristic_not_person' | 'blocked_real';

export interface DetectorCandidate {
  id: string;
  box: { x: number; y: number; width: number; height: number };
  score: number | null;
  source: DetectorProviderKind;
  enteredFromEdge?: boolean;
  nearLastBox?: boolean;
}

export interface DetectorQuery {
  tSec: number;
  reason: 'out_of_view' | 'occluded' | 'scene_cut' | 'uncertain' | 'probe';
  lastBox: { x: number; y: number; width: number; height: number } | null;
  frame: { width: number; height: number };
  knownOtherBoxes?: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface DetectorProviderResult {
  kind: DetectorProviderKind;
  candidates: DetectorCandidate[];
  claimedPersonDetection: false;
  productPathBlocked: boolean;
  searchHz: number;
}

export const SEARCH_HZ_ABSENT = 2;
export const SEARCH_HZ_NEW = 10;
export const SEARCH_MIN_GAP_ABSENT_SEC = 1 / SEARCH_HZ_ABSENT;
export const SEARCH_MIN_GAP_ACTIVE_SEC = 1 / SEARCH_HZ_NEW;

export function nextSearchDue(input: {
  lastSearchSec: number | null;
  nowSec: number;
  foundNewCandidate: boolean;
}): boolean {
  if (input.lastSearchSec == null) return true;
  if (!Number.isFinite(input.nowSec) || input.nowSec < input.lastSearchSec) return false;
  const gap = input.foundNewCandidate ? SEARCH_MIN_GAP_ACTIVE_SEC : SEARCH_MIN_GAP_ABSENT_SEC;
  return input.nowSec - input.lastSearchSec >= gap - 1e-6;
}

export function prioritizeCandidates(
  query: DetectorQuery,
  candidates: readonly DetectorCandidate[],
): DetectorCandidate[] {
  const last = query.lastBox;
  const frame = query.frame;
  return candidates.slice().sort((a, b) => {
    if (query.reason === 'out_of_view') {
      const ae = a.enteredFromEdge ? 1 : 0;
      const be = b.enteredFromEdge ? 1 : 0;
      if (ae !== be) return be - ae;
    }
    if (query.reason === 'occluded' && last) {
      const ad = Math.hypot(a.box.x - last.x, a.box.y - last.y);
      const bd = Math.hypot(b.box.x - last.x, b.box.y - last.y);
      if (ad !== bd) return ad - bd;
    }
    const as = a.score ?? -1;
    const bs = b.score ?? -1;
    return bs - as;
  }).map((c, i) => ({
    ...c,
    id: c.id || `det-${query.tSec.toFixed(3)}-${i}`,
    enteredFromEdge: c.enteredFromEdge ?? edgeEntry(c.box, frame),
    nearLastBox: last
      ? Math.hypot(c.box.x + c.box.width / 2 - (last.x + last.width / 2), c.box.y + c.box.height / 2 - (last.y + last.height / 2))
        < Math.max(last.height, 8) * 1.6
      : false,
  }));
}

function edgeEntry(
  box: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): boolean {
  const short = Math.max(1, Math.min(frame.width, frame.height));
  const gap = Math.min(box.x, frame.width - box.x - box.width, box.y, frame.height - box.y - box.height) / short;
  return gap <= 0.08;
}

export function fixtureDetector(
  query: DetectorQuery,
  fixtures: readonly DetectorCandidate[],
): DetectorProviderResult {
  return {
    kind: 'fixture',
    candidates: prioritizeCandidates(query, fixtures.map((c) => ({ ...c, source: 'fixture' }))),
    claimedPersonDetection: false,
    productPathBlocked: true,
    searchHz: fixtures.length ? SEARCH_HZ_NEW : SEARCH_HZ_ABSENT,
  };
}

export function unavailableDetector(): DetectorProviderResult {
  return {
    kind: 'unavailable',
    candidates: [],
    claimedPersonDetection: false,
    productPathBlocked: true,
    searchHz: SEARCH_HZ_ABSENT,
  };
}

export function detectorProductBlocked(kind: DetectorProviderKind): boolean {
  return kind !== 'blocked_real';
}
