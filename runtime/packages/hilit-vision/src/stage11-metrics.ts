/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·593be022 @license @preserve */
/**
 * 검출·Tracking 숫자는 사람이 확인한 상자에서만 센다.
 * 합성·자동 상자를 실사 P/R로 바꾸지 않는다.
 */

import { clipAdmittedForRealMetrics, type Stage11Clip } from './stage11-rights';

export type Box = { x: number; y: number; width: number; height: number };

export type ReviewedTruth = {
  clip: Stage11Clip;
  t: number;
  box: Box;
  visibility: 'visible' | 'occluded' | 'absent';
  subjectId: string;
};

export type DetectionPred = { clipId: string; t: number; box: Box; score: number };
export type TrackPred = {
  clipId: string;
  t: number;
  box: Box;
  trackConfidence: number;
  identityConfidence: number;
  state: string;
  subjectId: string | null;
};

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

export function reviewedOnly(rows: ReviewedTruth[]): ReviewedTruth[] {
  return rows.filter((row) => clipAdmittedForRealMetrics(row.clip).ok && row.clip.review.boxes === 'human');
}

export function detectionScores(truth: ReviewedTruth[], preds: DetectionPred[], matchIou = 0.5): {
  status: 'blocked' | 'ok';
  reason: string | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  smallPersonRecall: number | null;
  occlusionRecall: number | null;
  motionBlurRecall: number | null;
  crowdRecall: number | null;
  candidatesPerFrame: number | null;
  msPerFrame: number | null;
  backgroundFalsePerFrame: number | null;
  countedBoxes: number;
} {
  const empty = {
    smallPersonRecall: null as number | null,
    occlusionRecall: null as number | null,
    motionBlurRecall: null as number | null,
    crowdRecall: null as number | null,
    candidatesPerFrame: null as number | null,
    msPerFrame: null as number | null,
  };
  const gold = reviewedOnly(truth).filter((row) => row.visibility === 'visible');
  if (!gold.length) {
    return {
      status: 'blocked',
      reason: '사람이 확인한 실사 상자가 없어 검출 P/R을 계산하지 않습니다.',
      precision: null,
      recall: null,
      f1: null,
      ...empty,
      backgroundFalsePerFrame: null,
      countedBoxes: 0,
    };
  }
  const used = new Set<string>();
  let tp = 0;
  let fp = 0;
  for (const pred of preds) {
    let hit = false;
    for (const row of gold) {
      const key = `${row.clip.assetId}:${row.t}`;
      if (used.has(key) || row.clip.assetId !== pred.clipId) continue;
      if (Math.abs(row.t - pred.t) > 0.05) continue;
      if (iou(row.box, pred.box) >= matchIou) {
        used.add(key);
        hit = true;
        tp += 1;
        break;
      }
    }
    if (!hit) fp += 1;
  }
  const fn = gold.length - tp;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = gold.length === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    status: 'ok',
    reason: null,
    precision,
    recall,
    f1,
    ...empty,
    backgroundFalsePerFrame: preds.length ? fp / preds.length : 0,
    countedBoxes: gold.length,
  };
}

export function trackingScores(truth: ReviewedTruth[], preds: TrackPred[]): {
  status: 'blocked' | 'ok';
  reason: string | null;
  holdRate: number | null;
  meanIou: number | null;
  meanCenterError: number | null;
  idSwitch: number | null;
  lostCount: number | null;
  falseAccept: number | null;
  falseReject: number | null;
  falseReacquire: number | null;
  correctReacquire: number | null;
  reacquireSeconds: number | null;
  otherPersonInCandidates: number | null;
  userRedesignate: number | null;
  counted: number;
} {
  const gold = reviewedOnly(truth);
  if (!gold.length) {
    return {
      status: 'blocked',
      reason: '사람이 확인한 실사 궤적이 없어 Tracking·Re-ID 숫자를 계산하지 않습니다.',
      holdRate: null,
      meanIou: null,
      meanCenterError: null,
      idSwitch: null,
      lostCount: null,
      falseAccept: null,
      falseReject: null,
      falseReacquire: null,
      correctReacquire: null,
      reacquireSeconds: null,
      otherPersonInCandidates: null,
      userRedesignate: null,
      counted: 0,
    };
  }
  let hold = 0;
  let iouSum = 0;
  let center = 0;
  let switches = 0;
  let lost = 0;
  let fa = 0;
  let fr = 0;
  let prevId: string | null = null;
  for (const row of gold) {
    const pred = preds.find((p) => p.clipId === row.clip.assetId && Math.abs(p.t - row.t) <= 0.05);
    if (!pred || pred.state === 'TARGET_LOST') {
      lost += 1;
      if (row.visibility === 'visible') fr += 1;
      continue;
    }
    const overlap = iou(row.box, pred.box);
    iouSum += overlap;
    const dx = (row.box.x + row.box.width / 2) - (pred.box.x + pred.box.width / 2);
    const dy = (row.box.y + row.box.height / 2) - (pred.box.y + pred.box.height / 2);
    center += Math.hypot(dx, dy);
    if (overlap >= 0.3 && pred.subjectId === row.subjectId) hold += 1;
    if (pred.subjectId && pred.subjectId !== row.subjectId) {
      fa += 1;
      if (prevId && pred.subjectId !== prevId) switches += 1;
    }
    prevId = pred.subjectId;
  }
  return {
    status: 'ok',
    reason: null,
    holdRate: hold / gold.length,
    meanIou: iouSum / gold.length,
    meanCenterError: center / gold.length,
    idSwitch: switches,
    lostCount: lost,
    falseAccept: fa,
    falseReject: fr,
    falseReacquire: null,
    correctReacquire: null,
    reacquireSeconds: null,
    otherPersonInCandidates: null,
    userRedesignate: null,
    counted: gold.length,
  };
}
