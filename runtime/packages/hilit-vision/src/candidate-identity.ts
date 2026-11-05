/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·552696ec @license @preserve */
/* 검출 후보를 궤적에 잇는다.

프레임 배열 순번을 영속 ID로 쓰지 않는다.
한 후보를 동시에 여러 궤적에 넣지 않는다.
움직임만으로 동일인을 확정하지 않는다.
fixture 후보는 실제 검출로 기록하지 않는다.
*/

import { boxIou } from './hilit-grid-net';
import {
  fixtureDetector,
  unavailableDetector,
  prioritizeCandidates,
  nextSearchDue,
  type DetectorCandidate,
  type DetectorQuery,
  type DetectorProviderResult,
} from './detector-provider';

export const CANDIDATE_IOU_ASSIGN = 0.35;
export const CANDIDATE_CENTER_ASSIGN_BODIES = 0.65;
export const CANDIDATE_MAX_SIZE_RATIO = 1.45;
export const CANDIDATE_PREDICT_MAX_SEC = 0.6;

export interface PersistentCandidate {
  id: string;
  box: { x: number; y: number; width: number; height: number };
  tSec: number;
  source: DetectorProviderResult['kind'];
  claimedPersonDetection: false;
  enteredFromEdge: boolean;
  nearLastBox: boolean;
  assignedTrackletId: string | null;
  trackletHits?: number;
  knownOtherConflict?: boolean;
  simultaneousPresenceConflict?: boolean;
  confirmedOtherSimilarity?: number | null;
}

export interface CandidateTracklet {
  id: string;
  lastBox: { x: number; y: number; width: number; height: number };
  lastTSec: number;
  hits: number;
  times: number[];
  source: DetectorProviderResult['kind'];
  occupied: boolean;
  previousBox?: { x: number; y: number; width: number; height: number };
  previousTSec?: number;
}

function predictTrackletBox(tracklet: CandidateTracklet, tSec: number): CandidateTracklet['lastBox'] {
  const prev = tracklet.previousBox;
  const prevT = tracklet.previousTSec;
  const dt = tSec - tracklet.lastTSec;
  const histDt = prevT == null ? 0 : tracklet.lastTSec - prevT;
  if (!prev || histDt <= 1e-6 || dt <= 0 || dt > CANDIDATE_PREDICT_MAX_SEC) return tracklet.lastBox;
  const cx = tracklet.lastBox.x + tracklet.lastBox.width / 2;
  const cy = tracklet.lastBox.y + tracklet.lastBox.height / 2;
  const pcx = prev.x + prev.width / 2;
  const pcy = prev.y + prev.height / 2;
  return {
    x: cx + ((cx - pcx) / histDt) * dt - tracklet.lastBox.width / 2,
    y: cy + ((cy - pcy) / histDt) * dt - tracklet.lastBox.height / 2,
    width: tracklet.lastBox.width,
    height: tracklet.lastBox.height,
  };
}

function centerBodies(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const dx = (a.x + a.width / 2) - (b.x + b.width / 2);
  const dy = (a.y + a.height / 2) - (b.y + b.height / 2);
  return Math.hypot(dx, dy) / Math.max(1, Math.min(a.height, b.height));
}

function sizeRatio(
  a: { width: number; height: number },
  b: { width: number; height: number },
): number {
  return Math.max(
    a.width / Math.max(1e-6, b.width), b.width / Math.max(1e-6, a.width),
    a.height / Math.max(1e-6, b.height), b.height / Math.max(1e-6, a.height),
  );
}

export function newCandidateId(tSec: number, nonce: number): string {
  return `cand-${tSec.toFixed(3)}-${nonce.toString(36)}`;
}

export function assignCandidatesToTracklets(
  tracklets: CandidateTracklet[],
  detections: readonly DetectorCandidate[],
  tSec: number,
): { assigned: PersistentCandidate[]; tracklets: CandidateTracklet[] } {
  const usedDet = new Set<number>();
  const usedTrk = new Set<string>();
  const assigned: PersistentCandidate[] = [];
  const pairs: Array<{ di: number; ti: number; iou: number; score: number }> = [];
  for (let di = 0; di < detections.length; di += 1) {
    for (let ti = 0; ti < tracklets.length; ti += 1) {
      const predicted = predictTrackletBox(tracklets[ti], tSec);
      const iou = boxIou(detections[di].box, predicted);
      const center = centerBodies(detections[di].box, predicted);
      const size = sizeRatio(detections[di].box, predicted);
      const gated = iou >= CANDIDATE_IOU_ASSIGN
        || (center <= CANDIDATE_CENTER_ASSIGN_BODIES && size <= CANDIDATE_MAX_SIZE_RATIO);
      if (!gated) continue;
      const score = iou * 0.68
        + Math.max(0, 1 - center / CANDIDATE_CENTER_ASSIGN_BODIES) * 0.22
        + Math.max(0, 1 - (size - 1) / (CANDIDATE_MAX_SIZE_RATIO - 1)) * 0.10;
      pairs.push({ di, ti, iou, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || b.iou - a.iou);
  for (const p of pairs) {
    const tr = tracklets[p.ti];
    if (usedDet.has(p.di) || usedTrk.has(tr.id)) continue;
    usedDet.add(p.di);
    usedTrk.add(tr.id);
    const det = detections[p.di];
    tr.previousBox = { ...tr.lastBox };
    tr.previousTSec = tr.lastTSec;
    tr.lastBox = { ...det.box };
    tr.lastTSec = tSec;
    tr.hits += 1;
    tr.times = [...(tr.times ?? []), tSec].slice(-8);
    tr.occupied = true;
    assigned.push({
      id: tr.id,
      box: { ...det.box },
      tSec,
      source: det.source,
      claimedPersonDetection: false,
      enteredFromEdge: det.enteredFromEdge === true,
      nearLastBox: det.nearLastBox === true,
      assignedTrackletId: tr.id,
      trackletHits: tr.hits,
    });
  }
  let nonce = 1;
  for (let di = 0; di < detections.length; di += 1) {
    if (usedDet.has(di)) continue;
    const det = detections[di];
    const id = det.id && !det.id.startsWith('idx-') ? det.id : newCandidateId(tSec, nonce);
    nonce += 1;
    tracklets.push({
      id,
      lastBox: { ...det.box },
      lastTSec: tSec,
      hits: 1,
      times: [tSec],
      source: det.source,
      occupied: true,
    });
    assigned.push({
      id,
      box: { ...det.box },
      tSec,
      source: det.source,
      claimedPersonDetection: false,
      enteredFromEdge: det.enteredFromEdge === true,
      nearLastBox: det.nearLastBox === true,
      assignedTrackletId: id,
      trackletHits: 1,
    });
  }
  for (const tr of tracklets) {
    if (!usedTrk.has(tr.id) && !assigned.some((a) => a.id === tr.id)) tr.occupied = false;
  }
  return { assigned, tracklets };
}

export function queryFromLifecycle(
  tSec: number,
  reason: DetectorQuery['reason'],
  lastBox: DetectorQuery['lastBox'],
  frame: DetectorQuery['frame'],
): DetectorQuery {
  return { tSec, reason, lastBox, frame };
}

export function runFixtureCandidates(
  query: DetectorQuery,
  fixtures: readonly DetectorCandidate[],
  tracklets: CandidateTracklet[],
): { provider: DetectorProviderResult; assigned: PersistentCandidate[]; tracklets: CandidateTracklet[] } {
  const provider = fixtureDetector(query, fixtures);
  const ranked = prioritizeCandidates(query, provider.candidates);
  const next = assignCandidatesToTracklets(tracklets, ranked, query.tSec);
  return { provider, assigned: next.assigned, tracklets: next.tracklets };
}

export function runUnavailableCandidates(): DetectorProviderResult {
  return unavailableDetector();
}

export { nextSearchDue };
