/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·17ec4602 @license @preserve */
/* 안정 구간 자동 시야 표본.

A 사용자 확인 앵커 — 자동 표본이 덮지 않는다.
B 잠정 자동 표본 — 즉시 기준으로 쓰지 않는다.
C 후속 관측을 통과한 보조 표본 — 앵커와 동등 승격 금지.

추적기 confidence 만으로 정답 확정하지 않는다.
관측하지 않은 정면·측면·후면을 만들지 않는다.
잠정 표본이 자기 자신만으로 검증되는 순환을 막는다.
*/

import { similarity, type Descriptor } from './appearance';
import { averageHash64, isNearDuplicate } from './perceptual-hash';
import type { MemoryKind } from './appearance-memory';

export type AutoViewLabel = 'front' | 'side' | 'back' | 'unknown';

export interface StableSampleMeta {
  tSec: number;
  trackId: string;
  quality: number;
  visibility: [boolean, boolean, boolean];
  source: Exclude<MemoryKind, 'known_other'>;
  view: AutoViewLabel;
  hash: bigint | null;
  box: { x: number; y: number; width: number; height: number };
  overlapOthers: boolean;
  cameraOk: boolean;
  gmcOk: boolean;
}

export interface StableSample extends StableSampleMeta {
  descriptor: Descriptor;
  admittedAt: number | null;
  /** 잠정 표본이 자기 자신으로 통과하지 않게, 이후 관측 횟수. */
  futureHits: number;
}

export const STABLE_SAMPLE_POLICY: StableSamplePolicy = Object.freeze({
  maxTentative: 6,
  maxVerifiedAuto: 8,
  minBoxHeight: 28,
  minQuality: 0.62,
  minAnchorConsistency: 0.58,
  maxRivalSimilarity: 0.78,
  minFutureSec: 0.2,
  minFutureObs: 2,
  diversityMin: 0.05,
  discardBeforeLossSec: 0.25,
});

export interface StableSamplePolicy {
  maxTentative: number;
  maxVerifiedAuto: number;
  minBoxHeight: number;
  minQuality: number;
  minAnchorConsistency: number;
  maxRivalSimilarity: number;
  minFutureSec: number;
  minFutureObs: number;
  diversityMin: number;
  discardBeforeLossSec: number;
}

export interface CollectObservation {
  tSec: number;
  trackId: string;
  descriptor: Descriptor;
  quality: number;
  visibility: [boolean, boolean, boolean];
  box: { x: number; y: number; width: number; height: number };
  rgb?: ArrayLike<number>;
  rgbW?: number;
  rgbH?: number;
  hasAlpha?: boolean;
  overlapOthers: boolean;
  crossing: boolean;
  appearanceJump: boolean;
  trajectoryBreak: boolean;
  knownOtherConflict: boolean;
  cameraOk: boolean;
  gmcOk: boolean;
  trackingLost: boolean;
  rivalSimilarity: number | null;
  view?: AutoViewLabel;
}

export class StableViewSampler {
  private readonly anchors: StableSample[] = [];
  private readonly tentative: StableSample[] = [];
  private readonly verified: StableSample[] = [];
  private lastLossAt: number | null = null;
  private hashDedupCount = 0;
  private readonly policy: StableSamplePolicy;
  private readonly maxUserAnchors: number;

  constructor(opts?: { policy?: Partial<StableSamplePolicy>; maxUserAnchors?: number }) {
    this.policy = { ...STABLE_SAMPLE_POLICY, ...opts?.policy };
    this.maxUserAnchors = opts?.maxUserAnchors ?? 12;
  }

  private tooSimilar(a: Descriptor, b: Descriptor): boolean {
    return 1 - similarity(a, b) < this.policy.diversityMin;
  }

  rememberUserAnchor(sample: Omit<StableSample, 'source' | 'admittedAt' | 'hash' | 'futureHits'> & { hash?: bigint | null }): boolean {
    const next: StableSample = {
      ...sample,
      source: 'user_anchor',
      admittedAt: sample.tSec,
      hash: sample.hash ?? null,
      view: sample.view ?? 'unknown',
      futureHits: 0,
    };
    if (this.anchors.length >= this.maxUserAnchors) return false;
    this.anchors.push(next);
    return true;
  }

  get hashDuplicatesRejected(): number { return this.hashDedupCount; }
  get userAnchors(): readonly StableSample[] { return this.anchors; }
  get tentativeSamples(): readonly StableSample[] { return this.tentative; }
  get verifiedAuto(): readonly StableSample[] { return this.verified; }

  replaceUserAnchor(index: number, sample: Omit<StableSample, 'source' | 'admittedAt' | 'hash' | 'futureHits'>): boolean {
    if (index < 0 || index >= this.anchors.length) return false;
    this.anchors[index] = {
      ...sample,
      source: 'user_anchor',
      admittedAt: sample.tSec,
      hash: null,
      view: sample.view ?? 'unknown',
      futureHits: 0,
    };
    return true;
  }

  hydrateVerified(samples: readonly StableSample[]): void {
    this.verified.length = 0;
    for (const s of samples) {
      if (s.source !== 'verified_auto') continue;
      this.verified.push(s);
      if (this.verified.length >= this.policy.maxVerifiedAuto) break;
    }
  }

  clearVerified(): void {
    this.verified.length = 0;
  }

  /** 재등장 비교 갤러리. 앵커 + 검증된 보조만. 잠정은 빠진다. */
  gallery(): StableSample[] {
    return [...this.anchors, ...this.verified];
  }

  consider(obs: CollectObservation): { kept: boolean; reason: string; kind: MemoryKind | 'discarded' } {
    if (obs.trackingLost) {
      this.lastLossAt = obs.tSec;
      this.dropRecentTentative(obs.tSec);
      return { kept: false, reason: 'tracking-lost', kind: 'discarded' };
    }
    if (obs.crossing || obs.overlapOthers || obs.appearanceJump || obs.trajectoryBreak
      || obs.knownOtherConflict || !obs.cameraOk || !obs.gmcOk) {
      return { kept: false, reason: 'contamination-risk', kind: 'discarded' };
    }
    if (this.lastLossAt != null && obs.tSec - this.lastLossAt < this.policy.discardBeforeLossSec) {
      return { kept: false, reason: 'near-loss-window', kind: 'discarded' };
    }
    if (obs.quality < this.policy.minQuality || obs.box.height < this.policy.minBoxHeight) {
      return { kept: false, reason: 'quality-or-size', kind: 'discarded' };
    }
    if (obs.rivalSimilarity != null && obs.rivalSimilarity > this.policy.maxRivalSimilarity) {
      return { kept: false, reason: 'not-separated-from-rival', kind: 'discarded' };
    }
    if (!this.anchors.length) return { kept: false, reason: 'no-user-anchor', kind: 'discarded' };
    const bestAnchor = Math.max(...this.anchors.map((a) => similarity(a.descriptor, obs.descriptor)));
    if (bestAnchor < this.policy.minAnchorConsistency) {
      return { kept: false, reason: 'inconsistent-with-anchor', kind: 'discarded' };
    }

    const hash = obs.rgb && obs.rgbW && obs.rgbH
      ? averageHash64(obs.rgb, obs.rgbW, obs.rgbH, obs.hasAlpha === true)
      : null;
    const pool = [...this.anchors, ...this.verified, ...this.tentative];
    if (pool.some((s) => isNearDuplicate(s.hash, hash))) {
      this.hashDedupCount += 1;
      return { kept: false, reason: 'duplicate-hash', kind: 'discarded' };
    }
    if (pool.some((s) => this.tooSimilar(s.descriptor, obs.descriptor))) {
      return { kept: false, reason: 'duplicate-appearance', kind: 'discarded' };
    }

    const sample: StableSample = {
      tSec: obs.tSec,
      trackId: obs.trackId,
      quality: obs.quality,
      visibility: obs.visibility,
      source: 'tentative',
      view: obs.view ?? 'unknown',
      hash,
      box: { ...obs.box },
      overlapOthers: false,
      cameraOk: true,
      gmcOk: true,
      descriptor: obs.descriptor,
      admittedAt: null,
      futureHits: 0,
    };
    this.tentative.push(sample);
    if (this.tentative.length > this.policy.maxTentative) this.tentative.shift();
    return { kept: true, reason: 'tentative', kind: 'tentative' };
  }

  /**
   * 후속 관측으로 잠정을 보조 기억에 편입한다.
   * 검증 관측은 잠정 표본 자신이면 안 된다(순환 금지).
   */
  verifyWithFuture(obs: CollectObservation): { promoted: number; discarded: number } {
    let promoted = 0;
    let discarded = 0;
    const remain: StableSample[] = [];
    for (const t of this.tentative) {
      if (obs.crossing || obs.overlapOthers || obs.trajectoryBreak || obs.knownOtherConflict
        || obs.trackingLost || !obs.cameraOk) {
        discarded += 1;
        continue;
      }
      if (obs.trackId !== t.trackId) {
        remain.push(t);
        continue;
      }
      if (obs.tSec - t.tSec + 1e-9 < this.policy.minFutureSec) {
        remain.push(t);
        continue;
      }
      if (this.tooSimilar(t.descriptor, obs.descriptor) && Math.abs(obs.tSec - t.tSec) < 0.05) {
        remain.push(t);
        continue;
      }
      const sim = similarity(t.descriptor, obs.descriptor);
      if (sim < this.policy.minAnchorConsistency) {
        discarded += 1;
        continue;
      }
      const hits = t.futureHits + 1;
      if (hits < this.policy.minFutureObs) {
        remain.push({ ...t, futureHits: hits });
        continue;
      }
      const verified: StableSample = {
        ...t,
        source: 'verified_auto',
        admittedAt: obs.tSec,
      };
      this.verified.push(verified);
      if (this.verified.length > this.policy.maxVerifiedAuto) {
        this.verified.sort((a, b) => a.quality - b.quality);
        this.verified.shift();
      }
      promoted += 1;
    }
    this.tentative.length = 0;
    this.tentative.push(...remain);
    return { promoted, discarded };
  }

  private dropRecentTentative(tSec: number): void {
    const keep = this.tentative.filter((s) => tSec - s.tSec > this.policy.discardBeforeLossSec);
    this.tentative.length = 0;
    this.tentative.push(...keep);
  }

  clear(): void {
    this.anchors.length = 0;
    this.tentative.length = 0;
    this.verified.length = 0;
    this.lastLossAt = null;
  }
}
