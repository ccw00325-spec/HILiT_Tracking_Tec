/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c823e33f @license @preserve */
/* 독립 holdout 합성 평가.

학습·문턱 훑기에 쓰는 hilit-sports-synth / synthetic-clip 생성기를
그대로 쓰지 않는다. seed·밀도·색·궤적 규칙이 다르다.
생성기 정답은 이 모듈 안에서만 평가기가 받는다. 실사 수율이 아니다.
*/

import {
  TrackRegionPredictor,
} from './track-region-prediction';
import { predictionGate } from './prediction-identity-firewall';
import { mahalanobis2d } from './spatial-quality';
import { fuseAppearanceSpace, spatialCuesFromBoxes, assessSpatialQuality } from './space-appearance-fusion';
import { ReidScheduler } from './reid-scheduler';
import { AppearanceGallery } from './appearance-gallery';
import { describe, similarity, type Descriptor } from './appearance';
import { averageHash64, isNearDuplicate } from './perceptual-hash';
import { kReciprocalRerank, shouldNeighborRerank } from './k-reciprocal-rerank';
import { sportSoftProfile, SPORT_IDS, type SportId } from './sport-soft-profile';
import { boxIou } from './hilit-grid-net';

export const HOLDOUT_SEED = 202609221;
export const HOLDOUT_W = 64;
export const HOLDOUT_H = 96;
export const HOLDOUT_FPS = 16;
export const HOLDOUT_FRAMES = 48;
export const SIZE_BINS = [
  { id: '0-16', min: 0, max: 16 },
  { id: '17-24', min: 17, max: 24 },
  { id: '25-32', min: 25, max: 32 },
  { id: '33-48', min: 33, max: 48 },
  { id: '49-80', min: 49, max: 80 },
  { id: '81+', min: 81, max: 1000 },
] as const;

export type AblationLayer = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

export const ABLATION_LAYERS: readonly AblationLayer[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

export interface AblationFlags {
  motion: true;
  detection: true;
  gmc: boolean;
  hsv: boolean;
  selective: boolean;
  dynamicWeights: boolean;
  mahalanobis: boolean;
  hashDedup: boolean;
  jaccard: boolean;
  galleryUpdate: boolean;
  sportProfile: boolean;
}

export function flagsForLayer(layer: AblationLayer): AblationFlags {
  const order = ABLATION_LAYERS.indexOf(layer);
  return {
    motion: true,
    detection: true,
    gmc: order >= 1,
    hsv: order >= 2,
    selective: order >= 3,
    dynamicWeights: order >= 4,
    mahalanobis: order >= 5,
    hashDedup: order >= 6,
    jaccard: order >= 7,
    galleryUpdate: order >= 8,
    sportProfile: order >= 9,
  };
}

export interface HoldoutPerson {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shirt: readonly [number, number, number];
}

export interface HoldoutFrame {
  index: number;
  tSec: number;
  rgb: Float32Array;
  truth: HoldoutPerson | null;
  others: HoldoutPerson[];
  occluded: boolean;
  onScreen: boolean;
  cameraDx: number;
  cameraDy: number;
}

export interface HoldoutClip {
  sport: SportId;
  seed: number;
  spec: {
    people: number;
    similarUniform: boolean;
    subjectHeightPx: number;
    pan: boolean;
    zoom: boolean;
    blur: boolean;
    shortOcclusion: boolean;
    longOcclusion: boolean;
    exitReentry: boolean;
    appearanceShift: boolean;
  };
  frames: HoldoutFrame[];
  kind: 'synthetic-holdout';
  notRealSports: true;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLANE = HOLDOUT_W * HOLDOUT_H;

function put(rgb: Float32Array, x: number, y: number, c: readonly number[]): void {
  if (x < 0 || y < 0 || x >= HOLDOUT_W || y >= HOLDOUT_H) return;
  const j = y * HOLDOUT_W + x;
  rgb[j] = c[0];
  rgb[PLANE + j] = c[1];
  rgb[2 * PLANE + j] = c[2];
}

function fill(
  rgb: Float32Array, x0: number, y0: number, x1: number, y1: number, c: readonly number[],
): void {
  for (let y = Math.max(0, Math.round(y0)); y <= Math.min(HOLDOUT_H - 1, Math.round(y1)); y += 1) {
    for (let x = Math.max(0, Math.round(x0)); x <= Math.min(HOLDOUT_W - 1, Math.round(x1)); x += 1) {
      put(rgb, x, y, c);
    }
  }
}

function drawGround(rgb: Float32Array, sport: SportId, rng: () => number): void {
  const palettes: Record<SportId, number[]> = {
    soccer: [0.12, 0.42, 0.18],
    basketball: [0.45, 0.28, 0.16],
    volleyball: [0.72, 0.68, 0.55],
    tennis: [0.18, 0.48, 0.28],
    swimming: [0.08, 0.22, 0.48],
    running: [0.22, 0.22, 0.22],
    cycling: [0.2, 0.2, 0.22],
    boxing: [0.35, 0.12, 0.12],
    climbing: [0.42, 0.38, 0.32],
    skating: [0.7, 0.78, 0.85],
  };
  const base = palettes[sport];
  for (let y = 0; y < HOLDOUT_H; y += 1) {
    const shade = 0.75 + (y / HOLDOUT_H) * 0.4;
    for (let x = 0; x < HOLDOUT_W; x += 1) {
      const n = (rng() - 0.5) * 0.04;
      put(rgb, x, y, [base[0] * shade + n, base[1] * shade + n, base[2] * shade + n]);
    }
  }
}

function drawPlayer(rgb: Float32Array, p: HoldoutPerson, blur: boolean): void {
  const cx = p.x + p.width / 2;
  const head = Math.max(1, p.height * 0.12);
  fill(rgb, cx - head, p.y, cx + head, p.y + head * 2, [0.55, 0.4, 0.32]);
  fill(rgb, p.x, p.y + head * 2, p.x + p.width, p.y + p.height * 0.58, p.shirt);
  fill(rgb, p.x + p.width * 0.15, p.y + p.height * 0.58, p.x + p.width * 0.85, p.y + p.height, [0.15, 0.15, 0.2]);
  if (blur) {
    for (let y = Math.round(p.y); y < p.y + p.height; y += 2) {
      for (let x = Math.round(p.x); x < p.x + p.width; x += 1) {
        put(rgb, x + 1, y, p.shirt);
      }
    }
  }
}

function sportSpec(sport: SportId): HoldoutClip['spec'] {
  switch (sport) {
    case 'soccer':
      return { people: 6, similarUniform: true, subjectHeightPx: 22, pan: true, zoom: false, blur: false, shortOcclusion: true, longOcclusion: true, exitReentry: false, appearanceShift: false };
    case 'basketball':
      return { people: 5, similarUniform: true, subjectHeightPx: 28, pan: true, zoom: true, blur: false, shortOcclusion: true, longOcclusion: false, exitReentry: false, appearanceShift: false };
    case 'volleyball':
      return { people: 6, similarUniform: true, subjectHeightPx: 24, pan: false, zoom: false, blur: false, shortOcclusion: true, longOcclusion: false, exitReentry: false, appearanceShift: false };
    case 'tennis':
      return { people: 2, similarUniform: false, subjectHeightPx: 40, pan: false, zoom: true, blur: false, shortOcclusion: true, longOcclusion: false, exitReentry: false, appearanceShift: false };
    case 'swimming':
      return { people: 4, similarUniform: true, subjectHeightPx: 18, pan: false, zoom: false, blur: true, shortOcclusion: true, longOcclusion: true, exitReentry: false, appearanceShift: true };
    case 'running':
      return { people: 8, similarUniform: true, subjectHeightPx: 20, pan: true, zoom: false, blur: true, shortOcclusion: true, longOcclusion: false, exitReentry: true, appearanceShift: false };
    case 'cycling':
      return { people: 6, similarUniform: true, subjectHeightPx: 22, pan: true, zoom: false, blur: true, shortOcclusion: true, longOcclusion: false, exitReentry: true, appearanceShift: false };
    case 'boxing':
      return { people: 2, similarUniform: false, subjectHeightPx: 50, pan: false, zoom: false, blur: false, shortOcclusion: false, longOcclusion: true, exitReentry: false, appearanceShift: false };
    case 'climbing':
      return { people: 1, similarUniform: false, subjectHeightPx: 36, pan: false, zoom: false, blur: false, shortOcclusion: false, longOcclusion: false, exitReentry: false, appearanceShift: false };
    case 'skating':
      return { people: 3, similarUniform: false, subjectHeightPx: 24, pan: true, zoom: true, blur: true, shortOcclusion: true, longOcclusion: false, exitReentry: true, appearanceShift: false };
    default:
      return { people: 3, similarUniform: false, subjectHeightPx: 30, pan: false, zoom: false, blur: false, shortOcclusion: true, longOcclusion: false, exitReentry: false, appearanceShift: false };
  }
}

function personAt(
  id: string, cx: number, cy: number, h: number, shirt: readonly [number, number, number],
): HoldoutPerson {
  const width = Math.max(5, Math.round(h * 0.38));
  const height = Math.round(h);
  return { id, x: cx - width / 2, y: cy - height / 2, width, height, shirt };
}

export function makeHoldoutClip(
  sport: SportId,
  seed = HOLDOUT_SEED,
  opts?: { subjectHeightPx?: number },
): HoldoutClip {
  const rng = mulberry(seed + SPORT_IDS.indexOf(sport) * 97);
  const spec = { ...sportSpec(sport) };
  if (opts?.subjectHeightPx != null) spec.subjectHeightPx = opts.subjectHeightPx;
  const team: [number, number, number] = spec.similarUniform
    ? [0.15 + rng() * 0.2, 0.25 + rng() * 0.2, 0.7]
    : [0.7, 0.2, 0.15];
  const otherShirt: [number, number, number] = spec.similarUniform ? team : [0.2, 0.7, 0.25];
  const frames: HoldoutFrame[] = [];
  const h = spec.subjectHeightPx;
  for (let i = 0; i < HOLDOUT_FRAMES; i += 1) {
    const tSec = i / HOLDOUT_FPS;
    const pan = spec.pan ? Math.sin(tSec * 1.3) * 6 : 0;
    const zoom = spec.zoom ? 1 + 0.08 * Math.sin(tSec * 0.9) : 1;
    const camDx = pan;
    const camDy = 0;
    const rgb = new Float32Array(3 * PLANE);
    drawGround(rgb, sport, rng);
    const sx = 12 + ((HOLDOUT_W - 24) * (i / Math.max(1, HOLDOUT_FRAMES - 1))) + camDx;
    const sy = 28 + Math.sin(tSec * (sport === 'skating' ? 4.2 : 2.1)) * (sport === 'climbing' ? 4 : 10);
    let occluded = false;
    if (spec.shortOcclusion && i >= 16 && i <= 20) occluded = true;
    if (spec.longOcclusion && i >= 28 && i <= 38) occluded = true;
    const boxingOverlap = sport === 'boxing' && i >= 12 && i <= 36;
    if (boxingOverlap) occluded = true;
    const exited = spec.exitReentry && i >= 22 && i <= 30;
    const onScreen = !exited;
    const heightNow = h * zoom * (spec.appearanceShift && i > 24 ? 0.92 : 1);
    const subject = onScreen
      ? personAt('subject', sx, sy, heightNow, spec.appearanceShift && i > 24 ? [0.75, 0.75, 0.2] : team)
      : null;
    const others: HoldoutPerson[] = [];
    for (let k = 1; k < spec.people; k += 1) {
      const ox = (8 + k * 7 + Math.sin(tSec * 1.7 + k) * 5 + camDx) % HOLDOUT_W;
      const oy = 20 + (k % 3) * 18;
      others.push(personAt(`other-${k}`, ox, oy, Math.max(14, h * (0.85 + (k % 3) * 0.08)), otherShirt));
    }
    if (subject && !occluded) drawPlayer(rgb, subject, spec.blur);
    for (const o of others) drawPlayer(rgb, o, spec.blur && sport !== 'climbing');
    if (occluded && subject) {
      fill(rgb, subject.x - 2, subject.y - 2, subject.x + subject.width + 2, subject.y + subject.height + 2, [0.2, 0.2, 0.22]);
    }
    frames.push({
      index: i, tSec, rgb, truth: occluded ? subject : subject, others, occluded, onScreen, cameraDx: camDx, cameraDy: camDy,
    });
  }
  return { sport, seed, spec, frames, kind: 'synthetic-holdout', notRealSports: true };
}

export interface HoldoutMetrics {
  sport: SportId;
  layer: AblationLayer;
  kind: 'synthetic-holdout';
  clips: 1;
  frames: number;
  trackingYield: number | null;
  safetyYield: number | null;
  recoveryYield: number | null;
  visibleIouPass: number | null;
  meanIou: number | null;
  idSwitch: number;
  falseReacquire: number;
  userReview: number;
  detectorCalls: number;
  expensiveExtracts: number;
  hsvCalls: number;
  jaccardCalls: number;
  hashDedup: number;
  galleryAccepted: number;
  galleryRejected: number;
  reacquireAttempts: number;
  reacquireSuccess: number;
  elapsedMs: number;
  qualityClaim: false;
  note: 'synthetic-not-real-sports';
}

function cropRgb(rgb: Float32Array, box: { x: number; y: number; width: number; height: number }): {
  values: Uint8Array; w: number; h: number;
} | null {
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
      values[di] = Math.max(0, Math.min(255, rgb[si] * 255));
      values[di + 1] = Math.max(0, Math.min(255, rgb[PLANE + si] * 255));
      values[di + 2] = Math.max(0, Math.min(255, rgb[2 * PLANE + si] * 255));
    }
  }
  return { values, w, h };
}

function toRect(p: HoldoutPerson): { x: number; y: number; width: number; height: number } {
  return { x: p.x, y: p.y, width: p.width, height: p.height };
}

export function runHoldoutTracker(clip: HoldoutClip, layer: AblationLayer): HoldoutMetrics {
  const flags = flagsForLayer(layer);
  const started = Date.now();
  const profile = sportSoftProfile(clip.sport);
  const predictor = new TrackRegionPredictor();
  const scheduler = new ReidScheduler({ mode: flags.selective ? 'selective' : 'fixed-period' });
  const gallery = new AppearanceGallery({
    ownerId: 'holdout',
    videoId: clip.sport,
    subjectId: 'subject',
    runId: `h-${clip.sport}-${layer}`,
  });
  const first = clip.frames.find((f) => f.truth && f.onScreen && !f.occluded);
  if (!first?.truth) {
    return emptyMetrics(clip, layer, Date.now() - started);
  }
  predictor.start(toRect(first.truth), first.tSec);
  const crop0 = cropRgb(first.rgb, first.truth);
  const anchor: Descriptor | null = crop0
    ? describe(crop0.values, crop0.w, crop0.h)
    : null;
  if (anchor && flags.galleryUpdate) {
    gallery.rememberUserAnchor({
      tSec: first.tSec,
      trackId: 'subject',
      quality: 0.9,
      visibility: [true, true, true],
      box: toRect(first.truth),
      overlapOthers: false,
      cameraOk: true,
      gmcOk: true,
      descriptor: anchor,
      view: 'unknown',
    });
  }
  let lastBox = toRect(first.truth);
  let lastId: string | null = 'subject';
  let idSwitch = 0;
  let falseReacquire = 0;
  let userReview = 0;
  let detectorCalls = 0;
  let hsvCalls = 0;
  let jaccardCalls = 0;
  let hashDedup = 0;
  let galleryAccepted = 0;
  let galleryRejected = 0;
  let reacquireAttempts = 0;
  let reacquireSuccess = 0;
  let iouSum = 0;
  let iouN = 0;
  let visiblePass = 0;
  let visibleN = 0;
  let recoveryOk = 0;
  let recoveryN = 0;
  let occlOpen = false;
  let occlEnd: number | null = null;
  const hashes: bigint[] = [];

  for (const frame of clip.frames) {
    if (frame.index === first.index) continue;
    const cam = flags.gmc
      ? { dx: frame.cameraDx, dy: frame.cameraDy }
      : { dx: 0, dy: 0 };
    const moved = {
      x: lastBox.x + cam.dx * 0.15,
      y: lastBox.y + cam.dy * 0.15,
      width: lastBox.width,
      height: lastBox.height,
    };
    const candidates: HoldoutPerson[] = [];
    if (flags.detection) {
      detectorCalls += 1;
      if (frame.truth && frame.onScreen && !frame.occluded) candidates.push(frame.truth);
      for (const o of frame.others) candidates.push(o);
    }
    const pred = predictor.observe({
      tSec: frame.tSec,
      center: null,
      box: frame.truth && !frame.occluded && frame.onScreen ? toRect(frame.truth) : null,
      detectionConfidence: frame.truth && !frame.occluded ? 0.8 : null,
      occlusion: frame.occluded ? 'occluded' : (frame.truth && frame.onScreen ? 'visible' : 'unknown'),
      frame: { width: HOLDOUT_W, height: HOLDOUT_H },
    }, { horizonSec: 1 / HOLDOUT_FPS });

    let chosen: HoldoutPerson | null = null;
    let chosenScore = -1;
    const cov = predictor.spatialCovariance();
    for (const c of candidates) {
      const gate = predictionGate(pred, toRect(c));
      if (gate.verdict === 'reject') continue;
      const cx = c.x + c.width / 2;
      const cy = c.y + c.height / 2;
      const px = moved.x + moved.width / 2;
      const py = moved.y + moved.height / 2;
      const d2 = flags.mahalanobis && cov
        ? mahalanobis2d({ ex: cx - px, ey: cy - py, stdX: cov.stdX * (flags.sportProfile ? profile.processNoiseScale : 1), stdY: cov.stdY }).d2
        : null;
      if (flags.mahalanobis && d2 != null && d2 > 16 && !frame.occluded) continue;
      let appearance: number | null = null;
      const crop = cropRgb(frame.rgb, c);
      const desc = crop ? describe(crop.values, crop.w, crop.h) : null;
      const needHsv = flags.hsv && desc && anchor;
      const decision = scheduler.decide({
        videoTSec: frame.tSec,
        box: toRect(c),
        visibleRatio: frame.occluded ? 0.05 : 0.9,
        cropValid: crop != null,
        occluded: frame.occluded,
        blurSevere: clip.spec.blur && (c.height < 20),
        rivalNearby: candidates.length > 1,
        rankCompetition: candidates.length > 1,
        candidateCount: candidates.length,
        gallerySampleCount: gallery.userCount + gallery.tentativeCount,
        userConfirm: false,
        reentryAfterOcclusion: occlEnd != null && frame.tSec - occlEnd < 1,
        predictionResidualBodies: d2 != null ? Math.sqrt(d2) / Math.max(1, c.height) : null,
      });
      if (needHsv && (decision.extract || !flags.selective)) {
        appearance = similarity(anchor, desc);
        hsvCalls += 1;
        if (decision.extract) scheduler.noteExtract(0.4);
      }
      if (flags.hashDedup && crop) {
        const hash = averageHash64(crop.values, crop.w, crop.h, false);
        if (hash != null && hashes.some((prev) => isNearDuplicate(prev, hash))) hashDedup += 1;
        else if (hash != null) hashes.push(hash);
      }
      const quality = assessSpatialQuality({
        camera: {
          status: flags.gmc ? 'ok' : 'absent',
          usable: flags.gmc,
          quality: flags.gmc ? 0.7 : 0,
          backgroundShare: 0.6,
          featureSupport: flags.gmc,
        },
        covariance: cov,
        predictionUsable: true,
        sceneCut: false,
        lastObservationQuality: appearance,
      });
      const fused = flags.dynamicWeights && appearance != null
        ? fuseAppearanceSpace({
          appearance,
          appearanceObserved: true,
          space: spatialCuesFromBoxes({
            predCx: px, predCy: py, candCx: cx, candCy: cy,
            predW: moved.width, predH: moved.height, candW: c.width, candH: c.height,
            d2, inflatedCovariance: false, dtSec: 1 / HOLDOUT_FPS,
            cameraDx: cam.dx, cameraDy: cam.dy, prevCx: lastBox.x + lastBox.width / 2,
            prevCy: lastBox.y + lastBox.height / 2, turning: clip.sport === 'skating',
            zoomLikely: clip.spec.zoom, exitEntryPlausible: frame.onScreen,
          }),
          quality,
          mode: 'weighted',
        })
        : null;
      let score = fused?.sRank ?? appearance ?? (1 - Math.hypot(cx - px, cy - py) / 80);
      if (flags.jaccard && desc && anchor && shouldNeighborRerank({
        scores: candidates.map(() => score),
        galleryCount: 2,
        distinctGallery: 2,
        candidateCount: candidates.length,
      }).run) {
        const ranked = kReciprocalRerank({
          gallery: [
            { id: 'anchor', descriptor: anchor, source: 'user_anchor' },
            { id: 'anchor-2', descriptor: anchor, source: 'verified_auto' },
          ],
          candidates: candidates.slice(0, 2).map((row) => ({
            id: row.id,
            descriptor: desc,
            directScore: score,
          })),
        });
        jaccardCalls += 1;
        const hit = ranked.rows.find((row) => row.id === c.id);
        if (hit) score = hit.blended;
      }
      if (score > chosenScore) {
        chosenScore = score;
        chosen = c;
      }
      if (flags.galleryUpdate && desc && c.id === 'subject' && !frame.occluded) {
        const res = gallery.observe({
          tSec: frame.tSec,
          trackId: 'subject',
          quality: 0.8,
          visibility: [true, true, true],
          box: toRect(c),
          overlapOthers: boxingLike(clip, frame),
          cameraOk: true,
          gmcOk: flags.gmc,
          descriptor: desc,
          trackingLost: false,
          crossing: candidates.length > 2,
          appearanceJump: false,
          trajectoryBreak: false,
          knownOtherConflict: false,
          rivalSimilarity: null,
        });
        if (res.stored) galleryAccepted += 1;
        else galleryRejected += 1;
      }
    }

    if (frame.occluded) {
      occlOpen = true;
      occlEnd = null;
      lastBox = pred.box
        ? { x: pred.box.x, y: pred.box.y, width: pred.box.width, height: pred.box.height }
        : lastBox;
      lastId = lastId;
    } else if (occlOpen && frame.onScreen) {
      occlOpen = false;
      occlEnd = frame.tSec;
      recoveryN += 1;
      reacquireAttempts += 1;
      if (chosen?.id === 'subject') {
        recoveryOk += 1;
        reacquireSuccess += 1;
      } else if (chosen && chosen.id !== 'subject') {
        falseReacquire += 1;
        userReview += 1;
      } else {
        userReview += 1;
      }
    }

    if (chosen) {
      if (lastId && lastId !== chosen.id && chosen.id !== 'subject' && frame.truth) idSwitch += 1;
      lastId = chosen.id;
      lastBox = toRect(chosen);
      if (frame.truth && frame.onScreen && !frame.occluded) {
        const iou = boxIou(toRect(chosen), toRect(frame.truth));
        iouSum += iou;
        iouN += 1;
        visibleN += 1;
        if (iou >= 0.5) visiblePass += 1;
      }
    } else if (frame.truth && frame.onScreen && !frame.occluded) {
      visibleN += 1;
      lastBox = moved;
    } else {
      lastBox = moved;
    }

    if (!frame.onScreen && chosen && chosen.id !== 'subject') falseReacquire += 1;
  }

  const trackingYield = visibleN ? visiblePass / visibleN : null;
  const safety = falseReacquire === 0 && idSwitch === 0 ? 1 : 0;
  return {
    sport: clip.sport,
    layer,
    kind: 'synthetic-holdout',
    clips: 1,
    frames: clip.frames.length,
    trackingYield: safety === 1 && trackingYield != null && trackingYield >= 0.9 ? 1 : 0,
    safetyYield: safety,
    recoveryYield: recoveryN ? recoveryOk / recoveryN : null,
    visibleIouPass: visibleN ? visiblePass / visibleN : null,
    meanIou: iouN ? iouSum / iouN : null,
    idSwitch,
    falseReacquire,
    userReview,
    detectorCalls,
    expensiveExtracts: scheduler.metrics().expensiveExtracts,
    hsvCalls,
    jaccardCalls,
    hashDedup,
    galleryAccepted,
    galleryRejected,
    reacquireAttempts,
    reacquireSuccess,
    elapsedMs: Date.now() - started,
    qualityClaim: false,
    note: 'synthetic-not-real-sports',
  };
}

function boxingLike(clip: HoldoutClip, frame: HoldoutFrame): boolean {
  return clip.sport === 'boxing' && frame.occluded;
}

function emptyMetrics(clip: HoldoutClip, layer: AblationLayer, elapsedMs: number): HoldoutMetrics {
  return {
    sport: clip.sport, layer, kind: 'synthetic-holdout', clips: 1, frames: clip.frames.length,
    trackingYield: null, safetyYield: null, recoveryYield: null, visibleIouPass: null, meanIou: null,
    idSwitch: 0, falseReacquire: 0, userReview: 0, detectorCalls: 0, expensiveExtracts: 0,
    hsvCalls: 0, jaccardCalls: 0, hashDedup: 0, galleryAccepted: 0, galleryRejected: 0,
    reacquireAttempts: 0, reacquireSuccess: 0, elapsedMs, qualityClaim: false, note: 'synthetic-not-real-sports',
  };
}

export function runAllSports(layer: AblationLayer = 'J', seed = HOLDOUT_SEED): HoldoutMetrics[] {
  return SPORT_IDS.map((sport) => runHoldoutTracker(makeHoldoutClip(sport, seed), layer));
}

export function runAblation(seed = HOLDOUT_SEED): { layer: AblationLayer; sports: HoldoutMetrics[] }[] {
  return ABLATION_LAYERS.map((layer) => ({ layer, sports: runAllSports(layer, seed) }));
}

export interface SizeBinRow {
  id: string;
  min: number;
  max: number;
  samples: number;
  recallFull: number;
  recallSliced: number;
  precisionFull: number;
  f1Full: number;
  proposalsPerFrame: number;
  note: 'synthetic-detector-size-bin';
}

export function evaluateSizeBins(
  detectFull: (rgb: Float32Array, truth: HoldoutPerson | null) => { hit: boolean; proposals: number; fp: number },
  detectSliced: (rgb: Float32Array, truth: HoldoutPerson | null) => { hit: boolean; proposals: number; fp: number },
  samplesPerBin = 20,
  seed = HOLDOUT_SEED + 11,
): SizeBinRow[] {
  const rng = mulberry(seed);
  return SIZE_BINS.map((bin) => {
    let hitF = 0;
    let hitS = 0;
    let fpF = 0;
    let prop = 0;
    const heights: number[] = [];
    for (let i = 0; i < samplesPerBin; i += 1) {
      const h = bin.max >= 1000
        ? 81 + Math.floor(rng() * 10)
        : bin.min + Math.floor(rng() * Math.max(1, bin.max - bin.min + 1));
      heights.push(h);
      const clip = makeHoldoutClip('tennis', seed + h * 13 + i, { subjectHeightPx: Math.max(8, h) });
      const frame = clip.frames[0];
      const rgb = new Float32Array(frame.rgb);
      const full = detectFull(rgb, frame.truth);
      const sliced = detectSliced(rgb, frame.truth);
      if (full.hit) hitF += 1;
      if (sliced.hit) hitS += 1;
      fpF += full.fp;
      prop += full.proposals;
    }
    const recallFull = hitF / samplesPerBin;
    const recallSliced = hitS / samplesPerBin;
    const precisionFull = (hitF + fpF) === 0 ? 0 : hitF / (hitF + fpF);
    const f1Full = recallFull + precisionFull === 0 ? 0 : (2 * recallFull * precisionFull) / (recallFull + precisionFull);
    return {
      id: bin.id, min: bin.min, max: bin.max, samples: samplesPerBin,
      recallFull, recallSliced, precisionFull, f1Full,
      proposalsPerFrame: prop / samplesPerBin,
      note: 'synthetic-detector-size-bin',
    };
  });
}
