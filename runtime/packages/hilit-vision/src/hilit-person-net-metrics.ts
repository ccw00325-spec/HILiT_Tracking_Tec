/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·7c23e820 @license @preserve */
/* HilitPersonNet 평가·승격.

실사 holdout이 없으면 모든 실사 칸은 null이고 제품 승격은 BLOCKED다.
합성 점수를 실사 precision/recall로 옮기지 않는다.
아래 숫자는 달성값이 아니라 승격 목표다.
*/

import { detectionScores, trackingScores, type Box, type DetectionPred, type ReviewedTruth, type TrackPred } from './stage11-metrics';
import { boxIou, type PersonNetBox } from './hilit-person-net';
import { promotionGate, type Stage11Manifest } from './stage11-rights';
import type { ManifestGateResult } from './hilit-data-rights';

export const STAGE12_PROMOTION_TARGETS = {
  detectorPrecision: 0.9,
  detectorRecall: 0.9,
  reacquisitionPrecision: 0.98,
  falseReacquirePer10min: 0,
  userReselectMedianPer10min: 1,
  s24PreviewFps: 24,
  crashIn10min: 0,
} as const;

export interface PersonNetEvalRow {
  box: Box;
  score: number;
  small?: boolean;
  occluded?: boolean;
  edge?: boolean;
}

export interface SyntheticEvalReport {
  syntheticOnly: true;
  realWorldPrecision: null;
  realWorldRecall: null;
  productEligible: false;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ap50: number | null;
  smallPersonRecall: number | null;
  occlusionRecall: number | null;
  edgeRecall: number | null;
  falsePositivesPerMinute: number | null;
  medianInferenceMs: number | null;
  p95InferenceMs: number | null;
}

export interface RealWorldEvalReport {
  syntheticOnly: false;
  realWorldPrecision: number | null;
  realWorldRecall: number | null;
  realWorldF1: number | null;
  realWorldAp50: number | null;
  smallPersonRecall: number | null;
  occlusionRecall: number | null;
  falsePositivesPerMinute: number | null;
  medianInferenceMs: number | null;
  p95InferenceMs: number | null;
  idSwitch: number | null;
  falseReacquisition: number | null;
  timeToReacquire: number | null;
  trackCoverage: number | null;
  userReselectCount: number | null;
  otherPersonMix: number | null;
  productEligible: false;
  status: 'BLOCKED' | 'ok';
  reason: string;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function averagePrecision50(
  truth: readonly Box[],
  preds: readonly PersonNetEvalRow[],
): number {
  if (!truth.length) return 0;
  const sorted = [...preds].sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  let tp = 0;
  let fp = 0;
  const points: { rec: number; prec: number }[] = [];
  for (const pred of sorted) {
    let hit = -1;
    let best = 0;
    truth.forEach((box, i) => {
      if (used.has(i)) return;
      const ov = boxIou(pred.box, box);
      if (ov >= 0.5 && ov > best) {
        best = ov;
        hit = i;
      }
    });
    if (hit >= 0) {
      used.add(hit);
      tp += 1;
    } else {
      fp += 1;
    }
    points.push({ rec: tp / truth.length, prec: tp / (tp + fp) });
  }
  if (!points.length) return 0;
  let ap = 0;
  let prev = 0;
  for (const point of points) {
    ap += Math.max(0, point.rec - prev) * point.prec;
    prev = point.rec;
  }
  return ap;
}

export function subsetRecall(
  truth: readonly PersonNetEvalRow[],
  preds: readonly PersonNetEvalRow[],
  pick: (row: PersonNetEvalRow) => boolean,
): number | null {
  const gold = truth.filter(pick);
  if (!gold.length) return null;
  let hit = 0;
  for (const row of gold) {
    if (preds.some((pred) => boxIou(pred.box, row.box) >= 0.5)) hit += 1;
  }
  return hit / gold.length;
}

export function evaluateSyntheticDetections(input: {
  truth: PersonNetEvalRow[];
  preds: PersonNetEvalRow[];
  inferenceMs?: number[];
  durationMinutes?: number;
}): SyntheticEvalReport {
  let tp = 0;
  let fp = 0;
  const used = new Set<number>();
  for (const pred of input.preds) {
    let matched = false;
    input.truth.forEach((row, i) => {
      if (used.has(i) || matched) return;
      if (boxIou(pred.box, row.box) >= 0.5) {
        used.add(i);
        matched = true;
      }
    });
    if (matched) tp += 1;
    else fp += 1;
  }
  const fn = input.truth.length - tp;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = input.truth.length === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const times = [...(input.inferenceMs ?? [])].sort((a, b) => a - b);
  const minutes = input.durationMinutes ?? 0;
  return {
    syntheticOnly: true,
    realWorldPrecision: null,
    realWorldRecall: null,
    productEligible: false,
    precision,
    recall,
    f1,
    ap50: averagePrecision50(input.truth.map((r) => r.box), input.preds),
    smallPersonRecall: subsetRecall(input.truth, input.preds, (r) => r.small === true),
    occlusionRecall: subsetRecall(input.truth, input.preds, (r) => r.occluded === true),
    edgeRecall: subsetRecall(input.truth, input.preds, (r) => r.edge === true),
    falsePositivesPerMinute: minutes > 0 ? fp / minutes : null,
    medianInferenceMs: median(times),
    p95InferenceMs: percentile(times, 95),
  };
}

export function evaluateRealWorldOrBlock(input: {
  rights: ManifestGateResult;
  stage11?: Stage11Manifest;
  truth?: ReviewedTruth[];
  detections?: DetectionPred[];
  tracks?: TrackPred[];
  inferenceMs?: number[];
}): RealWorldEvalReport {
  const blocked = (reason: string): RealWorldEvalReport => ({
    syntheticOnly: false,
    realWorldPrecision: null,
    realWorldRecall: null,
    realWorldF1: null,
    realWorldAp50: null,
    smallPersonRecall: null,
    occlusionRecall: null,
    falsePositivesPerMinute: null,
    medianInferenceMs: null,
    p95InferenceMs: null,
    idSwitch: null,
    falseReacquisition: null,
    timeToReacquire: null,
    trackCoverage: null,
    userReselectCount: null,
    otherPersonMix: null,
    productEligible: false,
    status: 'BLOCKED',
    reason,
  });
  if (input.rights.status === 'BLOCKED' || input.rights.holdoutAssetCount === 0 || input.rights.admitted.length === 0) {
    return blocked('권리 확인 holdout이 없어 실사 성능과 제품 승격을 BLOCKED로 둡니다.');
  }
  const det = detectionScores(input.truth ?? [], input.detections ?? []);
  const track = trackingScores(input.truth ?? [], input.tracks ?? []);
  if (det.status === 'blocked' || track.status === 'blocked') {
    return blocked(det.reason || track.reason || '검수 정답이 없습니다.');
  }
  const times = [...(input.inferenceMs ?? [])].sort((a, b) => a - b);
  return {
    syntheticOnly: false,
    realWorldPrecision: det.precision,
    realWorldRecall: det.recall,
    realWorldF1: det.f1,
    realWorldAp50: null,
    smallPersonRecall: det.smallPersonRecall,
    occlusionRecall: det.occlusionRecall,
    falsePositivesPerMinute: null,
    medianInferenceMs: median(times),
    p95InferenceMs: percentile(times, 95),
    idSwitch: track.idSwitch,
    falseReacquisition: track.falseReacquire,
    timeToReacquire: track.reacquireSeconds,
    trackCoverage: track.holdRate,
    userReselectCount: track.userRedesignate,
    otherPersonMix: track.otherPersonInCandidates,
    productEligible: false,
    status: 'ok',
    reason: '실사 숫자는 계산했으나 이번 단계 승격 목표는 아직 닫혀 있습니다.',
  };
}

export function stage12Promotion(input: {
  rights: ManifestGateResult;
  real: RealWorldEvalReport;
  stage11?: Stage11Manifest;
}): {
  status: 'BLOCKED' | 'PASS';
  promoteDetector: false;
  promoteAutoReacquire: false;
  productEligible: false;
  reason: string;
  targets: typeof STAGE12_PROMOTION_TARGETS;
} {
  const stage11 = input.stage11 ? promotionGate(input.stage11) : null;
  const reason = input.real.status === 'BLOCKED'
    ? input.real.reason
    : (stage11 && !stage11.promoteDetector
      ? stage11.reason
      : '실사 holdout·승격 목표를 아직 통과하지 못했습니다.');
  return {
    status: 'BLOCKED',
    promoteDetector: false,
    promoteAutoReacquire: false,
    productEligible: false,
    reason,
    targets: STAGE12_PROMOTION_TARGETS,
  };
}
