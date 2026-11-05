/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c593c458 @license @preserve */
/* 외곽선 연속성 검증기 ablation 을 위한 단일 대상 추적 시뮬레이터.

기준선(A0)은 기존 검출 경로 평가기(holdout-eval-v2)와 같은 제품 모듈을 쓴다:
TrackRegionPredictor · predictionGate · mahalanobis2d · ReidScheduler(selective)
· describe/similarity · fuseAppearanceSpace · kReciprocalRerank · AppearanceGallery.
달라진 점은 두 가지다.
  - 카메라 이동은 정답값이 아니라 제품 GMC(estimateAffineGmc + assessGmcEvidence)
    추정값을 쓴다.
  - 관측이 끊겨도 예측기가 허락하는 공백(0.4초) 안에서는 이어 붙인다. 그 뒤는
    LOST 이고, 자동 재획득은 꺼져 있다. 재획득은 shadow 로만 잰다.

정답(sim gt)은 대상 지정(첫 프레임 클릭 대신)과 채점에만 쓴다. 후보 생성·점수·
확정·메모리·갤러리 판단에는 들어가지 않는다.
*/

import { TrackRegionPredictor, type TrackRegionPrediction } from '../track-region-prediction';
import { predictionGate } from '../prediction-identity-firewall';
import { mahalanobis2d } from '../spatial-quality';
import { assessSpatialQuality } from '../spatial-quality';
import { fuseAppearanceSpace, spatialCuesFromBoxes } from '../space-appearance-fusion';
import { ReidScheduler, type SchedulerDecision } from '../reid-scheduler';
import { AppearanceGallery } from '../appearance-gallery';
import { describe, similarity, type Descriptor } from '../appearance';
import { kReciprocalRerank, shouldNeighborRerank, type RerankSample } from '../k-reciprocal-rerank';
import { TrackletStore } from '../tracklets';
import { estimateAffineGmc, applyAffineToBox, GMC_GRID_W, GMC_GRID_H, type AffineGmcResult } from '../affine-gmc';
import { assessGmcEvidence } from '../gmc-verification';
import { describeHsvAux, compareHsvAux, type HsvAuxDescriptor } from '../hsv-aux';
import {
  extractContourFeature, erodedMaskCropRgba, type ContourFeature, type ContourSport,
} from '../contour-feature';
import {
  ContinuityJudge, ContourShortTermMemory, applyContourToScheduler, conditionalHeavyReid,
  contourCue, maskQualityFor, galleryUpdateGate, CONTOUR_OPERATING_POINTS,
  type ContourContinuityFlags, type ContinuityVerdict, type CandidateCues, type TierThresholds,
  type FusionContext, CONTOUR_CONTINUITY_DEFAULTS,
} from '../contour-continuity';
import { renderClip, SIM_FPS, SIM_H, SIM_W, type SimClip, type SimClipSpec, type SimFrame } from './scene';
import { detectFrame, boxIoU, type SimDetection } from './detections';
import {
  DefectFeatureAssembler, detDefectPix, frameDefectPix, gray01,
  type DetDefectPix, type FrameDefectPix, type TrackState,
} from './defect-hook';
import type { ControllerStep, DefectActions, DefectRiskController } from '../defect-policy';

export type AblationId = 'A0' | 'A0-shadow' | 'A0-hyst' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A5-motion';
export type GmcVariant = 'G0' | 'G1' | 'G-off';

interface Box { x: number; y: number; width: number; height: number }

/* ---------- 모드 정의 ---------- */

interface ModeSpec {
  verifier: boolean;
  shadow: boolean;
  contour: boolean;
  hsv: boolean;
  cachedGallery: boolean;
  conditional: boolean;
  hysteresis: boolean;
}

export const ABLATION_MODES: Readonly<Record<AblationId, ModeSpec>> = Object.freeze({
  A0: { verifier: false, shadow: false, contour: false, hsv: false, cachedGallery: false, conditional: false, hysteresis: false },
  'A0-shadow': { verifier: true, shadow: true, contour: true, hsv: true, cachedGallery: true, conditional: true, hysteresis: false },
  'A0-hyst': { verifier: false, shadow: false, contour: false, hsv: false, cachedGallery: false, conditional: false, hysteresis: true },
  A1: { verifier: true, shadow: false, contour: true, hsv: false, cachedGallery: false, conditional: false, hysteresis: true },
  A2: { verifier: true, shadow: false, contour: false, hsv: true, cachedGallery: false, conditional: false, hysteresis: true },
  A3: { verifier: true, shadow: false, contour: true, hsv: true, cachedGallery: false, conditional: false, hysteresis: true },
  A4: { verifier: true, shadow: false, contour: true, hsv: true, cachedGallery: true, conditional: false, hysteresis: true },
  A5: { verifier: true, shadow: false, contour: true, hsv: true, cachedGallery: true, conditional: true, hysteresis: true },
  // 대조군: A5 에서 외곽선·HSV 만 끈다. A5 의 이득이 경량 특징 덕인지 가려낸다.
  'A5-motion': { verifier: true, shadow: false, contour: false, hsv: false, cachedGallery: true, conditional: true, hysteresis: true },
});

export interface SimRunConfig {
  ablation: AblationId;
  gmc: GmcVariant;
  flags: ContourContinuityFlags;
  thresholds: TierThresholds;
  /** 후보별 판단 근거를 FrameLog.debug 에 남긴다 (채점 전용 정답 포함) */
  debug?: boolean;
  /** 추적 결함 분류기. 없으면 기존 경로 그대로. */
  defect?: {
    controller: DefectRiskController | null;
    onFrame?: (row: DefectFrameRow) => void;
  };
}

/** 결함 분류기가 한 프레임에 본 것 (학습·평가용 기록). 정답은 들어 있지 않다. */
export interface DefectFrameRow {
  f: number;
  tSec: number;
  vector: Float64Array;
  reliability: number;
  step: ControllerStep | null;
  predBox: { x: number; y: number; width: number; height: number };
  targetDetIndex: number | null;
  assembleMs: number;
  controllerMs: number;
}

export function defaultRunConfig(ablation: AblationId, over: Partial<ContourContinuityFlags> = {},
  point: keyof typeof CONTOUR_OPERATING_POINTS = 'balanced', gmc: GmcVariant = 'G0'): SimRunConfig {
  const mode = ABLATION_MODES[ablation];
  const flags: ContourContinuityFlags = {
    ...CONTOUR_CONTINUITY_DEFAULTS,
    ...over,
    enableContourContinuity: mode.verifier,
    contourShadowMode: mode.shadow,
    enableContourHsvFusion: mode.hsv,
  };
  return { ablation, gmc, flags, thresholds: CONTOUR_OPERATING_POINTS[point] };
}

/* ---------- 클립 준비물 (모드 사이에 공유) ---------- */

export interface PreparedDetection extends SimDetection {
  defect?: DetDefectPix | null;
  contour: ContourFeature | null;
  hsv: HsvAuxDescriptor | null;
  hsvVisible: [boolean, boolean, boolean];
}

export interface PerfSample {
  contourMs: number[];
  hsvMs: number[];
  distanceMs: number[];
  heavyMs: number[];
  lightFrameMs: number[];
  gmcMs: number[];
}

export interface PreparedClip {
  clip: SimClip;
  dets: PreparedDetection[][];
  gmc: Record<'G0' | 'G1', Array<{ result: AffineGmcResult; ok: boolean; confidence: number } | null>>;
  heavyCache: Map<string, Descriptor | null>;
  /** 프레임 밝기 평균 (조명 변화 판단용). 원본 화소는 준비 뒤 버린다. */
  brightness: number[];
  /** 결함 분류기용 프레임 전역 DCT 특징 (withDefect 일 때만) */
  frameDefect: Array<FrameDefectPix | null>;
  perf: PerfSample;
  key: string;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sportOf(clip: SimClip): ContourSport {
  return clip.spec.sport;
}

/** 선수 마스크를 넓혀 GMC 격자(80×48)의 배경 마스크로. 1 = 배경. */
function dilatedBackgroundMask(dets: readonly SimDetection[], dilatePx: number): Uint8Array {
  const bg = new Uint8Array(GMC_GRID_W * GMC_GRID_H).fill(1);
  const sx = GMC_GRID_W / SIM_W;
  const sy = GMC_GRID_H / SIM_H;
  for (const d of dets) {
    const m = d.mask;
    if (!m) continue;
    for (let y = 0; y < m.height; y += 1) {
      for (let x = 0; x < m.width; x += 1) {
        if (!m.data[y * m.width + x]) continue;
        const fx = m.frameX + (x + 0.5) * m.scale;
        const fy = m.frameY + (y + 0.5) * m.scale;
        const gx0 = Math.max(0, Math.floor((fx - dilatePx) * sx));
        const gx1 = Math.min(GMC_GRID_W - 1, Math.floor((fx + dilatePx) * sx));
        const gy0 = Math.max(0, Math.floor((fy - dilatePx) * sy));
        const gy1 = Math.min(GMC_GRID_H - 1, Math.floor((fy + dilatePx) * sy));
        for (let gy = gy0; gy <= gy1; gy += 1) for (let gx = gx0; gx <= gx1; gx += 1) bg[gy * GMC_GRID_W + gx] = 0;
      }
    }
  }
  return bg;
}

export function prepareClip(spec: SimClipSpec, flags: ContourContinuityFlags, opts: { withDefect?: boolean } = {}): PreparedClip {
  const clip = renderClip(spec);
  const frameDefect: Array<FrameDefectPix | null> = [];
  const perf: PerfSample = { contourMs: [], hsvMs: [], distanceMs: [], heavyMs: [], lightFrameMs: [], gmcMs: [] };
  const dets: PreparedDetection[][] = [];
  for (const frame of clip.frames) {
    const raw = detectFrame(clip, frame, { maskScale: flags.contourMaskScale });
    const row: PreparedDetection[] = [];
    const g01 = opts.withDefect ? gray01(frame.gray) : null;
    frameDefect.push(g01 ? frameDefectPix(g01, SIM_W, SIM_H) : null);
    for (const d of raw) {
      let contour: ContourFeature | null = null;
      let hsv: HsvAuxDescriptor | null = null;
      if (d.mask) {
        const t0 = now();
        contour = extractContourFeature(d.mask, {
          sampleCount: flags.contourSampleCount,
          smoothingStrength: flags.contourSmoothingStrength,
        });
        perf.contourMs.push(now() - t0);
        const t1 = now();
        const crop = erodedMaskCropRgba(frame.rgb, SIM_W, SIM_H, d.mask, 1);
        if (crop && crop.keptPixels >= 40) hsv = describeHsvAux(crop.rgba, crop.width, crop.height, true);
        perf.hsvMs.push(now() - t1);
      }
      const vis: [boolean, boolean, boolean] = contour
        ? [
          contour.points.some((p) => p.region === 'upper' && p.visible),
          contour.points.some((p) => p.region === 'torso' && p.visible),
          contour.points.some((p) => p.region === 'lower' && p.visible),
        ]
        : [true, true, true];
      const defect = g01 ? detDefectPix(g01, SIM_W, SIM_H, d.box, d.mask, frame.label, d.truthId) : null;
      row.push({ ...d, defect, contour, hsv, hsvVisible: vis });
    }
    dets.push(row);
  }
  const gmc: PreparedClip['gmc'] = { G0: [null], G1: [null] };
  for (let f = 1; f < clip.frames.length; f += 1) {
    for (const variant of ['G0', 'G1'] as const) {
      const t0 = now();
      const result = estimateAffineGmc({
        prevGray: clip.frames[f - 1].gray,
        nextGray: clip.frames[f].gray,
        width: SIM_W,
        height: SIM_H,
        excludeBoxes: variant === 'G0' ? dets[f - 1].map((d) => d.box) : undefined,
        backgroundMask: variant === 'G1' ? dilatedBackgroundMask(dets[f - 1], 4) : null,
      });
      perf.gmcMs.push(now() - t0);
      const ev = assessGmcEvidence(result);
      const ok = result.usable && ev.evidenceOk;
      // 근거 게이트는 떨어졌지만 추정 이동이 거의 없으면 "정지 카메라일 가능성" 으로 중간값을 준다.
      // 추정 자체가 안 됐으면(usable=false) 낮게 둔다.
      const still = result.usable && Math.hypot(result.dxPx, result.dyPx) < 1.5 && Math.abs(result.scale - 1) < 0.02;
      gmc[variant].push({ result, ok, confidence: ok ? Math.max(0.5, result.quality) : still ? 0.55 : 0.25 });
    }
  }
  // 무거운 서술자는 모든 탐지에 대해 미리 한 번 계산해 둔다. 호출 수는 모드별로 따로 센다.
  const heavyCache = new Map<string, Descriptor | null>();
  const brightness: number[] = [];
  for (let f = 0; f < clip.frames.length; f += 1) {
    const frame = clip.frames[f];
    for (const d of dets[f]) {
      const t0 = now();
      const crop = cropRgb(frame, d.box);
      heavyCache.set(`${f}:${d.index}`, crop ? describe(crop.values, crop.w, crop.h) : null);
      perf.heavyMs.push(now() - t0);
    }
    let mean = 0;
    for (let i = 0; i < frame.gray.length; i += 7) mean += frame.gray[i];
    brightness.push(mean / Math.ceil(frame.gray.length / 7));
  }
  // 원본 화소·라벨은 RAM 에서 바로 버린다 (디버깅용 이미지 저장 없음)
  for (const frame of clip.frames) {
    frame.rgb = new Uint8ClampedArray(0);
    frame.gray = new Uint8Array(0);
    frame.label = new Int16Array(0);
    frame.occluder = new Uint8Array(0);
  }
  return {
    clip,
    dets,
    gmc,
    heavyCache,
    brightness,
    frameDefect,
    perf,
    key: `${spec.scenario}|${spec.sport}|${spec.seed}|${flags.contourMaskScale}|${flags.contourSampleCount}|${flags.contourSmoothingStrength}`,
  };
}

function cropRgb(frame: SimFrame, box: Box): { values: Uint8Array; w: number; h: number } | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(SIM_W, Math.ceil(box.x + box.width));
  const y1 = Math.min(SIM_H, Math.ceil(box.y + box.height));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 8) return null;
  const values = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = ((y0 + y) * SIM_W + x0 + x) * 3;
      const di = (y * w + x) * 3;
      values[di] = frame.rgb[si];
      values[di + 1] = frame.rgb[si + 1];
      values[di + 2] = frame.rgb[si + 2];
    }
  }
  return { values, w, h };
}

/** 무거운 Re-ID 한 번 (기존 색·무늬 서술자). 계산은 캐시하되 호출 수는 모드별로 센다. */
function heavyDescriptor(prep: PreparedClip, f: number, d: PreparedDetection): Descriptor | null {
  return prep.heavyCache.get(`${f}:${d.index}`) ?? null;
}

/* ---------- 실행 ---------- */

export interface FrameLog {
  f: number;
  assigned: Box | null;
  /** 채점 전용 */
  matchedId: number | null;
  targetObservable: boolean;
  targetBox: Box | null;
  extracted: boolean;
  describeCalls: number;
  skippedByContour: boolean;
  requestedByContour: boolean;
  virtualSkip: boolean;
  virtualRequest: boolean;
  tier: string | null;
  gated: number;
  demoted: number;
  demotedTarget: boolean;
  resolvedByCached: boolean;
  galleryStored: boolean;
  galleryContaminated: boolean;
  tentative: boolean;
  gapBefore: number;
  state: 'tracked' | 'coasting' | 'lost';
  shadowReacquire: 'correct' | 'false' | null;
  gmcOk: boolean;
  crowd: boolean;
  contourGated: string | null;
  debug?: string;
  /** 결함 제어: 이 프레임에 막은 갤러리 저장, 그리고 그 저장이 오염이었을지 (채점 전용) */
  galleryBlocked?: boolean;
  galleryBlockedWouldContaminate?: boolean;
  defectHold?: boolean;
  defectForcedReid?: boolean;
  defectGmcRecheck?: 'none' | 'sift-bf' | 'lightglue';
  defectSliced?: boolean;
  defectRecommendedActive?: string[];
}

export interface ClipRun {
  key: string;
  ablation: AblationId;
  scenario: string;
  sport: string;
  seed: number;
  anchorFrame: number | null;
  frames: FrameLog[];
  prototypesAdmitted: number;
  prototypesBlocked: Record<string, number>;
  maxPrototypesHeld: number;
}

function bump(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

export function runClip(prep: PreparedClip, cfg: SimRunConfig): ClipRun {
  const mode = ABLATION_MODES[cfg.ablation];
  const flags = cfg.flags;
  const clip = prep.clip;
  const frames = clip.frames;
  const dt = 1 / SIM_FPS;
  const sport = sportOf(clip);
  const out: FrameLog[] = [];
  const blocked: Record<string, number> = {};
  let admitted = 0;
  let maxHeld = 0;

  /* 대상 지정: 사용자가 대상을 누르는 순간을 대신한다 */
  let anchorFrame: number | null = null;
  let anchorDet: PreparedDetection | null = null;
  for (let f = 0; f < frames.length; f += 1) {
    const g = frames[f].gt.find((x) => x.id === clip.targetId);
    if (!g || !g.visibleBox || g.visibleRatio < 0.8) continue;
    const best = prep.dets[f].filter((d) => d.truthIds.length === 1)
      .map((d) => ({ d, iou: boxIoU(d.box, g.visibleBox!) }))
      .sort((a, b) => b.iou - a.iou)[0];
    if (best && best.iou >= 0.5) {
      anchorFrame = f;
      anchorDet = best.d;
      break;
    }
  }
  if (anchorFrame == null || !anchorDet) {
    return { key: prep.key, ablation: cfg.ablation, scenario: clip.spec.scenario, sport: clip.spec.sport, seed: clip.spec.seed,
      anchorFrame: null, frames: [], prototypesAdmitted: 0, prototypesBlocked: {}, maxPrototypesHeld: 0 };
  }

  const predictor = new TrackRegionPredictor();
  const scheduler = new ReidScheduler({ mode: 'selective' });
  const tracklets = new TrackletStore();
  const gallery = new AppearanceGallery({ ownerId: 'contour-sim', videoId: prep.key, subjectId: 'subject', runId: cfg.ablation });
  const memory = new ContourShortTermMemory(flags.contourMemoryMs, flags.contourMaxPrototypes);
  const judge = new ContinuityJudge(cfg.thresholds, flags);
  const anchorDesc = heavyDescriptor(prep, anchorFrame, anchorDet);
  const anchorHsv = anchorDet.hsv;
  const t0 = anchorFrame * dt;
  if (anchorDesc) {
    gallery.rememberUserAnchor({
      tSec: t0, trackId: 'subject', quality: 0.9, visibility: [true, true, true], box: anchorDet.box,
      overlapOthers: false, cameraOk: true, gmcOk: true, descriptor: anchorDesc, view: 'unknown',
    });
  }
  const pastSamples: RerankSample[] = anchorDesc
    ? [{ id: 'anchor', descriptor: anchorDesc, source: 'user_anchor', trackId: 'subject', tSec: t0 }]
    : [];
  if (anchorDet.contour) {
    memory.admit(anchorFrame * 1000 / SIM_FPS, anchorDet.contour, anchorHsv, {
      trackingConfidence: 1, maskQuality: 1, crowdCrossing: false, occluded: false,
      switchRiskLow: true, gmcConfidence: 1, tentative: false,
    });
  }
  let hsvMemory: HsvAuxDescriptor | null = anchorHsv;
  predictor.start(anchorDet.box, t0);
  let pred: TrackRegionPrediction = predictor.observe({
    tSec: t0, center: null, box: anchorDet.box, detectionConfidence: 0.8, occlusion: 'visible',
    frame: { width: SIM_W, height: SIM_H },
  }, { horizonSec: dt });
  let lastBox: Box = anchorDet.box;
  let followed: number | null = null;
  let state: FrameLog['state'] = 'tracked';
  let gap = 0;
  let heldLast = true;
  let tentativeLeft = 0;
  let switchStreak = 0;
  let switchCandidate: number | null = null;
  let followedSeenF = anchorFrame;
  const assembler = cfg.defect ? new DefectFeatureAssembler() : null;
  let prevContourScore = Number.NaN;
  let prevHsvScore = Number.NaN;
  let prevAppScore = Number.NaN;
  let prevAppMargin = Number.NaN;
  let lastReidT = -Infinity;
  let prevGmcT: [number, number] | null = null;
  let prevSpeed: number | null = null;
  let prevCenter: [number, number] | null = null;
  const followChanges: number[] = [];
  let stableFrames = 0;
  const trackletDesc = new Map<number, { desc: Descriptor; tSec: number }>();
  const brightness: number[] = [];
  const recentAspects: number[] = [];
  const maxFillFrames = Math.round(0.4 * SIM_FPS);

  // 첫 프레임 tracklet 번호
  {
    const ids = tracklets.update({ t: t0, detections: prep.dets[anchorFrame].map((d) => d.box) });
    followed = ids[anchorDet.index] ?? null;
  }

  for (let f = anchorFrame + 1; f < frames.length; f += 1) {
    const frame = frames[f];
    const tSec = f * dt;
    const tMs = tSec * 1000;
    const dets = prep.dets[f];
    const gPre = cfg.gmc === 'G-off' ? null : prep.gmc[cfg.gmc][f];
    const ids = tracklets.update({
      t: tSec,
      detections: dets.map((d) => d.box),
      cameraWarp: gPre && gPre.ok ? gPre.result.affine : null,
    });

    // 조명 변화 (관측 가능한 값만)
    const mean = prep.brightness[f];
    brightness.push(mean);
    const past = brightness.length > SIM_FPS ? brightness[brightness.length - 1 - SIM_FPS] : brightness[0];
    const lightingChanged = Math.abs(mean - past) / Math.max(1, past) > 0.12;

    // GMC
    const g = cfg.gmc === 'G-off' ? null : prep.gmc[cfg.gmc][f];
    const gmcOk = g != null && g.ok;
    const gmcConfidence = g ? g.confidence : 0.25;
    let predBox: Box = pred.box ? { ...pred.box } : { ...lastBox };
    if (gmcOk && g) predBox = applyAffineToBox(predBox, g.result.affine);
    const predForGate: TrackRegionPrediction = { ...pred, box: predBox, center: { x: predBox.x + predBox.width / 2, y: predBox.y + predBox.height / 2 } };
    const cov = predictor.spatialCovariance();
    const px = predBox.x + predBox.width / 2;
    const py = predBox.y + predBox.height / 2;

    // 관문
    interface Cand { d: PreparedDetection; tk: number; d2: number | null; motion: number; spatial: number;
      appearance: number | null; cached: number | null; score: number; desc: Descriptor | null }
    const gated: Cand[] = [];
    for (let i = 0; i < dets.length; i += 1) {
      const d = dets[i];
      if (predictionGate(predForGate, d.box).verdict === 'reject') continue;
      const cx = d.box.x + d.box.width / 2;
      const cy = d.box.y + d.box.height / 2;
      const d2 = cov ? mahalanobis2d({ ex: cx - px, ey: cy - py, stdX: cov.stdX, stdY: cov.stdY }).d2 : null;
      if (d2 != null && d2 > 64) continue;
      gated.push({
        d, tk: ids[i], d2,
        motion: d2 != null ? Math.exp(-d2 / 8) : 0.5,
        spatial: Math.min(1, boxIoU(d.box, predBox) / 0.5),
        appearance: null, cached: null, score: 0, desc: null,
      });
    }
    gated.sort((a, b) => (a.d2 ?? 99) - (b.d2 ?? 99) || a.d.index - b.d.index);

    // 상황 (관측 가능한 값만)
    // 군중 교차: 대상 예측 자리와 실제로 겹치는 후보가 둘 이상. 관문 안에 사람이 많은 것만으로는 아니다.
    const crowd = gated.filter((c) => boxIoU(c.d.box, predBox) > 0.1).length >= 2;
    const smallObject = lastBox.height < flags.contourMinObjectSize;
    recentAspects.push(lastBox.height / Math.max(1, lastBox.width));
    if (recentAspects.length > 4) recentAspects.shift();
    const fastPoseChange = recentAspects.length >= 3
      && Math.abs(Math.log(recentAspects[recentAspects.length - 1] / recentAspects[0])) > 0.25;

    // 추적 결함 분류기: 모듈들보다 먼저, 지금 프레임 화소·검출·GMC 와 직전 프레임 상태만 본다
    let defectStep: ControllerStep | null = null;
    let dActions: DefectActions | null = null;
    if (assembler && cfg.defect) {
      const tgt = gated[0] ?? null;
      const cf = tgt?.d.contour ?? null;
      const gd = g?.result.diagnostics;
      const tr = g ? [g.result.dxPx, g.result.dyPx] as [number, number] : null;
      const center: [number, number] = [px, py];
      const speed = prevCenter ? Math.hypot(center[0] - prevCenter[0], center[1] - prevCenter[1]) / Math.max(1, lastBox.height) : null;
      while (followChanges.length && followChanges[0] < tSec - 1) followChanges.shift();
      const motions = gated.map((c) => c.motion).sort((a, b) => b - a);
      const track: TrackState = {
        detConf: tgt ? tgt.d.confidence : Number.NaN,
        detRelHeight: tgt ? tgt.d.box.height / SIM_H : Number.NaN,
        gapFrames: gap,
        gatedCount: gated.length,
        motionD2Log: tgt?.d2 != null ? Math.log1p(tgt.d2) : Number.NaN,
        covStdBodies: cov ? Math.hypot(cov.stdX, cov.stdY) / Math.max(1, lastBox.height) : Number.NaN,
        speedChangeBodies: speed != null && prevSpeed != null ? Math.abs(speed - prevSpeed) : Number.NaN,
        gmcOk: gmcOk ? 1 : 0,
        gmcInlierRatio: gd ? gd.inlierRatio : Number.NaN,
        gmcGridCells: gd ? gd.gridCells : Number.NaN,
        gmcResidualP90: gd && Number.isFinite(gd.residualP90) ? Math.min(10, gd.residualP90) : Number.NaN,
        gmcRival: gd ? gd.rivalSupportRatio : Number.NaN,
        gmcTranslation: tr ? Math.hypot(tr[0], tr[1]) : Number.NaN,
        gmcDeltaPrev: tr && prevGmcT ? Math.hypot(tr[0] - prevGmcT[0], tr[1] - prevGmcT[1]) : Number.NaN,
        maskQuality: cf ? Math.min(1, cf.global.visibleRatio * cf.global.solidity) : Number.NaN,
        visibleRatio: cf ? cf.global.visibleRatio : Number.NaN,
        contactRatio: cf ? cf.global.contactRatio : Number.NaN,
        maskAreaToBox: cf && tgt ? cf.global.area / Math.max(1, tgt.d.box.width * tgt.d.box.height) : Number.NaN,
        componentCount: cf ? cf.stats.componentCount : Number.NaN,
        prevContourScore,
        prevHsvScore,
        prevAppScore,
        prevAppMargin,
        sinceReidSec: Number.isFinite(lastReidT) ? Math.min(5, tSec - lastReidT) : 5,
        gallerySize: pastSamples.length,
        candMargin: motions.length >= 2 ? motions[0] - motions[1] : 1,
        recentSwitches: followChanges.length,
        crowdFlag: crowd ? 1 : 0,
        trackAgeSec: tSec - anchorFrame * dt,
        tentativeFlag: tentativeLeft > 0 ? 1 : 0,
      };
      prevGmcT = tr;
      prevSpeed = speed;
      prevCenter = center;
      const asm = assembler.assemble(tSec, prep.frameDefect[f] ?? null, tgt?.d.defect ?? null, track);
      const tc = now();
      defectStep = cfg.defect.controller ? cfg.defect.controller.step(tMs, asm.vector, asm.reliability) : null;
      const cMs = now() - tc;
      dActions = defectStep && defectStep.applied ? defectStep.actions : null;
      cfg.defect.onFrame?.({
        f, tSec, vector: asm.vector, reliability: asm.reliability, step: defectStep,
        predBox: { ...predBox }, targetDetIndex: tgt ? tgt.d.index : null, assembleMs: asm.ms, controllerMs: cMs,
      });
    }

    // 경량 연속성 (verifier 가 켜졌거나 shadow 일 때만 계산)
    let verdict: ContinuityVerdict | null = null;
    const cueByTk = new Map<number, CandidateCues['cues']>();
    let lightMs = 0;
    const contourGatedReasons: string[] = [];
    if (mode.verifier) {
      const tl = now();
      let sameUniformLikely = false;
      const cues: CandidateCues[] = gated.map((c) => {
        let contourScore: number | null = null;
        let contourRel = 0;
        if (mode.contour && c.d.contour) {
          const q = maskQualityFor(c.d.contour, c.d.confidence, c.d.box, memory, tMs, flags, frame.blur);
          const td = now();
          const cue = contourCue({ current: c.d.contour, quality: q, memory, nowMs: tMs, flags, sport, smallObject, fastPoseChange });
          prep.perf.distanceMs.push(now() - td);
          contourScore = cue.score;
          contourRel = dActions?.disableContour ? 0 : cue.reliability;
          if (cue.gated) contourGatedReasons.push(cue.gated);
        }
        let hsvScore: number | null = null;
        let hsvRel = 0;
        if (mode.hsv && c.d.hsv && hsvMemory) {
          const cmp = compareHsvAux(c.d.hsv, hsvMemory, c.d.hsvVisible, { lightingChanged });
          hsvScore = cmp.score;
          hsvRel = cmp.score == null ? 0 : (cmp.usedRegions / 3) * (lightingChanged ? 0.4 : 1) * (dActions?.hsvWeightScale ?? 1);
          if (cmp.score != null && cmp.score > 0.85 && c.tk !== followed) sameUniformLikely = true;
        }
        return {
          candidateId: String(c.tk),
          cues: {
            motion: { score: c.motion, reliability: cov ? Math.min(1, 0.4 + 0.6 * gmcConfidence) : 0.3 },
            spatial: { score: c.spatial, reliability: gmcOk ? 0.8 : 0.4 },
            contour: { score: contourScore, reliability: contourRel },
            hsv: { score: hsvScore, reliability: hsvRel },
          },
        };
      });
      cues.forEach((c) => cueByTk.set(Number(c.candidateId), c.cues));
      const ctx: FusionContext = {
        crowdCrossing: crowd, lightingChanged, smallObject, fastPoseChange, gmcConfidence,
        sameUniformLikely, cameraStable: gmcOk && g != null && Math.hypot(g.result.dxPx, g.result.dyPx) < 1.5,
      };
      verdict = judge.judge({
        tMs, candidates: cues, context: ctx,
        firstFrameAfterOcclusion: gap > 0,
        reentry: state !== 'tracked',
        longOcclusion: gap > maxFillFrames,
      });
      lightMs = now() - tl;
      prep.perf.lightFrameMs.push(lightMs);
    }

    const active = mode.verifier && !mode.shadow;
    const demotedSet = new Set(active && verdict ? verdict.demoted.map(Number) : []);
    let effective = gated.filter((c) => !demotedSet.has(c.tk));
    if (!effective.length) effective = gated.slice();

    // A4: 최근 검증된 embedding(1초 이내 tracklet 캐시)으로 먼저 재정렬
    let cachedMargin: number | null = null;
    let resolvedByCached = false;
    if (active && mode.cachedGallery && anchorDesc && effective.length >= 2) {
      const rows: number[] = [];
      for (const c of effective) {
        const hit = trackletDesc.get(c.tk);
        if (hit && tSec - hit.tSec <= 1.0) {
          c.cached = similarity(anchorDesc, hit.desc);
          rows.push(c.cached);
        }
      }
      if (rows.length >= 2) {
        rows.sort((a, b) => b - a);
        cachedMargin = rows[0] - rows[1];
      }
    }

    // 스케줄러
    const decision0: SchedulerDecision = scheduler.decide({
      videoTSec: tSec,
      box: lastBox,
      visibleRatio: heldLast ? 0.9 : 0.05,
      cropValid: true,
      occluded: !heldLast,
      blurSevere: frame.blur > 0.7 && lastBox.height < 30,
      rivalNearby: effective.length > 1,
      rankCompetition: effective.length > 1,
      candidateCount: effective.length,
      gallerySampleCount: pastSamples.length,
      galleryDistinct: pastSamples.length,
      reentryAfterOcclusion: state !== 'tracked' && effective.length > 0,
      predictionResidualBodies: cov ? Math.hypot(cov.stdX, cov.stdY) / Math.max(1, lastBox.height) : null,
      appearanceWeak: false,
    });
    let decision = decision0;
    let virtualSkip = false;
    let virtualRequest = false;
    let skippedByContour = false;
    let requestedByContour = false;
    if (mode.verifier) {
      const outcome = mode.conditional
        ? conditionalHeavyReid(decision0, verdict, flags, { effectiveCandidates: effective.length, cachedMargin })
        : applyContourToScheduler(decision0, verdict, flags);
      decision = outcome.decision;
      virtualSkip = outcome.virtual.skipped;
      virtualRequest = outcome.virtual.requested;
      skippedByContour = outcome.applied && decision0.extract && !decision.extract;
      requestedByContour = outcome.applied && !decision0.extract && decision.extract;
      if (cachedMargin != null && virtualSkip && outcome.note === 'resolved-by-cached-gallery') resolvedByCached = true;
    }

    let defectForcedReid = false;
    if (dActions?.requestHeavyReid && !decision.extract && decision.skip !== 'no_valid_crop' && decision.skip !== 'full_occlusion'
      && decision.skip !== 'severe_blur' && effective.length > 1) {
      decision = { ...decision, extract: true, compare: true, admitInspect: false, measuredFresh: true,
        reasons: [...decision.reasons, 'track_drift_suspect'], skip: null, skipDetail: 'defect-risk', holdJudgment: true };
      defectForcedReid = true;
    }

    // 무거운 Re-ID
    let describeCalls = 0;
    if (decision.extract && anchorDesc) {
      for (const c of effective) {
        const desc = heavyDescriptor(prep, f, c.d);
        describeCalls += 1;
        if (!desc) continue;
        c.desc = desc;
        c.appearance = similarity(anchorDesc, desc);
        trackletDesc.set(c.tk, { desc, tSec });
      }
      scheduler.noteExtract(0.4 * Math.max(1, describeCalls));
      lastReidT = tSec;
      const fol = effective.find((c) => c.tk === followed);
      const others = effective.filter((c) => c !== fol && c.appearance != null).map((c) => c.appearance as number);
      prevAppScore = fol?.appearance ?? Number.NaN;
      prevAppMargin = fol?.appearance != null ? fol.appearance - (others.length ? Math.max(...others) : 0) : Number.NaN;
    }

    // 점수
    const quality = assessSpatialQuality({
      camera: { status: gmcOk ? 'ok' : 'absent', usable: gmcOk, quality: gmcConfidence, backgroundShare: g ? g.result.backgroundShare : 0.6, featureSupport: gmcOk },
      covariance: cov,
      predictionUsable: pred.usable,
      sceneCut: false,
      lastObservationQuality: null,
    });
    for (const c of effective) {
      const cx = c.d.box.x + c.d.box.width / 2;
      const cy = c.d.box.y + c.d.box.height / 2;
      const spatialOnly = Math.max(0, 1 - Math.hypot(cx - px, cy - py) / Math.max(8, 1.2 * lastBox.height));
      const app = c.appearance ?? (active && mode.cachedGallery && c.cached != null ? c.cached : null);
      if (app != null) {
        const fused = fuseAppearanceSpace({
          appearance: app,
          appearanceObserved: true,
          space: spatialCuesFromBoxes({
            predCx: px, predCy: py, candCx: cx, candCy: cy,
            predW: lastBox.width, predH: lastBox.height, candW: c.d.box.width, candH: c.d.box.height,
            d2: c.d2, inflatedCovariance: gap > 2, dtSec: dt,
            cameraDx: gmcOk && g ? g.result.dxPx : 0, cameraDy: gmcOk && g ? g.result.dyPx : 0,
            prevCx: lastBox.x + lastBox.width / 2, prevCy: lastBox.y + lastBox.height / 2,
            turning: sport === 'skating', zoomLikely: clip.spec.scenario === 'zoom', exitEntryPlausible: true,
          }),
          quality,
          mode: 'weighted',
        });
        c.score = fused.sRank ?? app;
      } else {
        c.score = spatialOnly;
      }
    }
    effective.sort((a, b) => b.score - a.score || a.d.index - b.d.index);

    // Jaccard: 새로 잰 서술자가 모두 있을 때만 (기존 평가기와 같은 조건)
    if (effective.length >= 2 && effective.every((c) => c.desc != null) && pastSamples.length) {
      const galleryRows = pastSamples.slice(0, 8);
      const gate = shouldNeighborRerank({
        scores: effective.map((c) => c.score), galleryCount: galleryRows.length,
        distinctGallery: galleryRows.length, candidateCount: effective.length,
      });
      if (gate.run) {
        const ranked = kReciprocalRerank({
          gallery: galleryRows,
          candidates: effective.map((c) => ({ id: String(c.tk), descriptor: c.desc as Descriptor, directScore: c.score, hash: null })),
        });
        if (!ranked.usedFallback) {
          for (const c of effective) {
            const row = ranked.rows.find((r) => r.id === String(c.tk));
            if (row) c.score = row.blended;
          }
          effective.sort((a, b) => b.score - a.score || a.d.index - b.d.index);
        }
      }
    }

    // 연결
    let top = effective[0] ?? null;
    const continuityOk = top != null && (boxIoU(top.d.box, predBox) >= 0.15 || boxIoU(top.d.box, lastBox) >= 0.2);
    let assigned: PreparedDetection | null = null;
    let tentative = false;
    const gapBefore = gap;
    if (followed != null && ids.includes(followed)) followedSeenF = f;
    let holdSwitch = false;
    if (state !== 'lost' && top && continuityOk && gap <= maxFillFrames) {
      // 한 프레임 결과로 갈아타지 않는다 (다중 프레임 히스테리시스).
      // 따라가던 궤적이 최근까지 살아 있었다면, 이번 프레임에 안 보여도
      // 다른 궤적으로 바로 넘어가지 않고 예측으로 버틴다.
      const followedAlive = followed != null && f - followedSeenF <= 3;
      const defectHoldNow = dActions?.holdIdDecision === true;
      if ((mode.hysteresis || defectHoldNow) && followedAlive && top.tk !== followed) {
        const prev = effective.find((c) => c.tk === followed) ?? null;
        // 히스테리시스는 "공간 신호 한 프레임" 으로 갈아타는 것을 막는다. 이번 프레임에 새로 잰
        // Re-ID 가 새 궤적을 더 높게 보면 근거 있는 전환이다 — 교차 중 궤적 번호가 뒤바뀌는
        // 경우(TrackletStore 는 겹친 두 사람 사이에서 번호를 바꿀 수 있다)를 바로잡는 길이기도 하다.
        const freshSupport = top.appearance != null && (prev?.appearance != null
          ? top.appearance > prev.appearance
          : top.appearance >= 0.8);
        const need = Math.max(mode.hysteresis ? judge.requiredFrames({
          crowdCrossing: crowd, lightingChanged, smallObject, fastPoseChange, gmcConfidence,
          sameUniformLikely: false, cameraStable: gmcOk,
        }) : 1, defectHoldNow ? Math.max(2, dActions?.minConfirmFrames ?? 2) : 1);
        if (switchCandidate === top.tk) switchStreak += 1;
        else {
          switchCandidate = top.tk;
          switchStreak = 1;
        }
        const prevStillPlausible = prev != null && (boxIoU(prev.d.box, predBox) >= 0.15 || boxIoU(prev.d.box, lastBox) >= 0.2);
        // 궤적 번호가 끊겨 같은 사람이 새 번호를 받은 경우: 따라가던 궤적이 이번 프레임에 없고,
        // 운동·외곽선이 단기 메모리와 이어지며 HSV 가 충돌하지 않으면 같은 트랙의 연속으로 본다.
        // 군중 교차 중에는 쓰지 않는다. 외곽선 혼자로는 열리지 않는다(운동 일치가 함께 필요).
        const cue = cueByTk.get(top.tk);
        const lightContinues = active && !crowd && prev == null && cue != null
          && cue.motion.score != null && cue.motion.score >= 0.5
          && cue.contour.score != null && cue.contour.reliability >= 0.3 && cue.contour.score >= cfg.thresholds.contourAgree
          && (cue.hsv.score == null || cue.hsv.reliability < 0.3 || cue.hsv.score >= cfg.thresholds.hsvConflict);
        if (!freshSupport && !lightContinues && switchStreak < need) {
          if (prevStillPlausible) top = prev!;
          else holdSwitch = true;
        }
      } else {
        switchStreak = 0;
        switchCandidate = null;
      }
    }
    if (holdSwitch) {
      gap += 1;
      stableFrames = 0;
      state = gap > maxFillFrames ? 'lost' : 'coasting';
    } else if (state !== 'lost' && top && continuityOk && gap <= maxFillFrames) {
      assigned = top.d;
      if (gap > 0 && mode.verifier && !mode.shadow) tentativeLeft = 2;
      tentative = tentativeLeft > 0;
      if (tentativeLeft > 0) tentativeLeft -= 1;
      if (top.tk !== followed) {
        stableFrames = 0;
        followChanges.push(tSec);
      }
      followed = top.tk;
      state = 'tracked';
      gap = 0;
      stableFrames += 1;
    } else {
      gap += 1;
      stableFrames = 0;
      state = state === 'lost' || gap > maxFillFrames ? 'lost' : 'coasting';
    }

    // 자동 재획득은 끔. LOST 에서 "켰다면" 을 shadow 로만 잰다.
    let shadowReacquire: FrameLog['shadowReacquire'] = null;
    if (state === 'lost' && anchorDesc && dets.length) {
      let best: { d: PreparedDetection; s: number } | null = null;
      for (const d of dets) {
        const desc = heavyDescriptor(prep, f, d);
        if (!desc) continue;
        const s = similarity(anchorDesc, desc);
        if (!best || s > best.s) best = { d, s };
      }
      if (best && best.s >= 0.8) shadowReacquire = best.d.truthId === clip.targetId && best.d.truthIds.length === 1 ? 'correct' : 'false';
    }

    // 예측기 갱신 (연결 뒤)
    if (assigned) lastBox = assigned.box;
    else if (pred.box) lastBox = gmcOk ? predBox : { ...pred.box };
    pred = predictor.observe({
      tSec, center: null, box: assigned ? assigned.box : null,
      detectionConfidence: assigned ? assigned.confidence : null,
      occlusion: assigned ? 'visible' : 'unknown',
      frame: { width: SIM_W, height: SIM_H },
    }, { horizonSec: dt });
    heldLast = assigned != null;

    const overlapping = assigned != null && dets.some((d) => d !== assigned && boxIoU(d.box, assigned!.box) > 0.2);
    // watch 는 "옆에 누가 있다" 일 뿐이다. 표본을 막는 것은 elevated/ask 다.
    const switchRiskLow = decision.switchRisk !== 'elevated' && decision.switchRisk !== 'ask';

    // 단기 외곽선 메모리 (verifier 가 켜졌을 때만. shadow 도 계산은 한다)
    if (mode.verifier && assigned && assigned.contour) {
      const q = maskQualityFor(assigned.contour, assigned.confidence, assigned.box, memory, tMs, flags, frame.blur);
      const res = memory.admit(tMs, assigned.contour, assigned.hsv, {
        trackingConfidence: continuityOk ? Math.min(1, 0.5 + 0.5 * (top?.motion ?? 0)) : 0,
        maskQuality: q.blockers.length ? 0 : q.quality,
        crowdCrossing: crowd, occluded: !heldLast, switchRiskLow, gmcConfidence, tentative,
      }, { method: flags.contourDistanceMethod, sport });
      if (res.admitted) {
        admitted += 1;
        if (assigned.hsv) hsvMemory = assigned.hsv;
      } else for (const b of res.blockers) bump(blocked, b);
      maxHeld = Math.max(maxHeld, memory.size);
    }

    // 갤러리 (제품: 추출이 있고 admitInspect 일 때만)
    let galleryStored = false;
    let galleryContaminated = false;
    let galleryBlocked = false;
    let galleryBlockedWouldContaminate = false;
    // 다음 프레임 결함 특징용: 따라가는 후보의 이번 외곽선·HSV 점수 (직전 값으로만 쓰인다)
    if (cfg.defect) {
      const cu = followed != null ? cueByTk.get(followed) : undefined;
      prevContourScore = cu?.contour.score ?? Number.NaN;
      prevHsvScore = cu?.hsv.score ?? Number.NaN;
    }
    if (assigned && decision.admitInspect && decision.extract && state === 'tracked' && !tentative) {
      const desc = heavyDescriptor(prep, f, assigned);
      let allowed = desc != null;
      if (allowed && active && flags.enableContourGalleryGate) {
        const pick = effective.find((c) => c.d === assigned);
        const others = effective.filter((c) => c.d !== assigned && c.appearance != null).map((c) => c.appearance as number);
        const margin = pick?.appearance != null ? pick.appearance - (others.length ? Math.max(...others) : 0) : 0;
        allowed = galleryUpdateGate({
          trackingConfidence: continuityOk ? 0.8 : 0.3,
          crowdCrossing: crowd, occluded: !heldLast, gmcConfidence,
          reidSelfCheckPassed: pick?.appearance != null && pick.appearance >= 0.62,
          stableFrames, reidMargin: others.length ? margin : 1,
        }).allowed;
      }
      // 결함 제어: 위험 구간이면 저장 시도 자체를 막는다 (갤러리 차단이 ID 확정보다 우선)
      if (allowed && desc && dActions?.blockGalleryUpdate) {
        allowed = false;
        galleryBlocked = true;
        const tgb = frame.gt.find((x) => x.id === clip.targetId);
        const onT = tgb?.visibleBox ? boxIoU(assigned.box, tgb.visibleBox) >= 0.5 : false;
        const mix = frame.gt.some((x) => x.id !== clip.targetId && x.visibleBox && boxIoU(assigned!.box, x.visibleBox) > 0.3);
        galleryBlockedWouldContaminate = !onT || mix || assigned.truthIds.length > 1;
      }
      if (allowed && desc) {
        const res = gallery.observe({
          tSec, trackId: 'subject', quality: 0.8, visibility: [true, true, true], box: assigned.box,
          overlapOthers: overlapping, cameraOk: true, gmcOk, descriptor: desc, trackingLost: false,
          crossing: overlapping, appearanceJump: false, trajectoryBreak: false, knownOtherConflict: false,
          rivalSimilarity: null,
        });
        if (res.stored) {
          galleryStored = true;
          if (pastSamples.length < 8) {
            pastSamples.push({ id: `g-${f}`, descriptor: desc, source: 'verified_auto', trackId: 'subject', tSec });
          }
          // 채점 전용: 대상이 아닌 사람이 들어갔거나 다른 사람과 섞였는가
          const tg = frame.gt.find((x) => x.id === clip.targetId);
          const onTarget = tg?.visibleBox ? boxIoU(assigned.box, tg.visibleBox) >= 0.5 : false;
          const mixed = frame.gt.some((x) => x.id !== clip.targetId && x.visibleBox && boxIoU(assigned!.box, x.visibleBox) > 0.3);
          galleryContaminated = !onTarget || mixed || assigned.truthIds.length > 1;
        }
      }
    }

    // 채점 전용
    const tg = frame.gt.find((x) => x.id === clip.targetId);
    const targetObservable = tg != null && tg.visibleBox != null && tg.visiblePixels >= 25 && tg.visibleRatio >= 0.2;
    let matchedId: number | null = null;
    if (assigned) {
      let bestIou = 0;
      for (const gtp of frame.gt) {
        if (!gtp.visibleBox) continue;
        const iou = boxIoU(assigned.box, gtp.visibleBox);
        if (iou > bestIou) {
          bestIou = iou;
          matchedId = gtp.id;
        }
      }
      if (bestIou < 0.5) matchedId = -1;
    }
    out.push({
      f,
      assigned: assigned ? assigned.box : null,
      matchedId,
      targetObservable,
      targetBox: tg?.visibleBox ?? null,
      extracted: decision.extract,
      describeCalls,
      skippedByContour,
      requestedByContour,
      virtualSkip,
      virtualRequest,
      tier: verdict ? verdict.tier : null,
      gated: gated.length,
      demoted: demotedSet.size,
      demotedTarget: gated.some((c) => demotedSet.has(c.tk) && c.d.truthId === clip.targetId && c.d.truthIds.length === 1),
      resolvedByCached,
      galleryStored,
      galleryContaminated,
      tentative,
      gapBefore,
      state,
      shadowReacquire,
      gmcOk,
      crowd,
      contourGated: contourGatedReasons[0] ?? null,
      galleryBlocked,
      galleryBlockedWouldContaminate,
      defectHold: dActions?.holdIdDecision ?? false,
      defectForcedReid,
      defectGmcRecheck: defectStep?.recommended.gmcRecheck ?? 'none',
      defectSliced: defectStep?.recommended.requestSlicedDetection ?? false,
      defectRecommendedActive: defectStep?.recommended.active,
      debug: cfg.debug
        ? `fol=${followed} ` + effective.map((c) => {
          const cu = cueByTk.get(c.tk);
          const cs = cu?.contour.score != null ? `${cu.contour.score.toFixed(2)}/${cu.contour.reliability.toFixed(2)}` : '-';
          const hs = cu?.hsv.score != null ? `${cu.hsv.score.toFixed(2)}/${cu.hsv.reliability.toFixed(2)}` : '-';
          return `${c.tk}:${c.d.truthId}:${c.score.toFixed(2)}:${c.appearance?.toFixed(2) ?? '-'}:c=${cs}:h=${hs}`;
        }).join(' ')
          + (verdict ? ` T=${verdict.tier} dem=${verdict.demoted.join(',')}` : '')
        : undefined,
    });
  }
  return {
    key: prep.key, ablation: cfg.ablation, scenario: clip.spec.scenario, sport: clip.spec.sport, seed: clip.spec.seed,
    anchorFrame, frames: out, prototypesAdmitted: admitted, prototypesBlocked: blocked, maxPrototypesHeld: maxHeld,
  };
}
