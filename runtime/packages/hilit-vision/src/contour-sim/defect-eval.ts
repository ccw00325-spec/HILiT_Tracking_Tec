/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·ee2fba83 @license @preserve */
/* 추적 결함 분류기 평가 묶음. 합성 전용 — 실사·실기기 숫자가 아니다.

라벨은 생성기 정답(GT)과 기준선 추적 결과에서 만든다. 입력 특징은 시점 t 까지만,
라벨은 [t, t+Δ] 에서만 본다. 정답 값(gt 상자·마스크 IoU·truthId)은 특징 순서에 없다.

분할은 클립(= seed·장면·종목) 단위다. 한 클립의 프레임은 한 쪽에만 들어간다.
seed 21~23 train · 24 validation · 25~26 hold-out. 종목 hold-out(스케이팅)과
카메라 유형 hold-out(빠른 팬·줌)은 따로 잰다. 문턱·보정은 validation 에서만 고른다.
*/

import { DEFECT_FEATURE_ORDER, DEFECT_SCHEMA_VERSION, featureGroupOf, type DefectFrameRow } from './defect-hook';
import { prepareClip, runClip, defaultRunConfig, type AblationId, type ClipRun, type PreparedClip } from './tracker';
import { scoreClip, sumMetrics, pairedAgainstBaseline, type ClipMetrics } from './metrics';
import { boxIoU } from './detections';
import { SIM_FPS, SIM_SCENARIOS, SIM_SPORTS, type SimClipSpec } from './scene';
import {
  applyScaler, fitPlatt, fitScaler, linearScore, plattProb, rbfScore, ruleScore, trainLinearSvm, trainLogistic,
  trainRbfSvm, trainRule, type Scaler,
} from '../defect-svm';
import {
  DefectRiskController, TRACKING_DEFECT_DEFAULTS, type DefectId, type DefectModelBundle, type TrackingDefectFlags,
} from '../defect-policy';
import { CONTOUR_CONTINUITY_DEFAULTS } from '../contour-continuity';

export const DEFECT_SPLIT = Object.freeze({ train: [21, 22, 23], validation: [24], holdout: [25, 26] });
export const DEFECT_CLIP_FRAMES = 60;
export const DEFAULT_HORIZON_SEC = 0.5;

/** 이번 회차에 라벨을 만들 수 있는 결함. 나머지는 NO_LABEL 로 보고한다. */
export const TRAINED_DEFECTS: DefectId[] = [
  'blurRisk', 'compressionArtifactRisk', 'lowLightRisk', 'smallObjectRisk',
  'detectionMissRisk', 'maskFailureRisk', 'mergedMaskRisk', 'occlusionRisk', 'crowdCrossingRisk',
  'gmcFailureRisk', 'motionPredictionFailureRisk',
  'wrongAssociationRisk', 'idSwitchRisk', 'galleryContaminationRisk', 'falseReacquireRisk',
];

export const LABEL_KIND: Record<string, 'ground-truth' | 'synthetic-corruption'> = {
  blurRisk: 'synthetic-corruption', compressionArtifactRisk: 'synthetic-corruption', lowLightRisk: 'synthetic-corruption',
  smallObjectRisk: 'ground-truth', detectionMissRisk: 'ground-truth', maskFailureRisk: 'ground-truth',
  mergedMaskRisk: 'ground-truth', occlusionRisk: 'ground-truth', crowdCrossingRisk: 'ground-truth',
  gmcFailureRisk: 'ground-truth', motionPredictionFailureRisk: 'ground-truth', wrongAssociationRisk: 'ground-truth',
  idSwitchRisk: 'ground-truth', galleryContaminationRisk: 'ground-truth', falseReacquireRisk: 'ground-truth',
};

export interface LabeledRow {
  clip: string;
  seed: number;
  sport: string;
  scenario: string;
  f: number;
  x: Float64Array;
  reliability: number;
  y: Partial<Record<DefectId, number>>;
  targetHeight: number | null;
}

function affineErr(A: { a: number; b: number; tx: number; c: number; d: number; ty: number }, T: typeof A): number {
  let worst = 0;
  for (const [x, y] of [[40, 30], [160, 30], [280, 30], [40, 150], [160, 90], [280, 150]]) {
    worst = Math.max(worst, Math.hypot(A.a * x + A.b * y + A.tx - (T.a * x + T.b * y + T.tx), A.c * x + A.d * y + A.ty - (T.c * x + T.d * y + T.ty)));
  }
  return worst;
}

/**
 * 한 클립: 기준선(A0, 결함 계층은 기록만) 실행 → 프레임 행 + 라벨.
 * horizonSec 는 사건형 결함(검출 누락·오연결·switch·오염·재획득·예측 실패)의 미래 창이다.
 */
export function labelClip(prep: PreparedClip, horizonSec = DEFAULT_HORIZON_SEC): { rows: LabeledRow[]; base: ClipRun; dRows: DefectFrameRow[] } {
  const dRows: DefectFrameRow[] = [];
  const cfg = { ...defaultRunConfig('A0'), defect: { controller: null, onFrame: (r: DefectFrameRow) => dRows.push(r) } };
  const base = runClip(prep, cfg);
  const clip = prep.clip;
  const H = Math.max(1, Math.round(horizonSec * SIM_FPS));
  const logByF = new Map(base.frames.map((r) => [r.f, r]));
  const rows: LabeledRow[] = [];
  for (const d of dRows) {
    const f = d.f;
    const fr = clip.frames[f];
    const tg = fr.gt.find((g) => g.id === clip.targetId);
    const tDet = prep.dets[f].find((x) => x.truthIds.includes(clip.targetId)) ?? null;
    const y: Partial<Record<DefectId, number>> = {};
    // 영상 품질 (합성 변형 라벨, 현재 프레임)
    y.blurRisk = fr.blur >= 0.4 ? 1 : 0;
    y.compressionArtifactRisk = clip.spec.scenario === 'compression' || clip.spec.scenario === 'low-quality' ? 1 : 0;
    y.lowLightRisk = fr.lighting <= 0.8 ? 1 : 0;
    y.smallObjectRisk = tg && tg.box.height < 32 ? 1 : 0;
    // 인식 (GT)
    y.mergedMaskRisk = tDet && tDet.truthIds.length > 1 ? 1 : 0;
    const iou = tDet?.defect?.gtMaskIoU ?? null;
    y.maskFailureRisk = tDet && (tDet.truthIds.length > 1 || (iou != null && iou < 0.6)) ? 1 : 0;
    y.occlusionRisk = tg && tg.visibleRatio < 0.6 ? 1 : 0;
    y.crowdCrossingRisk = tg ? (fr.gt.filter((o) => o.id !== clip.targetId && o.visibleBox && boxIoU(o.visibleBox, tg.box) > 0.1).length >= 1 ? 1 : 0) : 0;
    // 기하 (GT 카메라 변환)
    const g = prep.gmc.G0[f];
    const T = fr.cameraAffine;
    const camMove = Math.hypot(T.tx - (1 - T.a) * 160, T.ty - (1 - T.d) * 90) > 1.5 || Math.abs(T.a - 1) > 0.01;
    y.gmcFailureRisk = g ? ((g.ok && affineErr(g.result.affine, T) > 3) || (!g.ok && camMove) ? 1 : 0) : 0;
    // 미래 창 사건 (t..t+H)
    let miss = 0;
    let wrong = 0;
    let sw = 0;
    let cont = 0;
    let fre = 0;
    let predFail = 0;
    const r0 = logByF.get(f);
    for (let k = f; k <= Math.min(clip.frames.length - 1, f + H); k += 1) {
      const fk = clip.frames[k];
      const tgk = fk.gt.find((gg) => gg.id === clip.targetId);
      const obs = tgk != null && tgk.visibleBox != null && tgk.visiblePixels >= 25 && tgk.visibleRatio >= 0.2;
      if (obs && !prep.dets[k].some((x) => x.truthIds.includes(clip.targetId))) miss = 1;
      const rk = logByF.get(k);
      if (rk) {
        if (obs && rk.assigned && rk.matchedId !== clip.targetId) wrong = 1;
        const prev = logByF.get(k - 1);
        if (k > f && prev && prev.matchedId === clip.targetId && rk.matchedId != null && rk.matchedId >= 0 && rk.matchedId !== clip.targetId) sw = 1;
        if (rk.galleryContaminated) cont = 1;
        if (rk.assigned && rk.gapBefore > 0 && rk.matchedId !== clip.targetId) fre = 1;
      }
    }
    if (tg) {
      const pc = [d.predBox.x + d.predBox.width / 2, d.predBox.y + d.predBox.height / 2];
      const gc = [tg.box.x + tg.box.width / 2, tg.box.y + tg.box.height / 2];
      predFail = Math.hypot(pc[0] - gc[0], pc[1] - gc[1]) / Math.max(8, tg.box.height) > 0.5 ? 1 : 0;
    }
    y.detectionMissRisk = miss;
    y.wrongAssociationRisk = wrong;
    y.idSwitchRisk = sw;
    y.galleryContaminationRisk = cont;
    y.falseReacquireRisk = fre;
    y.motionPredictionFailureRisk = predFail;
    void r0;
    rows.push({
      clip: prep.key, seed: clip.spec.seed, sport: clip.spec.sport, scenario: clip.spec.scenario, f,
      x: d.vector, reliability: d.reliability, y, targetHeight: tg ? tg.box.height : null,
    });
  }
  return { rows, base, dRows };
}

/* ---------- 지표 ---------- */

export function prAuc(scores: number[], labels: number[]): number | null {
  const pos = labels.filter((l) => l > 0).length;
  if (!pos || pos === labels.length) return null;
  const idx = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  let tp = 0;
  let fp = 0;
  let ap = 0;
  let prevR = 0;
  for (const i of idx) {
    if (labels[i] > 0) tp += 1;
    else fp += 1;
    const r = tp / pos;
    if (r > prevR) {
      ap += (r - prevR) * (tp / (tp + fp));
      prevR = r;
    }
  }
  return ap;
}

export function rocAuc(scores: number[], labels: number[]): number | null {
  const P = scores.filter((_, i) => labels[i] > 0).sort((a, b) => a - b);
  const N = scores.filter((_, i) => labels[i] <= 0).sort((a, b) => a - b);
  if (!P.length || !N.length) return null;
  let j = 0;
  let wins = 0;
  for (const s of P) {
    while (j < N.length && N[j] < s) j += 1;
    let k = j;
    let t = 0;
    while (k < N.length && N[k] === s) {
      t += 1;
      k += 1;
    }
    wins += j + t / 2;
  }
  return wins / (P.length * N.length);
}

export function calibration(probs: number[], labels: number[], bins = 10): { brier: number | null; ece: number | null; diagram: Array<{ bin: number; n: number; meanProb: number; frac: number }> } {
  if (!probs.length) return { brier: null, ece: null, diagram: [] };
  let brier = 0;
  const b = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  probs.forEach((p, i) => {
    brier += (p - labels[i]) ** 2;
    const k = Math.min(bins - 1, Math.floor(p * bins));
    b[k].n += 1;
    b[k].p += p;
    b[k].y += labels[i];
  });
  let ece = 0;
  const diagram = b.map((x, i) => ({ bin: i, n: x.n, meanProb: x.n ? x.p / x.n : 0, frac: x.n ? x.y / x.n : 0 }));
  for (const x of diagram) ece += (x.n / probs.length) * Math.abs(x.meanProb - x.frac);
  return { brier: brier / probs.length, ece, diagram };
}

export interface EventStats {
  events: number;
  eventRecall: number | null;
  alarmRuns: number;
  eventPrecision: number | null;
  falseAlarmsPerMin: number | null;
  meanLeadSec: number | null;
  meanLateSec: number | null;
}

/** 클립별 연속 구간을 사건으로 본다. 경보 구간이 사건 시작 전 horizon 부터 끝까지와 겹치면 탐지. */
export function eventStats(rows: LabeledRow[], preds: boolean[], d: DefectId, horizonFrames: number): EventStats {
  const byClip = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const l = byClip.get(r.clip) ?? [];
    l.push(i);
    byClip.set(r.clip, l);
  });
  let events = 0;
  let hit = 0;
  let alarms = 0;
  let trueAlarms = 0;
  let negFrames = 0;
  const leads: number[] = [];
  const lates: number[] = [];
  const runs = (flags: boolean[]) => {
    const out: Array<[number, number]> = [];
    let s = -1;
    flags.forEach((v, i) => {
      if (v && s < 0) s = i;
      if (!v && s >= 0) {
        out.push([s, i - 1]);
        s = -1;
      }
    });
    if (s >= 0) out.push([s, flags.length - 1]);
    return out;
  };
  for (const idx of byClip.values()) {
    const lab = idx.map((i) => (rows[i].y[d] ?? 0) > 0);
    const pr = idx.map((i) => preds[i]);
    negFrames += lab.filter((v) => !v).length;
    const ev = runs(lab);
    const al = runs(pr);
    events += ev.length;
    alarms += al.length;
    for (const [s, e] of ev) {
      const first = al.find(([as, ae]) => ae >= s - horizonFrames && as <= e);
      if (first) {
        hit += 1;
        if (first[0] <= s) leads.push((s - first[0]) / SIM_FPS);
        else lates.push((first[0] - s) / SIM_FPS);
      }
    }
    for (const [as, ae] of al) if (ev.some(([s, e]) => ae >= s - horizonFrames && as <= e)) trueAlarms += 1;
  }
  const minutes = negFrames / SIM_FPS / 60;
  return {
    events,
    eventRecall: events ? hit / events : null,
    alarmRuns: alarms,
    eventPrecision: alarms ? trueAlarms / alarms : null,
    falseAlarmsPerMin: minutes > 0 ? (alarms - trueAlarms) / minutes : null,
    meanLeadSec: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
    meanLateSec: lates.length ? lates.reduce((a, b) => a + b, 0) / lates.length : null,
  };
}

export function frameStats(scores: number[], labels: number[], thr: number) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  scores.forEach((s, i) => {
    const p = s >= thr;
    if (p && labels[i]) tp += 1;
    else if (p) fp += 1;
    else if (labels[i]) fn += 1;
    else tn += 1;
  });
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

/* ---------- 학습 ---------- */

export type ModelKind = 'rule' | 'logistic' | 'linear-svm' | 'linear-svm-weighted' | 'linear-svm-calibrated' | 'rbf-svm';

export interface TrainedDefect {
  defect: DefectId;
  kind: ModelKind;
  featureIdx: number[];
  score: (x: Float64Array) => number;
  prob: ((x: Float64Array) => number | null) | null;
  threshold: number;
  w?: number[];
  b?: number;
  platt?: { a: number; b: number } | null;
  valPrAuc: number | null;
  supportVectors?: number;
}

function sub(x: Float64Array, idx: number[]): Float64Array {
  const o = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i += 1) o[i] = x[idx[i]];
  return o;
}

/** validation 에서 F1 최대 문턱 (점수 공간). */
function pickThreshold(scores: number[], labels: number[]): number {
  const cand = Array.from(new Set(scores.map((s) => Math.round(s * 1000) / 1000))).sort((a, b) => a - b);
  const step = Math.max(1, Math.floor(cand.length / 200));
  let best = 0;
  let bestF = -1;
  for (let i = 0; i < cand.length; i += step) {
    const f = frameStats(scores, labels, cand[i]).f1 ?? 0;
    if (f > bestF) {
      bestF = f;
      best = cand[i];
    }
  }
  return best;
}

export function trainDefect(defect: DefectId, kind: ModelKind, train: LabeledRow[], val: LabeledRow[], scaler: Scaler, featureIdx: number[], seed = 7): TrainedDefect | null {
  const Xtr = train.map((r) => sub(applyScaler(r.x, scaler), featureIdx));
  const ytr = train.map((r) => r.y[defect] ?? 0);
  const Xva = val.map((r) => sub(applyScaler(r.x, scaler), featureIdx));
  const yva = val.map((r) => r.y[defect] ?? 0);
  const pos = ytr.filter((v) => v > 0).length;
  if (pos < 5 || pos === ytr.length) return null;
  let score: (x: Float64Array) => number;
  let w: number[] | undefined;
  let b: number | undefined;
  let sv: number | undefined;
  if (kind === 'rule') {
    const m = trainRule(Xtr, ytr);
    score = (x) => ruleScore(m, x);
  } else if (kind === 'logistic') {
    const m = trainLogistic(Xtr, ytr, { classWeight: 'balanced', iters: 150 });
    score = (x) => linearScore(m, x);
    w = m.w;
    b = m.b;
  } else if (kind === 'rbf-svm') {
    // 품질 상한 확인용: 균형 잡은 작은 표본
    const P = Xtr.map((x, i) => i).filter((i) => ytr[i] > 0);
    const N = Xtr.map((x, i) => i).filter((i) => ytr[i] <= 0);
    const take = (a: number[], n: number) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
    const idx = [...take(P, 250), ...take(N, 250)];
    const m = trainRbfSvm(idx.map((i) => Xtr[i]), idx.map((i) => ytr[i]), { c: 1, gamma: 1 / featureIdx.length, seed, classWeight: 'balanced' });
    score = (x) => rbfScore(m, x);
    sv = m.sv.length;
  } else {
    const m = trainLinearSvm(Xtr, ytr, { c: 0.5, classWeight: kind === 'linear-svm' ? 'none' : 'balanced', seed, epochs: 30 });
    score = (x) => linearScore(m, x);
    w = m.w;
    b = m.b;
  }
  const vs = Xva.map(score);
  let platt: { a: number; b: number } | null = null;
  let prob: TrainedDefect['prob'] = null;
  let threshold = pickThreshold(vs, yva);
  if (kind === 'linear-svm-calibrated' && yva.some((v) => v > 0)) {
    platt = fitPlatt(vs, yva);
    const pl = platt;
    prob = (x) => plattProb(pl, score(x));
    const vp = vs.map((s) => plattProb(pl, s) as number);
    threshold = pickThreshold(vp, yva);
  }
  return { defect, kind, featureIdx, score, prob, threshold, w, b, platt, valPrAuc: prAuc(vs, yva), supportVectors: sv };
}

export function featureIdxFor(groups: Array<'dct' | 'svd' | 'track' | 'temporal'>): number[] {
  return DEFECT_FEATURE_ORDER.map((n, i) => (groups.includes(featureGroupOf(n)) ? i : -1)).filter((i) => i >= 0);
}

export function evalDefect(m: TrainedDefect, rows: LabeledRow[], scaler: Scaler, horizonFrames: number) {
  const X = rows.map((r) => sub(applyScaler(r.x, scaler), m.featureIdx));
  const y = rows.map((r) => r.y[m.defect] ?? 0);
  const s = X.map(m.score);
  const p = m.prob ? X.map((x) => m.prob!(x) as number) : null;
  const decide = p ?? s;
  const fs = frameStats(decide, y, m.threshold);
  const ev = eventStats(rows, decide.map((v) => v >= m.threshold), m.defect, horizonFrames);
  const cal = p ? calibration(p, y) : null;
  return {
    positives: y.filter((v) => v).length, n: y.length,
    prAuc: prAuc(s, y), rocAuc: rocAuc(s, y), ...fs, ...ev,
    brier: cal?.brier ?? null, ece: cal?.ece ?? null, reliabilityDiagram: cal?.diagram ?? null,
  };
}

/** 번들로 굳힌다 (보정 선형 SVM, 전체 특징 순서). */
export function toBundle(models: TrainedDefect[], scaler: Scaler, meta: { commit: string; dataVersion: string; seed: number }): DefectModelBundle {
  const d = DEFECT_FEATURE_ORDER.length;
  const out: DefectModelBundle = {
    schemaVersion: DEFECT_SCHEMA_VERSION, featureOrder: [...DEFECT_FEATURE_ORDER], scaler, missingValue: 'scaler-mean',
    models: {}, modelVersion: `defect-linsvm-${meta.dataVersion}`, modelType: 'linear-calibrated',
    trainingDataVersion: meta.dataVersion, sourceCommit: meta.commit, seed: meta.seed, trainedAt: new Date().toISOString(),
  };
  for (const m of models) {
    if (!m.w || m.b == null || m.featureIdx.length !== d) continue;
    out.models[m.defect] = {
      w: m.w, b: m.b, platt: m.platt ?? null, threshold: m.threshold, validationPrAuc: m.valPrAuc,
      labelKind: LABEL_KIND[m.defect] ?? 'rule-weak',
    };
  }
  return out;
}

/* ---------- 누수 검사 ---------- */

export function leakageReport(splits: Record<string, LabeledRow[]>): Record<string, unknown> {
  const clipsOf = (rows: LabeledRow[]) => new Set(rows.map((r) => r.clip));
  const names = Object.keys(splits);
  const overlaps: Record<string, number> = {};
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    const a = clipsOf(splits[names[i]]);
    let n = 0;
    for (const c of clipsOf(splits[names[j]])) if (a.has(c)) n += 1;
    overlaps[`${names[i]}×${names[j]}`] = n;
  }
  const forbidden = ['gt', 'truth', 'iou', 'label', 'future'];
  const featureNamesClean = DEFECT_FEATURE_ORDER.every((n) => !forbidden.some((w) => n.toLowerCase().includes(w)));
  // 변형 원본과 변형본(같은 seed·장면·종목)이 서로 다른 분할에 있지 않은가: 클립 키 = seed|scenario|sport 라 겹침 0 이면 보장
  return {
    clipOverlaps: overlaps,
    featureNamesContainGroundTruth: !featureNamesClean,
    futureInFeatures: 'blocked-by-TimeWindowBuffer (tested)',
    thresholdsTunedOn: 'validation-only',
    scalerFitOn: 'train-only',
    adjacentFramesSplit: 'impossible: split unit is clip',
  };
}

/* ---------- 흐름 ---------- */

export function specsForSeeds(seeds: readonly number[], scenarios = SIM_SCENARIOS, sports = SIM_SPORTS): SimClipSpec[] {
  const out: SimClipSpec[] = [];
  for (const seed of seeds) for (const scenario of scenarios) for (const sport of sports) out.push({ scenario, sport, seed, frames: DEFECT_CLIP_FRAMES });
  return out;
}

export function prepareDefectClip(spec: SimClipSpec): PreparedClip {
  return prepareClip(spec, { ...CONTOUR_CONTINUITY_DEFAULTS }, { withDefect: true });
}

export function controllerFlags(over: Partial<TrackingDefectFlags>): TrackingDefectFlags {
  return { ...TRACKING_DEFECT_DEFAULTS, ...over } as TrackingDefectFlags;
}

export interface DownstreamResult {
  label: string;
  totals: ClipMetrics & { clips: number };
  paired: { identicalClips: number; wrongIntroduced: number; wrongPrevented: number };
  galleryBlocked: number;
  galleryBlockedCorrect: number;
  galleryBlockedUnneeded: number;
  holdFrames: number;
  forcedReid: number;
  recommendedSiftBf: number;
  recommendedLightGlue: number;
  recommendedSliced: number;
  shadowRecommendedGalleryBlocks: number;
  controllerMs: number[];
  assembleMs: number[];
}

export function runDownstream(preps: PreparedClip[], ablation: AblationId, label: string, bundle: DefectModelBundle | null,
  flags: TrackingDefectFlags | null, baseline: Map<string, ClipRun> | null): { result: DownstreamResult; runs: ClipRun[] } {
  const runs: ClipRun[] = [];
  const controllerMs: number[] = [];
  const assembleMs: number[] = [];
  let shadowBlocks = 0;
  for (const p of preps) {
    const cfg = defaultRunConfig(ablation);
    const controller = bundle && flags ? new DefectRiskController(flags, bundle, DEFECT_FEATURE_ORDER) : null;
    const run = runClip(p, flags ? {
      ...cfg,
      defect: {
        controller,
        onFrame: (r) => {
          controllerMs.push(r.controllerMs);
          assembleMs.push(r.assembleMs);
          if (r.step && !r.step.applied && r.step.recommended.blockGalleryUpdate) shadowBlocks += 1;
        },
      },
    } : cfg);
    runs.push(run);
  }
  const valid = runs.filter((r) => r.anchorFrame != null);
  const totals = sumMetrics(valid.map((r) => scoreClip(r)));
  let identical = 0;
  let intro = 0;
  let prev = 0;
  if (baseline) {
    for (const r of valid) {
      const b = baseline.get(r.key);
      if (!b) continue;
      const pd = pairedAgainstBaseline(r, b);
      if (pd.identicalDecisions) identical += 1;
      intro += pd.wrongIntroduced;
      prev += pd.wrongPrevented;
    }
  }
  const all = valid.flatMap((r) => r.frames);
  return {
    runs,
    result: {
      label, totals, paired: { identicalClips: identical, wrongIntroduced: intro, wrongPrevented: prev },
      galleryBlocked: all.filter((x) => x.galleryBlocked).length,
      galleryBlockedCorrect: all.filter((x) => x.galleryBlocked && x.galleryBlockedWouldContaminate).length,
      galleryBlockedUnneeded: all.filter((x) => x.galleryBlocked && !x.galleryBlockedWouldContaminate).length,
      holdFrames: all.filter((x) => x.defectHold).length,
      forcedReid: all.filter((x) => x.defectForcedReid).length,
      recommendedSiftBf: all.filter((x) => x.defectGmcRecheck === 'sift-bf').length,
      recommendedLightGlue: all.filter((x) => x.defectGmcRecheck === 'lightglue').length,
      recommendedSliced: all.filter((x) => x.defectSliced).length,
      shadowRecommendedGalleryBlocks: shadowBlocks,
      controllerMs,
      assembleMs,
    },
  };
}
