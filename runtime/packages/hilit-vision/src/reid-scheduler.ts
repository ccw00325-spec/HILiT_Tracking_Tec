/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·54235128 @license @preserve */
/* 이벤트·위험 신호·연산 예산으로 고비용 Re-ID 를 고른다.

기본 경로는 매 분석 프레임의 운동 예측과 가벼운 추적이다.
표본 검사 주기가 특징 추출을 강제하지 않는다.
같은 프레임의 여러 트리거는 한 추출로 합친다.
실행 중 ID switch 를 정답 없이 확정하지 않는다 — switch-risk 만 둔다.
호출 횟수가 줄어도 품질이 좋아졌다고 말하지 않는다.
*/

import { shouldNeighborRerank } from './k-reciprocal-rerank';
import { ReidTimer } from './reid-timing';

export type ReidScheduleMode = 'fixed-period' | 'selective';

export type ReidCallReason =
  | 'user_confirm'
  | 'reentry_after_occlusion'
  | 'cross_or_rival'
  | 'prediction_residual'
  | 'track_drift_suspect'
  | 'appearance_change'
  | 'stable_low_freq'
  | 'surprise_move'
  | 'fixed_period';

export type SkipReason =
  | 'no_valid_crop'
  | 'full_occlusion'
  | 'severe_blur'
  | 'budget_exhausted'
  | 'cooldown'
  | 'appearance_weak'
  | 'not_due'
  | 'inspect-without-fresh-feature';

export type SwitchRiskLevel = 'none' | 'watch' | 'elevated' | 'ask';

export const REID_SCHEDULER_POLICY = Object.freeze({
  cheapQualityIntervalSec: 0.25,
  stableExpensiveIntervalSec: 1.67,
  warningExpensiveIntervalSec: 0.42,
  driftInspectIntervalSec: 0.33,
  galleryInspectIntervalSec: 0.75,
  cooldownAfterExpensiveSec: 0.12,
  riskClearHoldSec: 1.5,
  expensiveBudgetMs: 18,
  rerankBudgetMs: 8,
  detectorBudgetMs: 12,
  defaultExtractMs: 6,
  fullOcclusionVisible: 0.12,
  minCropPx: 8,
  residualBodies: 0.45,
  policyVersion: 1,
});

/** 런타임은 정답 없이 ID switch 를 확정하지 않는다. */
export const RUNTIME_ID_SWITCH_CONFIRMED = false;

export const CALL_COUNT_IS_NOT_QUALITY = 'call-count-is-not-quality' as const;

export interface FrameSignals {
  videoTSec: number;
  analysisFrameIndex?: number;
  wallNowMs?: number;
  box?: { x: number; y: number; width: number; height: number } | null;
  visibleRatio: number;
  trackerConfidence?: number;
  appearanceWeak?: boolean;
  surpriseMove?: boolean;
  rivalNearby?: boolean;
  rankCompetition?: boolean;
  predictionResidualBodies?: number | null;
  trackLostSuspect?: boolean;
  sustainedAppearanceChange?: boolean;
  occluded?: boolean;
  blurSevere?: boolean;
  cropValid: boolean;
  userConfirm?: boolean;
  reentryAfterOcclusion?: boolean;
  candidateCount?: number;
  appearanceMargin?: number | null;
  appearanceScores?: Array<number | null>;
  gallerySampleCount?: number;
  galleryDistinct?: number;
  galleryVersion?: number;
  reidIntervalSec?: number;
  reidIntervalFrames?: number;
  framesSinceReid?: number;
  driftInspectDue?: boolean;
}

export interface SchedulerDecision {
  extract: boolean;
  compare: boolean;
  rerank: boolean;
  admitInspect: boolean;
  cheapQuality: boolean;
  reasons: ReidCallReason[];
  skip: SkipReason | null;
  skipDetail: string;
  switchRisk: SwitchRiskLevel;
  coalesced: boolean;
  holdJudgment: boolean;
  reuseFeature: boolean;
  measuredFresh: boolean;
  keepWeakCandidates: true;
  searchKeep: 'default' | 'motion-and-search';
}

export interface SchedulerLogEntry {
  tSec: number;
  reasons: ReidCallReason[];
  extract: boolean;
  skip: SkipReason | null;
  skipDetail: string;
  holdJudgment: boolean;
  coalesced: boolean;
  switchRisk: SwitchRiskLevel;
  admitInspect: boolean;
  rerank: boolean;
}

export interface ReasonCount {
  n: number;
  ms: number;
}

export interface SchedulerMetrics {
  analysisFrames: number;
  expensiveExtracts: number;
  expensiveRatio: number;
  byReason: Record<string, ReasonCount>;
  skipByReason: Record<string, number>;
  delayed: number;
  coalescedFrames: number;
  featureCacheHits: number;
  featureCacheMisses: number;
  extractsAvoidedByCache: number;
  rerankRuns: number;
  rerankSkips: number;
  holdJudgment: number;
  switchRiskFrames: number;
  detectorFull: number;
  detectorSliced: number;
  detectorRegion: number;
  hashDedup: number;
  timing: ReturnType<ReidTimer['summary']>;
  qualityClaim: false;
  note: typeof CALL_COUNT_IS_NOT_QUALITY;
  idSwitch: 'NOT_MEASURED';
  falseReject: 'NOT_MEASURED';
  badRecovery: 'NOT_MEASURED';
  recoveryDelay: 'NOT_MEASURED';
}

const URGENT: ReadonlySet<ReidCallReason> = new Set([
  'user_confirm',
  'surprise_move',
  'reentry_after_occlusion',
]);

const AUTO_CORRECT: ReadonlySet<ReidCallReason> = new Set([
  'fixed_period',
  'stable_low_freq',
]);

function uniqueReasons(list: ReidCallReason[]): ReidCallReason[] {
  const seen = new Set<ReidCallReason>();
  const out: ReidCallReason[] = [];
  for (const r of list) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

export function retainCompetingCandidates<T>(rows: readonly T[]): T[] {
  return rows.slice();
}

export class ReidScheduler {
  readonly mode: ReidScheduleMode;
  readonly budgetMs: number;
  readonly timer = new ReidTimer();
  readonly log: SchedulerLogEntry[] = [];

  private lastExpensiveVideoT = Number.NEGATIVE_INFINITY;
  private lastCheapVideoT = Number.NEGATIVE_INFINITY;
  private lastRisk: SwitchRiskLevel = 'none';
  private lastRiskT = Number.NEGATIVE_INFINITY;
  private lastExtractMs: number = REID_SCHEDULER_POLICY.defaultExtractMs;
  private frameSpentMs = 0;
  private currentVideoT = Number.NEGATIVE_INFINITY;
  private extractedThisFrame = false;
  private analysisFrames = 0;
  private expensiveExtracts = 0;
  private coalescedFrames = 0;
  private holdCount = 0;
  private delayedCount = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private rerankRuns = 0;
  private rerankSkips = 0;
  private switchRiskFrames = 0;
  private detectorFull = 0;
  private detectorSliced = 0;
  private detectorRegion = 0;
  private hashDedup = 0;
  private readonly byReason = new Map<ReidCallReason, ReasonCount>();
  private readonly skipByReason = new Map<string, number>();

  constructor(opts?: { mode?: ReidScheduleMode; expensiveBudgetMs?: number }) {
    this.mode = opts?.mode ?? 'selective';
    this.budgetMs = opts?.expensiveBudgetMs ?? REID_SCHEDULER_POLICY.expensiveBudgetMs;
  }

  noteExtract(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.lastExtractMs = ms;
    this.frameSpentMs += ms;
    this.timer.mark('feature', ms);
    const last = this.log[this.log.length - 1];
    if (last?.reasons[0]) {
      const row = this.byReason.get(last.reasons[0]) ?? { n: 0, ms: 0 };
      row.ms += ms;
      this.byReason.set(last.reasons[0], row);
    }
  }

  noteCacheHit(): void {
    this.cacheHits += 1;
  }

  noteCacheMiss(): void {
    this.cacheMisses += 1;
  }

  noteCompare(ms: number): void {
    this.timer.mark('direct_compare', ms);
    this.frameSpentMs += Math.max(0, ms);
  }

  noteRerank(ms: number): void {
    this.timer.mark('neighbor_rerank', ms);
    this.frameSpentMs += Math.max(0, ms);
  }

  noteMotion(ms: number): void {
    this.timer.mark('motion', ms);
  }

  noteDetect(ms: number, scope: 'full' | 'sliced' | 'region' = 'full'): void {
    this.timer.mark('detect', ms);
    if (scope === 'sliced') this.detectorSliced += 1;
    else if (scope === 'region') this.detectorRegion += 1;
    else this.detectorFull += 1;
  }

  noteHashDedup(n = 1): void {
    this.hashDedup += Math.max(0, n);
  }

  noteCheap(ms: number): void {
    this.timer.mark('cheap_quality', ms);
  }

  private bumpSkip(reason: string): void {
    this.skipByReason.set(reason, (this.skipByReason.get(reason) ?? 0) + 1);
  }

  private bumpReason(reason: ReidCallReason): void {
    const row = this.byReason.get(reason) ?? { n: 0, ms: 0 };
    row.n += 1;
    this.byReason.set(reason, row);
  }

  private hardSkip(sig: FrameSignals): SkipReason | null {
    if (!sig.cropValid || !sig.box) return 'no_valid_crop';
    const vis = sig.visibleRatio;
    if (sig.occluded === true || vis < REID_SCHEDULER_POLICY.fullOcclusionVisible) {
      return 'full_occlusion';
    }
    if (sig.blurSevere === true) return 'severe_blur';
    return null;
  }

  private updateRisk(sig: FrameSignals): SwitchRiskLevel {
    let level: SwitchRiskLevel = 'none';
    if (sig.rivalNearby || sig.rankCompetition) level = 'watch';
    if (sig.rankCompetition && (sig.predictionResidualBodies ?? 0) >= REID_SCHEDULER_POLICY.residualBodies) {
      level = 'elevated';
    }
    if (sig.trackLostSuspect && sig.rivalNearby) level = 'elevated';
    if (sig.appearanceWeak && sig.rivalNearby) level = 'ask';
    if (level !== 'none') {
      this.lastRisk = level;
      this.lastRiskT = sig.videoTSec;
      this.switchRiskFrames += 1;
      return level;
    }
    if (this.lastRisk !== 'none'
      && sig.videoTSec - this.lastRiskT < REID_SCHEDULER_POLICY.riskClearHoldSec) {
      this.switchRiskFrames += 1;
      return this.lastRisk;
    }
    this.lastRisk = 'none';
    return 'none';
  }

  private intervalSec(sig: FrameSignals, risk: SwitchRiskLevel): number {
    if (risk === 'none') {
      return sig.reidIntervalSec ?? REID_SCHEDULER_POLICY.stableExpensiveIntervalSec;
    }
    return Math.min(
      sig.reidIntervalSec ?? REID_SCHEDULER_POLICY.warningExpensiveIntervalSec,
      REID_SCHEDULER_POLICY.warningExpensiveIntervalSec,
    );
  }

  decide(sig: FrameSignals): SchedulerDecision {
    if (!Number.isFinite(sig.videoTSec)) {
      return this.emptyDecision('not_due', 'invalid-time');
    }
    if (sig.videoTSec !== this.currentVideoT) {
      this.currentVideoT = sig.videoTSec;
      this.analysisFrames += 1;
      this.frameSpentMs = 0;
      this.extractedThisFrame = false;
    }

    const cheapDue = this.lastCheapVideoT === Number.NEGATIVE_INFINITY
      || sig.videoTSec - this.lastCheapVideoT >= REID_SCHEDULER_POLICY.cheapQualityIntervalSec - 1e-9;
    if (cheapDue) this.lastCheapVideoT = sig.videoTSec;

    const skipHard = this.hardSkip(sig);
    const switchRisk = this.updateRisk(sig);
    const collected: ReidCallReason[] = [];

    if (sig.userConfirm) collected.push('user_confirm');
    if (sig.surpriseMove) collected.push('surprise_move');
    if (sig.reentryAfterOcclusion && sig.cropValid && !sig.occluded && (sig.candidateCount ?? 0) > 0) {
      collected.push('reentry_after_occlusion');
    }
    if (sig.rivalNearby || sig.rankCompetition) collected.push('cross_or_rival');
    if ((sig.predictionResidualBodies ?? 0) >= REID_SCHEDULER_POLICY.residualBodies) {
      collected.push('prediction_residual');
    }
    if (sig.trackLostSuspect) collected.push('track_drift_suspect');
    if (sig.sustainedAppearanceChange) collected.push('appearance_change');

    const interval = this.intervalSec(sig, switchRisk);
    const timeDue = this.lastExpensiveVideoT === Number.NEGATIVE_INFINITY
      || sig.videoTSec - this.lastExpensiveVideoT >= interval - 1e-9;
    const frameDue = sig.reidIntervalFrames != null && sig.framesSinceReid != null
      && sig.framesSinceReid >= sig.reidIntervalFrames;
    const intervalDue = timeDue || frameDue;

    if (this.mode === 'fixed-period') {
      if (intervalDue) collected.push('fixed_period');
      if (sig.driftInspectDue) collected.push('fixed_period');
    } else if (intervalDue && !sig.appearanceWeak) {
      collected.push('stable_low_freq');
    }

    let reasons = uniqueReasons(collected);
    const coalesced = reasons.length > 1;
    if (coalesced) this.coalescedFrames += 1;

    const urgent = reasons.some((r) => URGENT.has(r));
    let skip: SkipReason | null = skipHard;
    let skipDetail = skipHard ?? '';
    let extract = reasons.length > 0 && skipHard == null;

    if (extract && sig.appearanceWeak && !urgent) {
      const kept = reasons.filter((r) => !AUTO_CORRECT.has(r));
      if (kept.length === 0) {
        extract = false;
        skip = 'appearance_weak';
        skipDetail = 'auto-correct-off-when-weak';
        reasons = [];
      } else {
        reasons = kept;
      }
    }

    if (extract && !urgent && this.lastExpensiveVideoT > Number.NEGATIVE_INFINITY
      && sig.videoTSec - this.lastExpensiveVideoT < REID_SCHEDULER_POLICY.cooldownAfterExpensiveSec) {
      extract = false;
      skip = 'cooldown';
      skipDetail = 'video-time-cooldown';
      this.delayedCount += 1;
    }

    let holdJudgment = false;
    if (extract && !urgent && this.frameSpentMs + this.lastExtractMs > this.budgetMs) {
      extract = false;
      holdJudgment = true;
      skip = 'budget_exhausted';
      skipDetail = `spent=${this.frameSpentMs.toFixed(1)} est=${this.lastExtractMs.toFixed(1)} budget=${this.budgetMs}`;
      this.holdCount += 1;
    }

    let reuseFeature = false;
    if (extract && this.extractedThisFrame) {
      extract = false;
      reuseFeature = true;
      skip = null;
      skipDetail = 'coalesced-same-frame';
    }

    if (!extract && skipHard == null && reasons.length === 0 && skip == null) {
      skip = 'not_due';
      skipDetail = skipDetail || 'no-trigger';
    }

    const admitInspect = (extract || reuseFeature)
      && skipHard == null
      && !sig.occluded
      && !sig.blurSevere
      && sig.cropValid;

    const compare = extract || reuseFeature;
    let rerank = false;
    if (compare && (sig.candidateCount ?? 0) >= 2) {
      const gate = shouldNeighborRerank({
        scores: sig.appearanceScores ?? (
          sig.appearanceMargin != null ? [1, 1 - sig.appearanceMargin] : []
        ),
        galleryCount: sig.gallerySampleCount ?? 0,
        distinctGallery: sig.galleryDistinct ?? 0,
        candidateCount: sig.candidateCount ?? 0,
      });
      if (gate.run) {
        rerank = true;
        this.rerankRuns += 1;
      } else {
        this.rerankSkips += 1;
      }
    }

    if (extract) {
      this.expensiveExtracts += 1;
      this.extractedThisFrame = true;
      this.lastExpensiveVideoT = sig.videoTSec;
      for (const r of reasons) this.bumpReason(r);
    } else if (skip) {
      this.bumpSkip(skip);
    }

    const searchKeep: SchedulerDecision['searchKeep'] =
      skipHard === 'full_occlusion' || skipHard === 'no_valid_crop' || skipHard === 'severe_blur'
        ? 'motion-and-search'
        : 'default';

    const entry: SchedulerLogEntry = {
      tSec: sig.videoTSec,
      reasons,
      extract,
      skip,
      skipDetail,
      holdJudgment,
      coalesced,
      switchRisk,
      admitInspect,
      rerank,
    };
    this.log.push(entry);

    return {
      extract,
      compare,
      rerank,
      admitInspect,
      cheapQuality: cheapDue,
      reasons,
      skip,
      skipDetail,
      switchRisk,
      coalesced,
      holdJudgment,
      reuseFeature,
      measuredFresh: extract,
      keepWeakCandidates: true,
      searchKeep,
    };
  }

  private emptyDecision(skip: SkipReason, detail: string): SchedulerDecision {
    return {
      extract: false,
      compare: false,
      rerank: false,
      admitInspect: false,
      cheapQuality: false,
      reasons: [],
      skip,
      skipDetail: detail,
      switchRisk: 'none',
      coalesced: false,
      holdJudgment: false,
      reuseFeature: false,
      measuredFresh: false,
      keepWeakCandidates: true,
      searchKeep: 'default',
    };
  }

  metrics(): SchedulerMetrics {
    const byReason: Record<string, ReasonCount> = {};
    for (const [k, v] of this.byReason) byReason[k] = { ...v };
    const skipByReason: Record<string, number> = {};
    for (const [k, v] of this.skipByReason) skipByReason[k] = v;
    return {
      analysisFrames: this.analysisFrames,
      expensiveExtracts: this.expensiveExtracts,
      expensiveRatio: this.expensiveExtracts / Math.max(1, this.analysisFrames),
      byReason,
      skipByReason,
      delayed: this.delayedCount,
      coalescedFrames: this.coalescedFrames,
      featureCacheHits: this.cacheHits,
      featureCacheMisses: this.cacheMisses,
      extractsAvoidedByCache: this.cacheHits,
      rerankRuns: this.rerankRuns,
      rerankSkips: this.rerankSkips,
      holdJudgment: this.holdCount,
      switchRiskFrames: this.switchRiskFrames,
      detectorFull: this.detectorFull,
      detectorSliced: this.detectorSliced,
      detectorRegion: this.detectorRegion,
      hashDedup: this.hashDedup,
      timing: this.timer.summary(),
      qualityClaim: false,
      note: CALL_COUNT_IS_NOT_QUALITY,
      idSwitch: 'NOT_MEASURED',
      falseReject: 'NOT_MEASURED',
      badRecovery: 'NOT_MEASURED',
      recoveryDelay: 'NOT_MEASURED',
    };
  }
}

export function compareScheduleModes(
  frames: readonly FrameSignals[],
  opts?: { expensiveBudgetMs?: number },
): {
  fixedExtracts: number;
  selectiveExtracts: number;
  fixedRatio: number;
  selectiveRatio: number;
  qualityClaim: false;
  note: typeof CALL_COUNT_IS_NOT_QUALITY;
} {
  const fixed = new ReidScheduler({ mode: 'fixed-period', expensiveBudgetMs: opts?.expensiveBudgetMs });
  const selective = new ReidScheduler({ mode: 'selective', expensiveBudgetMs: opts?.expensiveBudgetMs });
  for (const frame of frames) {
    fixed.decide(frame);
    selective.decide(frame);
  }
  const fm = fixed.metrics();
  const sm = selective.metrics();
  return {
    fixedExtracts: fm.expensiveExtracts,
    selectiveExtracts: sm.expensiveExtracts,
    fixedRatio: fm.expensiveRatio,
    selectiveRatio: sm.expensiveRatio,
    qualityClaim: false,
    note: CALL_COUNT_IS_NOT_QUALITY,
  };
}
