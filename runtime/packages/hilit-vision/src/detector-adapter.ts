/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·cb886616 @license @preserve */
/* 공통 검출 어댑터. 후보는 같은 칸으로 나온다.

검출 점수를 신원 확률이나 정확도라고 적지 않는다.
모델을 프레임마다 다시 만들지 않는다. 실패해도 외부 AI로 넘기지 않는다.
*/

import { GRID_IN_H, GRID_IN_W } from './hilit-grid-net';
import { HilitPersonDetector, type DetectorProposal, type DetectorRun } from './hilit-person-detector';
import { HOG_MODEL_ID, HOG_MODEL_VERSION, proposeHogWindow, rgbaToGray255 } from './hilit-hog-window';
import { STAND_MODEL_ID, STAND_MODEL_VERSION } from './hilit-stand-energy';
import { filterRestoredBoxes, letterboxRgba, planPreprocess, restoreBox, type PreprocessMode } from './letterbox';
import { PERSONNET_IN_H, PERSONNET_IN_W, type PersonNetWeights } from './hilit-person-net';
import { runPersonNetDiagnose } from './hilit-person-net-runtime';

export type NamedDetectorId = 'product-all' | 'hilit-grid' | 'stand-energy' | 'hog-window' | 'hilit-personnet';

export interface AdapterBox {
  candidateId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  detectorScore?: number;
}

export interface DetectorEvidencePacket {
  videoId: string;
  subjectId: string | null;
  frameId: string;
  timestampSec: number;
  sourceWidth: number;
  sourceHeight: number;
  preprocess: ReturnType<typeof planPreprocess>;
  boxes: AdapterBox[];
  detectorScoreKind: 'model-score-not-identity';
  modelId: string | null;
  modelVersion: string | null;
  weightHash: string | null;
  timings: { preprocessMs: number; inferMs: number; postprocessMs: number; totalMs: number };
  outcome: DetectorRun['outcome'] | 'cancelled';
  qualityStatus: DetectorRun['qualityStatus'] | 'pipeline-check' | 'heuristic-only' | 'unavailable';
  reason: string | null;
}

export interface AdapterRequest {
  videoId: string;
  subjectId?: string | null;
  frameId: string;
  timestampSec: number;
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  detector: NamedDetectorId;
  personDetector?: HilitPersonDetector | null;
  personNetWeights?: PersonNetWeights | null;
  weightHash?: string | null;
  rightsManifestHash?: string | null;
  preprocessMode?: PreprocessMode;
  signal?: AbortSignal;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function hogProposalsOnAnalysis(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): DetectorProposal[] {
  const gray = rgbaToGray255(rgba, width, height);
  const raw = proposeHogWindow(gray, width, height, 8);
  return raw.map((box, i) => ({
    candidateId: `hog-window-${i + 1}`,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    detectorScore: box.score,
    source: 'hog-window' as const,
  }));
}

function toProposals(run: DetectorRun): AdapterBox[] {
  const out: AdapterBox[] = [];
  for (const p of run.proposals) {
    const clamped = filterRestoredBoxes([p], run.frameWidth, run.frameHeight)[0];
    if (!clamped) continue;
    out.push({
      candidateId: p.candidateId,
      x: clamped.x,
      y: clamped.y,
      width: clamped.width,
      height: clamped.height,
      detectorScore: p.detectorScore,
    });
  }
  return out;
}

function packetFromRun(
  req: AdapterRequest,
  run: DetectorRun,
  timings: DetectorEvidencePacket['timings'],
  preprocess: DetectorEvidencePacket['preprocess'],
): DetectorEvidencePacket {
  return {
    videoId: req.videoId,
    subjectId: req.subjectId ?? null,
    frameId: req.frameId,
    timestampSec: req.timestampSec,
    sourceWidth: req.width,
    sourceHeight: req.height,
    preprocess,
    boxes: toProposals(run),
    detectorScoreKind: 'model-score-not-identity',
    modelId: run.modelId,
    modelVersion: run.modelVersion,
    weightHash: req.weightHash ?? null,
    timings,
    outcome: run.outcome,
    qualityStatus: run.qualityStatus,
    reason: run.reason,
  };
}

export function runNamedDetector(req: AdapterRequest): DetectorEvidencePacket {
  const t0 = nowMs();
  const preprocess = planPreprocess(
    req.width,
    req.height,
    GRID_IN_W,
    GRID_IN_H,
    req.preprocessMode ?? 'stretch',
  );
  if (req.signal?.aborted) {
    return {
      videoId: req.videoId,
      subjectId: req.subjectId ?? null,
      frameId: req.frameId,
      timestampSec: req.timestampSec,
      sourceWidth: req.width,
      sourceHeight: req.height,
      preprocess,
      boxes: [],
      detectorScoreKind: 'model-score-not-identity',
      modelId: null,
      modelVersion: null,
      weightHash: req.weightHash ?? null,
      timings: { preprocessMs: 0, inferMs: 0, postprocessMs: 0, totalMs: 0 },
      outcome: 'error',
      qualityStatus: 'unavailable',
      reason: 'cancelled',
    };
  }
  const t1 = nowMs();
  if (req.detector === 'hilit-personnet') {
    const personNet = runPersonNetDiagnose({
      rgba: req.rgba,
      width: req.width,
      height: req.height,
      weights: req.personNetWeights ?? null,
      mode: 'diagnose',
      frameTimestamp: req.timestampSec,
      rightsManifestHash: req.rightsManifestHash ?? req.weightHash ?? null,
    });
    const boxes: AdapterBox[] = personNet.boxes.map((box, i) => ({
      candidateId: `hilit-personnet-${i + 1}`,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      detectorScore: box.score,
    }));
    return {
      videoId: req.videoId,
      subjectId: req.subjectId ?? null,
      frameId: req.frameId,
      timestampSec: req.timestampSec,
      sourceWidth: req.width,
      sourceHeight: req.height,
      preprocess: planPreprocess(req.width, req.height, PERSONNET_IN_W, PERSONNET_IN_H, 'letterbox'),
      boxes,
      detectorScoreKind: 'model-score-not-identity',
      modelId: personNet.modelId,
      modelVersion: personNet.modelVersion,
      weightHash: req.weightHash ?? null,
      timings: { preprocessMs: t1 - t0, inferMs: personNet.inferenceMs, postprocessMs: 0, totalMs: nowMs() - t0 },
      outcome: personNet.candidateState === 'detector_absent' ? 'unavailable' : (boxes.length ? 'ok' : 'empty'),
      qualityStatus: personNet.candidateState === 'detector_absent' ? 'unavailable' : 'pipeline-check',
      reason: personNet.reason,
    };
  }
  if (req.detector === 'hog-window') {
    const analysisRgba = letterboxRgba(req.rgba, preprocess);
    const t2 = nowMs();
    const raw = hogProposalsOnAnalysis(analysisRgba, preprocess.analysisWidth, preprocess.analysisHeight);
    const t3 = nowMs();
    const boxes: AdapterBox[] = [];
    for (const p of raw) {
      const restored = restoreBox(p, preprocess);
      const clamped = filterRestoredBoxes([restored], req.width, req.height)[0];
      if (!clamped) continue;
      boxes.push({
        candidateId: p.candidateId,
        x: clamped.x,
        y: clamped.y,
        width: clamped.width,
        height: clamped.height,
        detectorScore: p.detectorScore,
      });
    }
    const timings = {
      preprocessMs: t2 - t0,
      inferMs: t3 - t2,
      postprocessMs: nowMs() - t3,
      totalMs: nowMs() - t0,
    };
    return {
      videoId: req.videoId,
      subjectId: req.subjectId ?? null,
      frameId: req.frameId,
      timestampSec: req.timestampSec,
      sourceWidth: req.width,
      sourceHeight: req.height,
      preprocess,
      boxes,
      detectorScoreKind: 'model-score-not-identity',
      modelId: HOG_MODEL_ID,
      modelVersion: HOG_MODEL_VERSION,
      weightHash: null,
      timings,
      outcome: boxes.length ? 'ok' : 'empty',
      qualityStatus: 'heuristic-only',
      reason: null,
    };
  }

  const det = req.personDetector;
  if (!det) {
    return {
      videoId: req.videoId,
      subjectId: req.subjectId ?? null,
      frameId: req.frameId,
      timestampSec: req.timestampSec,
      sourceWidth: req.width,
      sourceHeight: req.height,
      preprocess,
      boxes: [],
      detectorScoreKind: 'model-score-not-identity',
      modelId: null,
      modelVersion: null,
      weightHash: req.weightHash ?? null,
      timings: { preprocessMs: t1 - t0, inferMs: 0, postprocessMs: 0, totalMs: nowMs() - t0 },
      outcome: 'unavailable',
      qualityStatus: 'unavailable',
      reason: 'detector-missing',
    };
  }
  const sources = req.detector === 'hilit-grid' ? 'grid' : req.detector === 'stand-energy' ? 'stand' : 'all';
  const t2 = nowMs();
  const run = det.proposeRgba(req.rgba, req.width, req.height, req.timestampSec, {
    sources,
    signal: req.signal,
  });
  const t3 = nowMs();
  if (req.detector === 'stand-energy') {
    run.modelId = STAND_MODEL_ID;
    run.modelVersion = STAND_MODEL_VERSION;
    run.qualityStatus = 'heuristic-only';
  }
  const timings = {
    preprocessMs: t1 - t0,
    inferMs: t3 - t2,
    postprocessMs: nowMs() - t3,
    totalMs: nowMs() - t0,
  };
  return packetFromRun(req, run, timings, preprocess);
}

export { restoreBox, planPreprocess };
