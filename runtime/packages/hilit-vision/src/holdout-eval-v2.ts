/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d10f7a31 @license @preserve */
/* 실검출 기반 holdout 평가기 (v2). 진단 전용이다.

v1(holdout-sports-eval.ts)과 무엇이 다른가.

1. 후보를 정답 상자로 채우지 않는다. 실제 검출기 출력만 후보가 된다.
2. 예측기에 정답 상자를 넣지 않는다. 지금 붙들고 있는 트랙에 맞는 검출을 넣는다.
3. 정답은 기록할 때만 쓴다. 판단 경로에는 들어가지 않는다.
   예외는 첫 프레임의 대상 지정 하나다. 이것은 사용자의 선택을 대신하는 것이지
   매 프레임의 정답 주입이 아니다.
4. 후보마다 자기 descriptor 를 만든다. v1 은 모든 후보에 같은 값을 넘겼다.
5. Re-ID 스케줄러를 프레임마다 한 번만 부른다. v1 은 후보 루프 안에서 불러
   후보 순서에 따라 결과가 달라졌다.
6. 갤러리는 확정 상태에서만 갱신한다. 정답 id 를 보고 넣지 않는다.
7. 해시 중복 제거가 실제로 후보를 지운다. 그 때문에 정답 후보가 사라진 비율도 센다.
8. 최고 점수 후보를 무조건 고르지 않는다. 절대 점수·1·2위 차·시간·실관측 수를
   모두 통과해야 확정한다. 자동 확정은 기본 꺼짐이다.

여기서 나오는 수치는 합성 진단이다. 실사 스포츠 수율이 아니다.
*/

import { TrackRegionPredictor } from './track-region-prediction';
import { predictionGate } from './prediction-identity-firewall';
import { mahalanobis2d } from './spatial-quality';
import { fuseAppearanceSpace, spatialCuesFromBoxes, assessSpatialQuality } from './space-appearance-fusion';
import { ReidScheduler } from './reid-scheduler';
import { AppearanceGallery } from './appearance-gallery';
import { describe, similarity, type Descriptor } from './appearance';
import { averageHash64, isNearDuplicate } from './perceptual-hash';
import { kReciprocalRerank, shouldNeighborRerank, type RerankSample } from './k-reciprocal-rerank';
import { sportSoftProfile, type SportId } from './sport-soft-profile';
import { boxIou } from './hilit-grid-net';
import { TrackletStore } from './tracklets';
import {
  ReacquireConfirmer, REACQUIRE_CONFIRM_POLICY, type ConfirmDecision,
} from './reacquire-confirmation';
import {
  computeReacquireEvents, type ReacquireFrameLog, type ReacquireEventMetrics,
} from './reacquire-event-metrics';
import {
  HOLDOUT_W, HOLDOUT_H, HOLDOUT_FPS, type HoldoutClip, type HoldoutFrame,
} from './holdout-sports-eval';

export interface DetectorLike {
  proposeRgba(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    timestamp?: number,
    options?: {
      sliced?: boolean;
      forceSlice?: boolean;
      focus?: { x: number; y: number; width: number; height: number } | null;
      subjectHeight?: number | null;
      maxSlices?: number;
      scoreMin?: number;
    },
  ): {
    proposals: Array<{
      candidateId: string; x: number; y: number; width: number; height: number;
      detectorScore: number; source: string;
    }>;
    sliceCount?: number;
  };
}

export interface EvalV2Options {
  /* 확정 정책 — 전부 calibration 전 초기 가설값이다. */
  autoConfirm: boolean;
  absoluteScoreMin: number;
  top1Top2Margin: number;
  minObservations: number;
  minConfirmSec: number;
  minConfirmSecHard: number;
  /* 기능 축 */
  hsv: 'off' | 'aux' | 'penalty';
  jaccard: boolean;
  hashDedup: boolean;
  mahalanobis: boolean;
  dynamicWeights: boolean;
  gmc: boolean;
  selectiveReid: boolean;
  galleryUpdate: boolean;
  /** 위험 구간에서만 조각 검출을 부른다. */
  slicedOnRisk: boolean;
  sportProfile: boolean;
  /** 후보 순서 민감도 확인용. 결과가 바뀌면 순서 의존이 남아 있다는 뜻이다. */
  candidateOrder: 'score' | 'reverse';
}

export const EVAL_V2_DEFAULTS: Readonly<EvalV2Options> = Object.freeze({
  autoConfirm: false,
  absoluteScoreMin: REACQUIRE_CONFIRM_POLICY.absoluteScoreMin,
  top1Top2Margin: REACQUIRE_CONFIRM_POLICY.top1Top2Margin,
  minObservations: REACQUIRE_CONFIRM_POLICY.minObservations,
  minConfirmSec: REACQUIRE_CONFIRM_POLICY.minConfirmSec,
  minConfirmSecHard: REACQUIRE_CONFIRM_POLICY.minConfirmSecHard,
  hsv: 'aux',
  jaccard: true,
  hashDedup: true,
  mahalanobis: true,
  dynamicWeights: true,
  gmc: true,
  selectiveReid: true,
  galleryUpdate: true,
  slicedOnRisk: true,
  sportProfile: true,
  candidateOrder: 'score',
});

export interface EvalV2Result {
  sport: SportId;
  seed: number;
  kind: 'synthetic-holdout-v2';
  qualityClaim: false;
  note: 'synthetic-not-real-sports';
  frames: number;
  /** 첫 프레임에서 대상을 지정할 수 있었는가. 못 하면 나머지는 의미가 없다. */
  anchored: boolean;
  anchorFrame: number | null;

  /* 후보 생성 */
  candidateGenerationRecall: number | null;
  candidateGenerationFraction: [number, number];
  candidateRankingRecallAt1: number | null;
  candidateRankingRecallAt2: number | null;
  candidateRankingRecallAt3: number | null;
  candidateRankingFraction: [number, number];
  detectorMissFrames: number;

  /* 조각 검출 */
  slicedCalls: number;
  slicedDuplicateCandidates: number;

  /* 해시 중복 제거 */
  hashRemovedCandidates: number;
  hashRemovedTruthCandidates: number;

  /* Re-ID 실행 증거 */
  descriptorComputations: number;
  schedulerDecideCalls: number;
  schedulerExpensiveExtracts: number;
  hsvComparisons: number;
  jaccardGateCalls: number;
  jaccardGateReasons: Record<string, number>;
  jaccardRuns: number;
  jaccardImprovedTruthRank: number;
  jaccardWorsenedTruthRank: number;

  /* 갤러리 */
  galleryAccepted: number;
  galleryRejected: number;
  gallerySizeFinal: number;

  /* 추적 품질 */
  visibleFrames: number;
  visibleAssignedCorrect: number;
  visibleAccuracy: number | null;
  meanIou: number | null;

  /* 확정 상태 */
  stateCounts: Record<string, number>;
  blockReasonCounts: Record<string, number>;

  /* 사건 단위 재획득 */
  reacquire: ReacquireEventMetrics;

  elapsedMs: number;
}

const PLANE = HOLDOUT_W * HOLDOUT_H;

function rgbaOf(frame: HoldoutFrame): Uint8ClampedArray {
  const out = new Uint8ClampedArray(PLANE * 4);
  for (let i = 0; i < PLANE; i += 1) {
    out[i * 4] = Math.max(0, Math.min(255, frame.rgb[i] * 255));
    out[i * 4 + 1] = Math.max(0, Math.min(255, frame.rgb[PLANE + i] * 255));
    out[i * 4 + 2] = Math.max(0, Math.min(255, frame.rgb[2 * PLANE + i] * 255));
    out[i * 4 + 3] = 255;
  }
  return out;
}

function cropOf(frame: HoldoutFrame, box: Box): { values: Uint8Array; w: number; h: number } | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(HOLDOUT_W, Math.ceil(box.x + box.width));
  const y1 = Math.min(HOLDOUT_H, Math.ceil(box.y + box.height));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const values = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = (y0 + y) * HOLDOUT_W + (x0 + x);
      const di = (y * w + x) * 3;
      values[di] = Math.max(0, Math.min(255, frame.rgb[si] * 255));
      values[di + 1] = Math.max(0, Math.min(255, frame.rgb[PLANE + si] * 255));
      values[di + 2] = Math.max(0, Math.min(255, frame.rgb[2 * PLANE + si] * 255));
    }
  }
  return { values, w, h };
}

interface Box { x: number; y: number; width: number; height: number }

interface Cand {
  id: string;
  box: Box;
  detectorScore: number;
  fromSlice: boolean;
  duplicateSlice: boolean;
  desc: Descriptor | null;
  hash: bigint | null;
  score: number;
  /** 이 프레임 안에서의 검출기 순번. 프레임을 넘으면 의미가 없다. */
  detectorId?: string;
  /** 기록 전용. 이 후보가 정답 대상과 겹치는가. 판단에 쓰지 않는다. */
  isTruthForLog: boolean;
}

function bump(m: Record<string, number>, k: string): void { m[k] = (m[k] || 0) + 1; }

/**
 * 한 클립을 실검출로 평가한다.
 *
 * 정답 상자는 (a) 첫 프레임의 대상 지정과 (b) 기록·채점에만 쓴다.
 * 후보 생성·점수·확정 판단에는 들어가지 않는다.
 */
export function runHoldoutV2(
  clip: HoldoutClip,
  detector: DetectorLike,
  opts: Partial<EvalV2Options> = {},
): EvalV2Result {
  const o: EvalV2Options = { ...EVAL_V2_DEFAULTS, ...opts };
  const started = Date.now();
  const profile = sportSoftProfile(clip.sport);
  const predictor = new TrackRegionPredictor();
  const tracklets = new TrackletStore();
  const scheduler = new ReidScheduler({ mode: o.selectiveReid ? 'selective' : 'fixed-period' });
  const gallery = new AppearanceGallery({
    ownerId: 'holdout-v2', videoId: clip.sport, subjectId: 'subject',
    runId: `v2-${clip.sport}`,
  });
  const confirmer = new ReacquireConfirmer('subject', {
    autoConfirm: o.autoConfirm,
    absoluteScoreMin: o.absoluteScoreMin,
    top1Top2Margin: o.top1Top2Margin,
    minObservations: o.minObservations,
    minConfirmSec: o.minConfirmSec,
    minConfirmSecHard: o.minConfirmSecHard,
  });

  const counters = {
    candGenHit: 0, candGenN: 0,
    rankHit1: 0, rankHit2: 0, rankHit3: 0, rankN: 0,
    detectorMiss: 0,
    slicedCalls: 0, slicedDup: 0,
    hashRemoved: 0, hashRemovedTruth: 0,
    describeCalls: 0, schedulerCalls: 0, hsvComparisons: 0,
    jaccardGate: 0, jaccardRuns: 0, jaccardBetter: 0, jaccardWorse: 0,
    galleryAccepted: 0, galleryRejected: 0,
    visibleFrames: 0, visibleCorrect: 0, iouSum: 0, iouN: 0,
  };
  const jaccardGateReasons: Record<string, number> = {};
  const stateCounts: Record<string, number> = {};
  const blockReasonCounts: Record<string, number> = {};
  const log: ReacquireFrameLog[] = [];

  const detect = (frame: HoldoutFrame, focus: Box | null, sliced: boolean): Cand[] => {
    const rgba = rgbaOf(frame);
    const run = detector.proposeRgba(rgba, HOLDOUT_W, HOLDOUT_H, frame.tSec * 1000,
      sliced ? { sliced: true, forceSlice: true, focus, maxSlices: 3 } : {});
    if (sliced) counters.slicedCalls += 1;
    return run.proposals.map((p) => ({
      id: p.candidateId,
      box: { x: p.x, y: p.y, width: p.width, height: p.height },
      detectorScore: p.detectorScore,
      fromSlice: sliced,
      duplicateSlice: false,
      desc: null, hash: null, score: 0, isTruthForLog: false,
    }));
  };

  /* --- 대상 지정: 사용자의 클릭을 대신한다. 매 프레임 정답 주입이 아니다. --- */
  let anchorFrame: number | null = null;
  let anchor: Descriptor | null = null;
  let assigned: Box | null = null;
  for (const f of clip.frames) {
    if (!f.truth || !f.onScreen || f.occluded) continue;
    const cands = detect(f, null, false);
    const gt = { x: f.truth.x, y: f.truth.y, width: f.truth.width, height: f.truth.height };
    let best: Cand | null = null;
    let bestIou = 0;
    for (const c of cands) {
      const iou = boxIou(c.box, gt);
      if (iou > bestIou) { bestIou = iou; best = c; }
    }
    if (best && bestIou >= 0.5) {
      anchorFrame = f.index;
      assigned = best.box;
      const crop = cropOf(f, best.box);
      if (crop) {
        counters.describeCalls += 1;
        anchor = describe(crop.values, crop.w, crop.h);
        predictor.start(best.box, f.tSec);
        gallery.rememberUserAnchor({
          tSec: f.tSec, trackId: 'subject', quality: 0.9, visibility: [true, true, true],
          box: best.box, overlapOthers: false, cameraOk: true, gmcOk: true,
          descriptor: anchor, view: 'unknown',
        });
      }
      break;
    }
  }

  if (anchorFrame == null || !anchor || !assigned) {
    return emptyV2(clip, Date.now() - started);
  }

  let lastBox: Box = assigned;
  let assignedIsSubject = true;
  let lastConfirmedTSec: number | null = clip.frames[anchorFrame].tSec;
  let consecutiveMiss = 0;
  /* 직전 프레임이 끝날 때 만든 다음 프레임 예측. 인과 순서를 지키기 위해 들고 간다. */
  let pred = predictor.observe({
    tSec: clip.frames[anchorFrame].tSec,
    center: null, box: assigned, detectionConfidence: 0.8, occlusion: 'visible',
    frame: { width: HOLDOUT_W, height: HOLDOUT_H },
  }, { horizonSec: 1 / HOLDOUT_FPS });
  /* 직전 프레임에서 대상을 실제로 붙들고 있었는가. 재획득인지 연속 추적인지 가른다. */
  let heldLastFrame = true;
  const galleryHashes: bigint[] = [];
  const pastSamples: RerankSample[] = [
    { id: 'anchor', descriptor: anchor, source: 'user_anchor', trackId: 'subject', tSec: clip.frames[anchorFrame].tSec },
  ];

  for (const frame of clip.frames) {
    if (frame.index <= anchorFrame) continue;
    const gt = frame.truth && frame.onScreen && !frame.occluded
      ? { x: frame.truth.x, y: frame.truth.y, width: frame.truth.width, height: frame.truth.height }
      : null;

    /* --- 1. 위험 판단: 이전 상태만 본다. 정답을 보지 않는다. --- */
    const risky = consecutiveMiss > 0
      || confirmer.currentState === 'OCCLUDED'
      || confirmer.currentState === 'LOST'
      || confirmer.currentState === 'WARNING'
      || lastBox.height < 24;

    /* --- 2. 검출 --- */
    let cands = detect(frame, null, false);
    if (o.slicedOnRisk && risky) {
      const sliceCands = detect(frame, lastBox, true);
      for (const s of sliceCands) {
        const dup = cands.some((c) => boxIou(c.box, s.box) >= 0.55
          && Math.abs(c.box.height - s.box.height) / Math.max(1, c.box.height) < 0.35);
        if (dup) { s.duplicateSlice = true; counters.slicedDup += 1; continue; }
        cands.push(s);
      }
    }

    /* --- 3. 결정론적 정렬. 후보 순서 의존을 없앤다. --- */
    cands.sort((a, b) => (b.detectorScore - a.detectorScore)
      || (a.box.x - b.box.x) || (a.box.y - b.box.y) || a.id.localeCompare(b.id));
    if (o.candidateOrder === 'reverse') cands.reverse();

    /* --- 3b. 프레임을 넘어 살아남는 후보 번호를 붙인다.
       검출기 후보 id 는 그 프레임 안에서의 순번이라 프레임마다 바뀐다.
       그 번호로는 "같은 후보를 여러 프레임에서 봤다" 를 셀 수 없다. --- */
    const tkIds = tracklets.update({ t: frame.tSec, detections: cands.map((c) => c.box) });
    cands.forEach((c, i) => { c.detectorId = c.id; c.id = `tk-${tkIds[i]}`; });

    /* 기록용 표시. 판단에 쓰지 않는다. */
    if (gt) for (const c of cands) c.isTruthForLog = boxIou(c.box, gt) >= 0.5;

    if (gt) {
      counters.candGenN += 1;
      if (cands.some((c) => c.isTruthForLog)) counters.candGenHit += 1;
      else counters.detectorMiss += 1;
    }

    /* --- 4. 이 프레임의 점수는 직전 프레임이 만든 예측으로 매긴다.
       예측기 갱신은 결합이 끝난 뒤에 한다. 정답은 어느 쪽에도 들어가지 않는다. --- */
    const cov = predictor.spatialCovariance();

    /* --- 5. 해시 중복 제거: 실제로 후보를 지운다. --- */
    if (o.hashDedup) {
      const kept: Cand[] = [];
      const seen: bigint[] = [];
      for (const c of cands) {
        const crop = cropOf(frame, c.box);
        c.hash = crop ? averageHash64(crop.values, crop.w, crop.h, false) : null;
        if (c.hash != null && seen.some((h) => isNearDuplicate(h, c.hash as bigint))) {
          counters.hashRemoved += 1;
          if (c.isTruthForLog) counters.hashRemovedTruth += 1;
          continue;
        }
        if (c.hash != null) seen.push(c.hash);
        kept.push(c);
      }
      cands = kept;
    }

    /* --- 6. 스케줄러는 프레임당 한 번만 부른다. --- */
    counters.schedulerCalls += 1;
    const decision = scheduler.decide({
      videoTSec: frame.tSec,
      box: lastBox,
      visibleRatio: heldLastFrame ? 0.9 : 0.05,
      cropValid: true,
      occluded: !heldLastFrame,
      blurSevere: clip.spec.blur && lastBox.height < 20,
      rivalNearby: cands.length > 1,
      rankCompetition: cands.length > 1,
      candidateCount: cands.length,
      gallerySampleCount: gallery.userCount + gallery.currentCount,
      userConfirm: false,
      reentryAfterOcclusion: confirmer.currentState === 'OCCLUDED' || confirmer.currentState === 'LOST',
      predictionResidualBodies: cov ? Math.sqrt(cov.stdX ** 2 + cov.stdY ** 2) / Math.max(1, lastBox.height) : null,
    });
    const extractNow = o.hsv !== 'off' && (decision.extract || !o.selectiveReid);

    /* --- 7. 후보별 점수 --- */
    const px = pred.box ? pred.box.x + pred.box.width / 2 : lastBox.x + lastBox.width / 2;
    const py = pred.box ? pred.box.y + pred.box.height / 2 : lastBox.y + lastBox.height / 2;
    const quality = assessSpatialQuality({
      camera: {
        status: o.gmc ? 'ok' : 'absent', usable: o.gmc, quality: o.gmc ? 0.7 : 0,
        backgroundShare: 0.6, featureSupport: o.gmc,
      },
      covariance: cov,
      predictionUsable: pred.box != null,
      sceneCut: false,
      lastObservationQuality: null,
    });

    const scored: Cand[] = [];
    for (const c of cands) {
      const gate = predictionGate(pred, c.box);
      if (gate.verdict === 'reject') continue;
      const cx = c.box.x + c.box.width / 2;
      const cy = c.box.y + c.box.height / 2;
      const d2 = o.mahalanobis && cov
        ? mahalanobis2d({
          ex: cx - px, ey: cy - py,
          stdX: cov.stdX * (o.sportProfile ? profile.processNoiseScale : 1),
          stdY: cov.stdY,
        }).d2
        : null;
      /* 공간 제약은 기본적으로 감점이다. 물리적으로 불가능할 때만 잘라낸다. */
      if (o.mahalanobis && d2 != null && d2 > 64) continue;

      let appearance: number | null = null;
      if (extractNow) {
        const crop = cropOf(frame, c.box);
        if (crop) {
          counters.describeCalls += 1;
          c.desc = describe(crop.values, crop.w, crop.h);
          appearance = similarity(anchor, c.desc);
          counters.hsvComparisons += 1;
          if (decision.extract) scheduler.noteExtract(0.4);
        }
      }
      if (o.hsv === 'penalty' && appearance != null && appearance < 0.45) appearance = Math.max(0, appearance - 0.2);

      const fused = o.dynamicWeights && appearance != null
        ? fuseAppearanceSpace({
          appearance,
          appearanceObserved: true,
          space: spatialCuesFromBoxes({
            predCx: px, predCy: py, candCx: cx, candCy: cy,
            predW: lastBox.width, predH: lastBox.height, candW: c.box.width, candH: c.box.height,
            d2, inflatedCovariance: consecutiveMiss > 2, dtSec: 1 / HOLDOUT_FPS,
            cameraDx: o.gmc ? frame.cameraDx : 0, cameraDy: o.gmc ? frame.cameraDy : 0,
            prevCx: lastBox.x + lastBox.width / 2, prevCy: lastBox.y + lastBox.height / 2,
            turning: clip.sport === 'skating', zoomLikely: clip.spec.zoom,
            exitEntryPlausible: true,
          }),
          quality,
          mode: 'weighted',
        })
        : null;
      c.score = fused?.sRank ?? appearance ?? Math.max(0, 1 - Math.hypot(cx - px, cy - py) / 80);
      scored.push(c);
    }
    scored.sort((a, b) => b.score - a.score);

    /* 후보 순위 recall */
    if (gt && scored.length) {
      counters.rankN += 1;
      const idx = scored.findIndex((c) => c.isTruthForLog);
      if (idx === 0) counters.rankHit1 += 1;
      if (idx >= 0 && idx < 2) counters.rankHit2 += 1;
      if (idx >= 0 && idx < 3) counters.rankHit3 += 1;
    }

    /* --- 8. Jaccard 재순위: 갤러리가 실제로 3개 이상일 때만, 후보별 자기 descriptor 로 --- */
    if (o.jaccard && scored.length >= 2 && scored.every((c) => c.desc != null)) {
      const gal = pastSamples.slice(0, 8);
      counters.jaccardGate += 1;
      const gateResult = shouldNeighborRerank({
        scores: scored.map((c) => c.score),
        galleryCount: gal.length,
        distinctGallery: gal.length,
        candidateCount: scored.length,
      });
      bump(jaccardGateReasons, gateResult.reason);
      if (gateResult.run) {
        const beforeIdx = scored.findIndex((c) => c.isTruthForLog);
        const ranked = kReciprocalRerank({
          gallery: gal,
          candidates: scored.map((c) => ({
            id: c.id, descriptor: c.desc as Descriptor, directScore: c.score, hash: c.hash,
          })),
        });
        if (!ranked.usedFallback) {
          counters.jaccardRuns += 1;
          for (const c of scored) {
            const row = ranked.rows.find((r) => r.id === c.id);
            if (row) c.score = row.blended;
          }
          scored.sort((a, b) => b.score - a.score);
          const afterIdx = scored.findIndex((c) => c.isTruthForLog);
          if (beforeIdx >= 0 && afterIdx >= 0) {
            if (afterIdx < beforeIdx) counters.jaccardBetter += 1;
            if (afterIdx > beforeIdx) counters.jaccardWorse += 1;
          }
        }
      }
    }

    /* --- 9. 결합과 확정.

       연속 추적과 재획득을 다르게 다룬다. 직전 프레임에 대상을 붙들고 있었으면
       (heldLastFrame) 최고 점수 후보를 그대로 잇는다. 끊겼다가 다시 붙는
       경우에만 확정 절차가 개입한다. 확정 절차는 "다른 사람으로 갈아타는 것"
       을 막는 장치이지 매 프레임 결합을 막는 장치가 아니다. --- */
    const top = scored[0] ?? null;
    const justLost = heldLastFrame;
    /* 연속 추적에서 요구하는 최소 겹침. 이것만으로 동일인을 주장하지 않는다. */
    const continuityOk = top != null && pred.box != null
      ? boxIou(top.box, pred.box) >= 0.15 || boxIou(top.box, lastBox) >= 0.2
      : top != null;

    const hardScene = cands.length > 3 || clip.spec.similarUniform || !heldLastFrame;
    let assignedBox: Box | null = null;
    let verdict: ConfirmDecision;

    if (heldLastFrame && top && continuityOk) {
      /* 연속 추적: 확정 상태를 유지한다. 후보 검증 절차를 새로 열지 않는다. */
      confirmer.markTracked();
      verdict = {
        state: 'TRACKED', confirmedId: null, tentativeId: null, blocked: [],
        observations: 0, elapsedSec: 0, mayUpdateConfirmedAssets: true,
        scoreIsRankingEvidence: true,
      };
      assignedBox = top.box;
      consecutiveMiss = 0;
    } else {
      /* 재획득 경로. markLost 는 끊긴 순간에만 부른다.
         매 프레임 부르면 검증 중인 후보가 초기화되어 관측 수가 쌓이지 않는다. */
      if (justLost) confirmer.markLost(consecutiveMiss > 3 ? 'LOST' : 'OCCLUDED');
      verdict = confirmer.offer(
        scored.map((c) => ({
          id: c.id, score: c.score, duplicateSlice: c.duplicateSlice, predictionOnly: false,
        })),
        {
          tSec: frame.tSec,
          observable: top != null,
          hardScene,
          spatiallyPlausible: top != null,
          evidenceCollapsed: top == null && consecutiveMiss > 5,
          lastConfirmedTSec,
        },
      );
      if (verdict.state === 'CONFIRMED') {
        assignedBox = scored.find((c) => c.id === verdict.confirmedId)?.box ?? top?.box ?? null;
      }
      consecutiveMiss = assignedBox ? 0 : consecutiveMiss + 1;
    }
    bump(stateCounts, verdict.state);
    for (const b of verdict.blocked) bump(blockReasonCounts, b);

    /* --- 10. 상자 갱신. 확정하지 못하면 예측만 이어간다. --- */
    if (assignedBox) {
      lastBox = assignedBox;
      lastConfirmedTSec = frame.tSec;
      heldLastFrame = true;
    } else {
      heldLastFrame = false;
      if (pred.box) lastBox = { x: pred.box.x, y: pred.box.y, width: pred.box.width, height: pred.box.height };
    }

    /* --- 10b. 예측기 갱신은 결합이 끝난 뒤에. 다음 프레임 예측을 만든다. --- */
    pred = predictor.observe({
      tSec: frame.tSec,
      center: null,
      box: assignedBox,
      detectionConfidence: assignedBox && top ? top.detectorScore : null,
      occlusion: assignedBox ? 'visible' : 'unknown',
      frame: { width: HOLDOUT_W, height: HOLDOUT_H },
    }, { horizonSec: 1 / HOLDOUT_FPS });

    /* --- 11. 채점: 여기서만 정답을 쓴다. --- */
    let logAssigned: string | null = null;
    if (assignedBox) {
      const iou = gt ? boxIou(assignedBox, gt) : 0;
      assignedIsSubject = iou >= 0.5;
      logAssigned = assignedIsSubject ? 'subject' : 'other';
      if (gt) {
        counters.visibleFrames += 1;
        counters.iouSum += iou;
        counters.iouN += 1;
        if (assignedIsSubject) counters.visibleCorrect += 1;
      }
    } else if (gt) {
      counters.visibleFrames += 1;
    }
    log.push({
      tSec: frame.tSec,
      observable: gt != null,
      truthId: gt != null ? 'subject' : null,
      assignedId: logAssigned,
      heldDecision: verdict.state === 'USER_REVIEW' || verdict.state === 'TENTATIVE'
        || verdict.state === 'CANDIDATE',
    });

    /* --- 12. 갤러리: 확정 자산은 확정 상태에서만 건드린다. --- */
    if (o.galleryUpdate && assignedBox && assignedIsSubject
      && (verdict.mayUpdateConfirmedAssets || confirmer.currentState === 'TRACKED')
    ) {
      const crop = cropOf(frame, assignedBox);
      if (crop) {
        counters.describeCalls += 1;
        const d = describe(crop.values, crop.w, crop.h);
        const hash = averageHash64(crop.values, crop.w, crop.h, false);
        /* 오염 위험은 "후보가 많다" 가 아니라 "다른 사람 상자가 실제로 겹친다"
           로 판단한다. 검출기가 프레임마다 열 개 넘게 내놓는 상황에서 개수로
           재면 항상 참이 되어 갤러리가 영영 자라지 못한다. */
        const overlapping = cands.some((c) => c.box !== assignedBox
          && boxIou(c.box, assignedBox as Box) > 0.2);
        const res = gallery.observe({
          tSec: frame.tSec, trackId: 'subject', quality: 0.8,
          visibility: [true, true, true], box: assignedBox,
          overlapOthers: overlapping, cameraOk: true, gmcOk: o.gmc,
          descriptor: d, trackingLost: false, crossing: overlapping,
          appearanceJump: false, trajectoryBreak: false,
          knownOtherConflict: false, rivalSimilarity: null,
        });
        if (res.stored) {
          counters.galleryAccepted += 1;
          const dupe = hash != null && galleryHashes.some((h) => isNearDuplicate(h, hash));
          if (!dupe && pastSamples.length < 8) {
            if (hash != null) galleryHashes.push(hash);
            pastSamples.push({
              id: `g-${frame.index}`, descriptor: d, source: 'verified_auto',
              trackId: 'subject', tSec: frame.tSec, hash,
            });
          }
        } else counters.galleryRejected += 1;
      }
    }
  }

  const reacquire = computeReacquireEvents(log, 2);
  return {
    sport: clip.sport, seed: clip.seed, kind: 'synthetic-holdout-v2',
    qualityClaim: false, note: 'synthetic-not-real-sports',
    frames: clip.frames.length, anchored: true, anchorFrame,
    candidateGenerationRecall: counters.candGenN ? Number((counters.candGenHit / counters.candGenN).toFixed(4)) : null,
    candidateGenerationFraction: [counters.candGenHit, counters.candGenN],
    candidateRankingRecallAt1: counters.rankN ? Number((counters.rankHit1 / counters.rankN).toFixed(4)) : null,
    candidateRankingRecallAt2: counters.rankN ? Number((counters.rankHit2 / counters.rankN).toFixed(4)) : null,
    candidateRankingRecallAt3: counters.rankN ? Number((counters.rankHit3 / counters.rankN).toFixed(4)) : null,
    candidateRankingFraction: [counters.rankHit1, counters.rankN],
    detectorMissFrames: counters.detectorMiss,
    slicedCalls: counters.slicedCalls,
    slicedDuplicateCandidates: counters.slicedDup,
    hashRemovedCandidates: counters.hashRemoved,
    hashRemovedTruthCandidates: counters.hashRemovedTruth,
    descriptorComputations: counters.describeCalls,
    schedulerDecideCalls: counters.schedulerCalls,
    schedulerExpensiveExtracts: scheduler.metrics().expensiveExtracts,
    hsvComparisons: counters.hsvComparisons,
    jaccardGateCalls: counters.jaccardGate,
    jaccardGateReasons,
    jaccardRuns: counters.jaccardRuns,
    jaccardImprovedTruthRank: counters.jaccardBetter,
    jaccardWorsenedTruthRank: counters.jaccardWorse,
    galleryAccepted: counters.galleryAccepted,
    galleryRejected: counters.galleryRejected,
    gallerySizeFinal: pastSamples.length,
    visibleFrames: counters.visibleFrames,
    visibleAssignedCorrect: counters.visibleCorrect,
    visibleAccuracy: counters.visibleFrames ? Number((counters.visibleCorrect / counters.visibleFrames).toFixed(4)) : null,
    meanIou: counters.iouN ? Number((counters.iouSum / counters.iouN).toFixed(4)) : null,
    stateCounts, blockReasonCounts, reacquire,
    elapsedMs: Date.now() - started,
  };
}

function emptyV2(clip: HoldoutClip, elapsedMs: number): EvalV2Result {
  return {
    sport: clip.sport, seed: clip.seed, kind: 'synthetic-holdout-v2',
    qualityClaim: false, note: 'synthetic-not-real-sports',
    frames: clip.frames.length, anchored: false, anchorFrame: null,
    candidateGenerationRecall: null, candidateGenerationFraction: [0, 0],
    candidateRankingRecallAt1: null, candidateRankingRecallAt2: null, candidateRankingRecallAt3: null,
    candidateRankingFraction: [0, 0], detectorMissFrames: 0,
    slicedCalls: 0, slicedDuplicateCandidates: 0,
    hashRemovedCandidates: 0, hashRemovedTruthCandidates: 0,
    descriptorComputations: 0, schedulerDecideCalls: 0, schedulerExpensiveExtracts: 0,
    hsvComparisons: 0, jaccardGateCalls: 0, jaccardGateReasons: {}, jaccardRuns: 0,
    jaccardImprovedTruthRank: 0, jaccardWorsenedTruthRank: 0,
    galleryAccepted: 0, galleryRejected: 0, gallerySizeFinal: 0,
    visibleFrames: 0, visibleAssignedCorrect: 0, visibleAccuracy: null, meanIou: null,
    stateCounts: {}, blockReasonCounts: {},
    reacquire: computeReacquireEvents([], 2),
    elapsedMs,
  };
}
