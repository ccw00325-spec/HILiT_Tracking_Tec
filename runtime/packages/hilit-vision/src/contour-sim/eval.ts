/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·ee9aad10 @license @preserve */
/* 외곽선 연속성 검증기 평가 묶음. 합성 전용 — 실사·실기기 숫자가 아니다.

검증(validation) seed 에서만 문턱을 고르고, hold-out seed 에서는 고른 값을
그대로 한 번 돌린다. hold-out 결과를 보고 값을 다시 고치지 않는다.
*/

import {
  extractContourFeature, contourDistance, computeMaskQuality, contourVectorLength,
  type ContourDistanceMethod, type ContourFeature,
} from '../contour-feature';
import {
  CONTOUR_CONTINUITY_DEFAULTS, CONTOUR_OPERATING_POINTS,
  type ContourContinuityFlags, type TierThresholds,
} from '../contour-continuity';
import { renderClip, SIM_SCENARIOS, SIM_SPORTS, SIM_FPS, type SimClipSpec, type SimScenario, type SimSport } from './scene';
import { detectFrame } from './detections';
import {
  prepareClip, runClip, defaultRunConfig, type AblationId, type ClipRun, type GmcVariant, type PreparedClip, type SimRunConfig,
} from './tracker';
import { scoreClip, sumMetrics, pairedAgainstBaseline, type ClipMetrics } from './metrics';

export const VALIDATION_SEEDS = [11, 12, 13] as const;
export const HOLDOUT_SEEDS = [901, 902] as const;
export const CLIP_FRAMES = 60;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function round(v: number | null | undefined, d = 4): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

export function specsFor(seeds: readonly number[], scenarios: readonly SimScenario[] = SIM_SCENARIOS,
  sports: readonly SimSport[] = SIM_SPORTS): SimClipSpec[] {
  const out: SimClipSpec[] = [];
  for (const seed of seeds) for (const scenario of scenarios) for (const sport of sports) {
    out.push({ scenario, sport, seed, frames: CLIP_FRAMES });
  }
  return out;
}

/* ---------- A. 외곽선 자체 품질 ---------- */

export interface PairRow {
  same: boolean;
  score: number;
  total: number;
  quality: number;
  occlusion: number;
  height: number;
  sport: SimSport;
  scenario: SimScenario;
  lagFrames: number;
  poseChange: boolean;
}

export interface ContourStudyConfig {
  sampleCount: 32 | 48 | 64;
  maskScale: 1 | 0.5 | 0.25;
  method: ContourDistanceMethod;
}

export function studyKey(c: ContourStudyConfig): string {
  return `n${c.sampleCount}-s${c.maskScale}-${c.method}`;
}

export interface ContourStudyCell {
  config: ContourStudyConfig;
  rows: PairRow[];
  extractMs: number[];
  distanceMs: number[];
  vectorFloats: number;
}

/**
 * 같은 트랙(대상 f ↔ 대상 f+k) · 다른 트랙(대상 f ↔ 다른 사람 f+k) 쌍의 외곽선 거리.
 * 클립을 한 번만 그리고, 해상도·샘플 수·거리 방식을 모두 같은 탐지에서 잰다.
 * 정답 id 는 쌍을 만드는 데만 쓴다.
 */
export function contourStudy(specs: readonly SimClipSpec[], sampleCounts: ReadonlyArray<32 | 48 | 64>,
  scales: ReadonlyArray<1 | 0.5 | 0.25>, methods: readonly ContourDistanceMethod[], maxLag = 5): Map<string, ContourStudyCell> {
  const cells = new Map<string, ContourStudyCell>();
  for (const n of sampleCounts) for (const sc of scales) for (const m of methods) {
    const config = { sampleCount: n, maskScale: sc, method: m };
    cells.set(studyKey(config), { config, rows: [], extractMs: [], distanceMs: [], vectorFloats: contourVectorLength(n) });
  }
  for (const spec of specs) {
    const clip = renderClip(spec);
    for (const sc of scales) {
      const detsPerFrame = clip.frames.map((frame) => detectFrame(clip, frame, { maskScale: sc }));
      for (const n of sampleCounts) {
        const feats: Array<Array<{ id: number; f: ContourFeature; conf: number; box: { x: number; y: number; width: number; height: number } }>> = [];
        const extractTimes: number[] = [];
        for (const dets of detsPerFrame) {
          const row: typeof feats[number] = [];
          for (const d of dets) {
            if (!d.mask || d.truthIds.length !== 1) continue;
            const t0 = now();
            const f = extractContourFeature(d.mask, { sampleCount: n });
            extractTimes.push(now() - t0);
            if (f) row.push({ id: d.truthId, f, conf: d.confidence, box: d.box });
          }
          feats.push(row);
        }
        for (const m of methods) {
          const cell = cells.get(studyKey({ sampleCount: n, maskScale: sc, method: m }))!;
          cell.extractMs.push(...extractTimes);
          for (let i = 0; i < feats.length; i += 2) {
            const a = feats[i].find((r) => r.id === clip.targetId);
            if (!a) continue;
            for (let lag = 1; lag <= maxLag; lag += 2) {
              const j = i + lag;
              if (j >= feats.length) break;
              for (const b of feats[j]) {
                const t0 = now();
                const d = contourDistance(a.f, b.f, { method: m, sport: spec.sport });
                cell.distanceMs.push(now() - t0);
                if (!Number.isFinite(d.score)) continue;
                const q = computeMaskQuality(b.f, { detConfidence: b.conf, box: b.box, previous: a.f });
                cell.rows.push({
                  same: b.id === clip.targetId,
                  score: d.score,
                  total: d.total,
                  quality: q.blockers.length ? 0 : q.quality,
                  occlusion: b.f.global.occludedRatio + b.f.global.contactRatio + b.f.global.cutRatio,
                  height: b.f.global.height,
                  sport: spec.sport,
                  scenario: spec.scenario,
                  lagFrames: lag,
                  poseChange: spec.scenario === 'abrupt-pose-change',
                });
              }
            }
          }
        }
      }
    }
  }
  return cells;
}

export interface SeparationStats {
  samePairs: number;
  diffPairs: number;
  auc: number | null;
  /** 다른 트랙 통과 10% 에서 같은 트랙 통과율 */
  tmrAtFmr10: number | null;
  /** 주어진 문턱에서 */
  truePassAt: number | null;
  falsePassAt: number | null;
  precisionAt: number | null;
  recallAt: number | null;
  sameScoreP50: number | null;
  diffScoreP50: number | null;
  /** 정답 대 차선의 점수 차 p50 (같은 프레임쌍에서 대상 − 최고 타인) */
  marginP50?: number | null;
}

export function separation(rows: readonly PairRow[], threshold: number | null): SeparationStats {
  const same = rows.filter((r) => r.same).map((r) => r.score).sort((a, b) => a - b);
  const diff = rows.filter((r) => !r.same).map((r) => r.score).sort((a, b) => a - b);
  let auc: number | null = null;
  if (same.length && diff.length) {
    // 순위 기반 AUC
    let j = 0;
    let wins = 0;
    for (const s of same) {
      while (j < diff.length && diff[j] < s) j += 1;
      let k = j;
      let ties = 0;
      while (k < diff.length && diff[k] === s) {
        ties += 1;
        k += 1;
      }
      wins += j + ties / 2;
    }
    auc = wins / (same.length * diff.length);
  }
  const fmrThr = diff.length ? pct(diff, 0.9) : null;
  const tmr = fmrThr != null && same.length ? same.filter((s) => s > fmrThr).length / same.length : null;
  let tp: number | null = null;
  let fp: number | null = null;
  let precision: number | null = null;
  let recall: number | null = null;
  if (threshold != null && same.length && diff.length) {
    const tpn = same.filter((s) => s >= threshold).length;
    const fpn = diff.filter((s) => s >= threshold).length;
    tp = tpn / same.length;
    fp = fpn / diff.length;
    precision = tpn + fpn ? tpn / (tpn + fpn) : null;
    recall = tp;
  }
  return {
    samePairs: same.length,
    diffPairs: diff.length,
    auc: round(auc),
    tmrAtFmr10: round(tmr),
    truePassAt: round(tp),
    falsePassAt: round(fp),
    precisionAt: round(precision),
    recallAt: round(recall),
    sameScoreP50: round(pct(same, 0.5)),
    diffScoreP50: round(pct(diff, 0.5)),
  };
}

/**
 * 검증 쌍 분포로 외곽선 문턱을 고른다.
 *   conflict: 같은 트랙이 이 점수 아래로 떨어지는 비율 ≤ sameFloor
 *   agree:    다른 트랙이 이 점수 이상인 비율 ≤ diffCeil
 */
export function thresholdsFromPairs(rows: readonly PairRow[], sameFloor: number, diffCeil: number): { contourConflict: number; contourAgree: number } {
  const same = rows.filter((r) => r.same && r.quality >= CONTOUR_CONTINUITY_DEFAULTS.contourMinMaskQuality).map((r) => r.score).sort((a, b) => a - b);
  const diff = rows.filter((r) => !r.same && r.quality >= CONTOUR_CONTINUITY_DEFAULTS.contourMinMaskQuality).map((r) => r.score).sort((a, b) => a - b);
  const conflict = pct(same, sameFloor) ?? 0.2;
  const agree = pct(diff, 1 - diffCeil) ?? 0.5;
  return { contourConflict: round(conflict, 3) as number, contourAgree: round(Math.max(agree, conflict + 0.05), 3) as number };
}

/* ---------- B·C. 추적 ablation ---------- */

export interface ModeResult {
  ablation: AblationId;
  gmc: GmcVariant;
  label: string;
  totals: ClipMetrics & { clips: number };
  reidReductionVsA0: number | null;
  paired: { wrongIntroduced: number; wrongPrevented: number; skippedStillCorrect: number; skippedCausedError: number; identicalClips: number };
  byScenario: Record<string, ClipMetrics & { clips: number }>;
  bySport: Record<string, ClipMetrics & { clips: number }>;
  prototypesAdmitted: number;
  prototypeBlocked: Record<string, number>;
  maxPrototypesHeld: number;
}

export interface PreparedSet {
  clips: PreparedClip[];
  prepareMs: number;
}

export function prepareSet(specs: readonly SimClipSpec[], flags: ContourContinuityFlags): PreparedSet {
  const t0 = now();
  const clips = specs.map((s) => prepareClip(s, flags));
  return { clips, prepareMs: now() - t0 };
}

function group(runs: readonly ClipRun[], metrics: readonly ClipMetrics[], key: (r: ClipRun) => string): Record<string, ClipMetrics & { clips: number }> {
  const buckets = new Map<string, ClipMetrics[]>();
  runs.forEach((r, i) => {
    const k = key(r);
    const list = buckets.get(k) ?? [];
    list.push(metrics[i]);
    buckets.set(k, list);
  });
  const out: Record<string, ClipMetrics & { clips: number }> = {};
  for (const [k, list] of buckets) out[k] = sumMetrics(list);
  return out;
}

export function runMode(set: PreparedSet, cfg: SimRunConfig, baseline: ClipRun[] | null, label: string): { result: ModeResult; runs: ClipRun[] } {
  const runs = set.clips.map((c) => runClip(c, cfg));
  const valid = runs.filter((r) => r.anchorFrame != null);
  const metrics = valid.map((r) => scoreClip(r));
  const totals = sumMetrics(metrics);
  let wrongIntroduced = 0;
  let wrongPrevented = 0;
  let skippedStillCorrect = 0;
  let skippedCausedError = 0;
  let identicalClips = 0;
  if (baseline) {
    const bmap = new Map(baseline.map((b) => [b.key, b]));
    for (const r of valid) {
      const b = bmap.get(r.key);
      if (!b) continue;
      const p = pairedAgainstBaseline(r, b);
      wrongIntroduced += p.wrongIntroduced;
      wrongPrevented += p.wrongPrevented;
      skippedStillCorrect += p.skippedStillCorrect;
      skippedCausedError += p.skippedCausedError;
      if (p.identicalDecisions) identicalClips += 1;
    }
  }
  const blocked: Record<string, number> = {};
  let admitted = 0;
  let held = 0;
  for (const r of valid) {
    admitted += r.prototypesAdmitted;
    held = Math.max(held, r.maxPrototypesHeld);
    for (const [k, v] of Object.entries(r.prototypesBlocked)) blocked[k] = (blocked[k] ?? 0) + v;
  }
  const baseTotals = baseline ? sumMetrics(baseline.filter((b) => b.anchorFrame != null).map((b) => scoreClip(b))) : null;
  return {
    runs,
    result: {
      ablation: cfg.ablation,
      gmc: cfg.gmc,
      label,
      totals,
      reidReductionVsA0: baseTotals && baseTotals.heavyCalls > 0 ? round(1 - totals.heavyCalls / baseTotals.heavyCalls) : null,
      paired: { wrongIntroduced, wrongPrevented, skippedStillCorrect, skippedCausedError, identicalClips },
      byScenario: group(valid, metrics, (r) => r.scenario),
      bySport: group(valid, metrics, (r) => r.sport),
      prototypesAdmitted: admitted,
      prototypeBlocked: blocked,
      maxPrototypesHeld: held,
    },
  };
}

/** 표에 넣을 요약 줄 */
export function summaryRow(m: ModeResult): Record<string, number | string | null> {
  const t = m.totals;
  return {
    label: m.label,
    clips: t.clips,
    idf1: round(t.idf1),
    hota: round(t.hota),
    idSwitches: t.idSwitches,
    fragmentation: t.fragmentation,
    trackBreaks: t.trackBreaks,
    falseReacquire: t.falseReacquire,
    correctReacquire: t.correctReacquire,
    missedReacquire: t.missedReacquire,
    postReacquireSwitches: t.postReacquireSwitches,
    crowdMisconfirm: t.crowdMisconfirm,
    cascadeChains: t.cascadeChains,
    cascadeSeconds: round(t.cascadeSeconds, 1),
    galleryStored: t.galleryStored,
    galleryContaminated: t.galleryContaminated,
    heavyCalls: t.heavyCalls,
    heavyPerFrame: round(t.heavyCalls / Math.max(1, t.frames)),
    describeCalls: t.describeCalls,
    reidReductionVsA0: m.reidReductionVsA0,
    skippedByContour: t.skippedByContour,
    requestedByContour: t.requestedByContour,
    demotedRate: round(t.demotedCandidates / Math.max(1, t.gatedCandidates)),
    demotedTarget: t.demotedTarget,
    resolvedByCached: t.resolvedByCached,
    wrongIntroduced: m.paired.wrongIntroduced,
    wrongPrevented: m.paired.wrongPrevented,
    skippedStillCorrect: m.paired.skippedStillCorrect,
    skippedCausedError: m.paired.skippedCausedError,
    identicalClips: m.paired.identicalClips,
    shadowReacquireCorrect: t.shadowReacquireCorrect,
    shadowReacquireFalse: t.shadowReacquireFalse,
  };
}

export function withThresholds(point: keyof typeof CONTOUR_OPERATING_POINTS, contour: { contourConflict: number; contourAgree: number }): TierThresholds {
  return { ...CONTOUR_OPERATING_POINTS[point], ...contour };
}

export function configFor(ablation: AblationId, flags: Partial<ContourContinuityFlags>, thresholds: TierThresholds, gmc: GmcVariant = 'G0'): SimRunConfig {
  const cfg = defaultRunConfig(ablation, flags, 'balanced', gmc);
  return { ...cfg, thresholds };
}

/* ---------- GMC 정확도 (정답 카메라 변환이 있는 합성에서만) ---------- */

export function gmcAccuracy(set: PreparedSet, variant: 'G0' | 'G1'): {
  pairs: number; applied: number; appliedRate: number | null; errP50: number | null; errP95: number | null; errMax: number | null; harmful10px: number;
} {
  const errs: number[] = [];
  let pairs = 0;
  let applied = 0;
  let harmful = 0;
  for (const c of set.clips) {
    for (let f = 1; f < c.clip.frames.length; f += 1) {
      const g = c.gmc[variant][f];
      if (!g) continue;
      pairs += 1;
      if (!g.ok) continue;
      applied += 1;
      const T = c.clip.frames[f].cameraAffine;
      const A = g.result.affine;
      let worst = 0;
      for (const [x, y] of [[40, 30], [160, 30], [280, 30], [40, 90], [160, 90], [280, 90], [40, 150], [160, 150], [280, 150]]) {
        const ax = A.a * x + A.b * y + A.tx;
        const ay = A.c * x + A.d * y + A.ty;
        const tx = T.a * x + T.b * y + T.tx;
        const ty = T.c * x + T.d * y + T.ty;
        worst = Math.max(worst, Math.hypot(ax - tx, ay - ty));
      }
      errs.push(worst);
      if (worst > 10) harmful += 1;
    }
  }
  errs.sort((a, b) => a - b);
  return {
    pairs, applied, appliedRate: round(pairs ? applied / pairs : null),
    errP50: round(pct(errs, 0.5), 2), errP95: round(pct(errs, 0.95), 2), errMax: round(errs[errs.length - 1] ?? null, 2), harmful10px: harmful,
  };
}

export function timingSummary(values: readonly number[]): { n: number; mean: number | null; p50: number | null; p95: number | null; p99: number | null } {
  const s = values.slice().sort((a, b) => a - b);
  return {
    n: s.length,
    mean: round(s.length ? s.reduce((a, b) => a + b, 0) / s.length : null, 4),
    p50: round(pct(s, 0.5), 4),
    p95: round(pct(s, 0.95), 4),
    p99: round(pct(s, 0.99), 4),
  };
}

export { SIM_FPS };
