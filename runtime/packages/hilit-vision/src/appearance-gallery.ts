/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·a4a50685 @license @preserve */
/* RAM 외형 갤러리.

추적·비교는 여기서 끝낸다. 디스크 I/O 를 프레임 루프에서 기다리지 않는다.
잠정 표본은 RAM 에만 둔다. 사용자 확인 표본은 자동으로 덮지 않는다.
외형 상태(현재/과거)를 한 평균 벡터로 섞지 않는다.
*/

import { DESCRIPTOR_SIZE, similarity, type Descriptor } from './appearance';
import { EXTRACTOR_VERSION, HSV_TEXTURE_EXTRACTOR_ID } from './feature-extractor';
import {
  APPEARANCE_EMA_POLICY,
  composeUpdateQuality,
  emptySummary,
  histogramL1Distance,
  updateAppearanceSummary,
  type AppearanceSummary,
} from './appearance-ema';
import { appearanceStoreKey, type AppearanceScope } from './gallery-scope';
import {
  StableViewSampler,
  type AutoViewLabel,
  type CollectObservation,
  type StableSample,
} from './stable-view-sampler';
import type { MemoryKind } from './appearance-memory';

export const APPEARANCE_GALLERY_POLICY = Object.freeze({
  userConfirmed: 4,
  current: 12,
  past: 4,
  tentative: 4,
  total: 24,
  inspectIntervalSec: 0.75,
  inspectChangeIntervalSec: 0.25,
  minAdmitSec: 0.75,
  minAdmitObs: 3,
  reevalIntervalSec: 5,
  recentHalfLifeSec: APPEARANCE_EMA_POLICY.recentHalfLifeSec,
  slowHalfLifeSec: APPEARANCE_EMA_POLICY.slowHalfLifeSec,
  checkpointIntervalMs: 10_000,
  ttlMinutes: 60,
  byteBudget: 256 * 1024,
  policyVersion: 1,
  gallerySchemaVersion: 1,
  maxPastStates: 2,
});

export type PersistMode = 'indexeddb' | 'ram-only';
export type AppearanceChangeKind =
  | 'lighting'
  | 'view-cycle'
  | 'clothing-shift'
  | 'spray-occlusion'
  | 'none';

export interface AppearanceState {
  id: string;
  startedAtSec: number;
  endedAtSec: number | null;
}

export interface GalleryObserveResult {
  inspected: boolean;
  stored: boolean;
  reason: string;
  kind: MemoryKind | 'discarded' | 'ema' | 'state-change';
  persistDirty: boolean;
}

export interface PersistedGallerySample {
  tSec: number;
  trackId: string;
  quality: number;
  visibility: [boolean, boolean, boolean];
  source: 'user_anchor' | 'verified_auto';
  view: AutoViewLabel;
  box: { x: number; y: number; width: number; height: number };
  appearanceStateId: string;
  values: number[];
  samples: number;
  trust: number;
  bandSamples?: [number, number, number];
  createdAt: number;
  lastUsedAt: number;
  extractorId: string;
  extractorVersion: number;
  policyVersion: number;
}

export interface AppearanceCheckpointSnapshot {
  schemaVersion: number;
  policyVersion: number;
  galleryVersion: number;
  generation: number;
  ownerId: string;
  videoId: string;
  subjectId: string;
  runId: string;
  persistMode: PersistMode;
  extractorId: string;
  extractorVersion: number;
  currentStateId: string;
  states: AppearanceState[];
  samples: PersistedGallerySample[];
  recent: number[] | null;
  slow: number[] | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  estimatedBytes: number;
}

function cloneDesc(d: Descriptor): Descriptor {
  return {
    values: Float32Array.from(d.values),
    samples: d.samples,
    trust: d.trust,
    bandSamples: d.bandSamples ? [...d.bandSamples] : undefined,
  };
}

function sampleBytes(count: number): number {
  return count * (DESCRIPTOR_SIZE * 4 + 180);
}

export class AppearanceGallery {
  readonly scope: AppearanceScope;
  private readonly sampler: StableViewSampler;
  private readonly past: StableSample[] = [];
  private readonly states: AppearanceState[] = [];
  private currentStateId: string;
  private recent: AppearanceSummary | null = null;
  private slow: AppearanceSummary | null = null;
  private lastInspectAt = Number.NEGATIVE_INFINITY;
  private lastReevalAt = Number.NEGATIVE_INFINITY;
  private lastValidObsAt = Number.NEGATIVE_INFINITY;
  private lastCheckpointAt = 0;
  private dirty = false;
  private galleryVersion = 1;
  private generation = 0;
  private persistMode: PersistMode = 'indexeddb';
  private frozen = false;
  private lastView: AutoViewLabel = 'unknown';
  private readonly compareCache = new Map<string, number>();
  private compareCacheVersion = 1;
  readonly saveLatencies: number[] = [];
  readonly frameLatencies: number[] = [];
  writes = 0;
  bytesWritten = 0;

  constructor(scope: AppearanceScope) {
    this.scope = scope;
    this.sampler = new StableViewSampler({
      maxUserAnchors: APPEARANCE_GALLERY_POLICY.userConfirmed,
      policy: {
        maxTentative: APPEARANCE_GALLERY_POLICY.tentative,
        maxVerifiedAuto: APPEARANCE_GALLERY_POLICY.current,
        minFutureSec: APPEARANCE_GALLERY_POLICY.minAdmitSec,
        minFutureObs: APPEARANCE_GALLERY_POLICY.minAdmitObs,
      },
    });
    this.currentStateId = 'state-0';
    this.states.push({ id: this.currentStateId, startedAtSec: 0, endedAtSec: null });
  }

  get version(): number { return this.galleryVersion; }
  get persist(): PersistMode { return this.persistMode; }
  get tentativeCount(): number { return this.sampler.tentativeSamples.length; }
  get userCount(): number { return this.sampler.userAnchors.length; }
  get currentCount(): number { return this.sampler.verifiedAuto.length; }
  get pastCount(): number { return this.past.length; }
  get hashDuplicatesRejected(): number { return this.sampler.hashDuplicatesRejected; }
  get recentSummary(): AppearanceSummary | null { return this.recent; }
  get slowSummary(): AppearanceSummary | null { return this.slow; }
  get currentState(): string { return this.currentStateId; }

  storeKey(): string {
    return appearanceStoreKey(this.scope);
  }

  setPersistMode(mode: PersistMode): void {
    this.persistMode = mode;
  }

  setGeneration(n: number): void {
    this.generation = Math.max(0, Math.floor(n));
  }

  nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  rememberUserAnchor(sample: Omit<StableSample, 'source' | 'admittedAt' | 'hash' | 'futureHits'> & { hash?: bigint | null }): boolean {
    const ok = this.sampler.rememberUserAnchor(sample);
    if (!ok) return false;
    if (!this.recent) this.recent = emptySummary(sample.tSec, sample.descriptor);
    if (!this.slow) this.slow = emptySummary(sample.tSec, sample.descriptor);
    this.lastValidObsAt = sample.tSec;
    this.bump('user-anchor');
    return true;
  }

  replaceUserAnchor(index: number, sample: Omit<StableSample, 'source' | 'admittedAt' | 'hash' | 'futureHits'>): boolean {
    const ok = this.sampler.replaceUserAnchor(index, sample);
    if (ok) this.bump('user-anchor-replace');
    return ok;
  }

  gallery(): StableSample[] {
    return [...this.sampler.gallery(), ...this.past];
  }

  classifyChange(obs: CollectObservation): AppearanceChangeKind {
    if (obs.crossing || obs.overlapOthers || !obs.cameraOk || obs.trackingLost) return 'spray-occlusion';
    if (obs.appearanceJump && obs.quality >= 0.62) return 'clothing-shift';
    if (obs.view && obs.view !== 'unknown' && obs.view !== this.lastView) return 'view-cycle';
    if (this.recent && this.slow) {
      const started = this.states.find((s) => s.id === this.currentStateId)?.startedAtSec ?? 0;
      if (obs.tSec - started >= 2) {
        const gap = histogramL1Distance(this.recent.values, this.slow.values);
        if (gap >= APPEARANCE_EMA_POLICY.recentSlowGapForChange) return 'clothing-shift';
      }
    }
    return 'lighting';
  }

  observe(obs: CollectObservation, wallMs = 0): GalleryObserveResult {
    const change = this.classifyChange(obs);
    this.frozen = change === 'spray-occlusion'
      || obs.crossing || obs.overlapOthers || obs.trajectoryBreak
      || obs.knownOtherConflict || obs.trackingLost || !obs.cameraOk;
    const interval = change === 'view-cycle' || change === 'clothing-shift'
      ? APPEARANCE_GALLERY_POLICY.inspectChangeIntervalSec
      : APPEARANCE_GALLERY_POLICY.inspectIntervalSec;
    const due = obs.tSec - this.lastInspectAt >= interval - 1e-9;
    let stored = false;
    let reason = 'not-due';
    let kind: GalleryObserveResult['kind'] = 'discarded';

    if (!this.frozen && this.recent && this.slow && obs.quality >= 0.5) {
      const afterGap = this.lastValidObsAt > 0
        && obs.tSec - this.lastValidObsAt >= APPEARANCE_EMA_POLICY.gapResetSec;
      const q = {
        quality: obs.quality,
        visibility: obs.visibility,
        continuity: afterGap ? 0.35 : 1,
        rivalSimilarity: obs.rivalSimilarity,
        frozen: this.frozen,
      };
      const recentUp = updateAppearanceSummary({
        prev: this.recent,
        fresh: obs.descriptor,
        tSec: obs.tSec,
        halfLifeSec: APPEARANCE_GALLERY_POLICY.recentHalfLifeSec,
        quality: q,
        afterLongGap: afterGap,
      });
      const slowUp = updateAppearanceSummary({
        prev: this.slow,
        fresh: obs.descriptor,
        tSec: obs.tSec,
        halfLifeSec: APPEARANCE_GALLERY_POLICY.slowHalfLifeSec,
        quality: q,
        afterLongGap: afterGap,
      });
      if (recentUp.next) this.recent = recentUp.next;
      if (slowUp.next) this.slow = slowUp.next;
      if (recentUp.alpha > 0 || slowUp.alpha > 0) {
        kind = 'ema';
        reason = recentUp.reason;
        this.lastValidObsAt = obs.tSec;
      }
      if (change === 'clothing-shift' && composeUpdateQuality(q) > 0.5) {
        this.commitAppearanceState(obs.tSec);
        kind = 'state-change';
        reason = 'verified-clothing-shift';
        this.dirty = true;
      }
    }

    if (due) {
      this.lastInspectAt = obs.tSec;
      const considered = this.sampler.consider(obs);
      reason = considered.reason;
      kind = considered.kind;
      stored = considered.kept;
    }
    const verified = this.sampler.verifyWithFuture(obs);
    if (verified.promoted > 0) {
      stored = true;
      this.bump('verified-auto');
    }

    if (obs.tSec - this.lastReevalAt >= APPEARANCE_GALLERY_POLICY.reevalIntervalSec) {
      this.lastReevalAt = obs.tSec;
      this.reevalCurrent();
    }
    if (obs.view && obs.view !== 'unknown') this.lastView = obs.view;
    void wallMs;
    return {
      inspected: due,
      stored,
      reason,
      kind,
      persistDirty: this.dirty,
    };
  }

  private commitAppearanceState(tSec: number): void {
    const current = this.sampler.verifiedAuto.slice();
    const keep = this.pickPastRepresentatives(current);
    this.past.push(...keep);
    while (this.past.length > APPEARANCE_GALLERY_POLICY.past) {
      this.evictPast();
    }
    const prev = this.states.find((s) => s.id === this.currentStateId);
    if (prev && prev.endedAtSec == null) prev.endedAtSec = tSec;
    this.currentStateId = `state-${this.states.length}`;
    this.states.push({ id: this.currentStateId, startedAtSec: tSec, endedAtSec: null });
    while (this.states.filter((s) => s.endedAtSec != null).length > APPEARANCE_GALLERY_POLICY.maxPastStates) {
      const oldest = this.states.find((s) => s.endedAtSec != null);
      if (!oldest) break;
      const idx = this.states.indexOf(oldest);
      if (idx >= 0) this.states.splice(idx, 1);
    }
    this.sampler.clearVerified();
    this.recent = this.slow = null;
    this.bump('state-change');
  }

  private pickPastRepresentatives(current: readonly StableSample[]): StableSample[] {
    if (!current.length) return [];
    const byView = new Map<string, StableSample>();
    const sorted = current.slice().sort((a, b) => b.quality - a.quality);
    for (const s of sorted) {
      const key = s.view === 'unknown' ? `t:${s.tSec.toFixed(2)}` : s.view;
      if (!byView.has(key)) byView.set(key, { ...s, descriptor: cloneDesc(s.descriptor) });
    }
    return [...byView.values()].slice(0, 2);
  }

  private evictPast(): void {
    if (this.past.length <= APPEARANCE_GALLERY_POLICY.past) return;
    const views = new Map<string, number>();
    for (const s of this.past) views.set(s.view, (views.get(s.view) ?? 0) + 1);
    let dropAt = -1;
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.past.length; i += 1) {
      const s = this.past[i];
      const uniqueView = (views.get(s.view) ?? 0) <= 1 && s.view !== 'unknown';
      if (uniqueView) continue;
      const score = s.quality - i * 0.001;
      if (score < worst) {
        worst = score;
        dropAt = i;
      }
    }
    if (dropAt < 0) dropAt = 0;
    this.past.splice(dropAt, 1);
  }

  private reevalCurrent(): void {
    const list = this.sampler.verifiedAuto;
    if (list.length < 2) return;
    const remain: StableSample[] = [];
    for (const s of list) {
      const others = list.filter((x) => x !== s);
      const dup = others.some((o) => similarity(s.descriptor, o.descriptor) > 0.97 && o.quality >= s.quality);
      if (dup && s.quality < 0.7) continue;
      remain.push(s);
    }
    if (remain.length !== list.length) {
      this.sampler.hydrateVerified(remain);
      this.bump('reeval');
    }
  }

  evictForPressure(step: 'drop-crops' | 'drop-dup-auto' | 'ram-only'): void {
    if (step === 'drop-crops') return;
    if (step === 'drop-dup-auto') this.reevalCurrent();
    if (step === 'ram-only') this.persistMode = 'ram-only';
  }

  cachedSimilarity(a: Descriptor, b: Descriptor, idA: string, idB: string): number {
    if (this.compareCacheVersion !== this.galleryVersion) {
      this.compareCache.clear();
      this.compareCacheVersion = this.galleryVersion;
    }
    const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
    const hit = this.compareCache.get(key);
    if (hit != null) return hit;
    const v = similarity(a, b);
    this.compareCache.set(key, v);
    return v;
  }

  estimatedBytes(): number {
    const n = this.userCount + this.currentCount + this.pastCount + 2;
    return sampleBytes(n) + this.compareCache.size * 16;
  }

  checkpointDue(nowMs: number, force = false): boolean {
    if (this.persistMode === 'ram-only') return false;
    if (!this.dirty && !force) return false;
    if (force) return true;
    return nowMs - this.lastCheckpointAt >= APPEARANCE_GALLERY_POLICY.checkpointIntervalMs;
  }

  consumeDirty(nowMs: number): void {
    this.dirty = false;
    this.lastCheckpointAt = nowMs;
  }

  markPersistFailed(): void {
    this.persistMode = 'ram-only';
  }

  recordSaveLatency(ms: number, bytes: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.saveLatencies.push(ms);
    if (Number.isFinite(bytes) && bytes > 0) {
      this.writes += 1;
      this.bytesWritten += bytes;
    }
  }

  recordFrameLatency(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.frameLatencies.push(ms);
  }

  percentile(list: readonly number[], p: number): number | null {
    if (!list.length) return null;
    const s = list.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[i];
  }

  appearanceStateAt(tSec: number): string {
    let chosen = this.states[0]?.id ?? this.currentStateId;
    for (const s of this.states) {
      if (tSec + 1e-9 < s.startedAtSec) break;
      if (s.endedAtSec == null || tSec <= s.endedAtSec + 1e-9) chosen = s.id;
    }
    return chosen;
  }

  checkpointSnapshot(now = Date.now()): AppearanceCheckpointSnapshot {
    const samples: PersistedGallerySample[] = [];
    const push = (row: StableSample, stateId: string) => {
      if (row.source === 'tentative') return;
      samples.push({
        tSec: row.tSec,
        trackId: row.trackId,
        quality: row.quality,
        visibility: row.visibility,
        source: row.source === 'user_anchor' ? 'user_anchor' : 'verified_auto',
        view: row.view,
        box: { ...row.box },
        appearanceStateId: stateId,
        values: Array.from(row.descriptor.values),
        samples: row.descriptor.samples,
        trust: row.descriptor.trust,
        bandSamples: row.descriptor.bandSamples ? [...row.descriptor.bandSamples] : undefined,
        createdAt: now,
        lastUsedAt: now,
        extractorId: HSV_TEXTURE_EXTRACTOR_ID,
        extractorVersion: EXTRACTOR_VERSION,
        policyVersion: APPEARANCE_GALLERY_POLICY.policyVersion,
      });
    };
    for (const a of this.sampler.userAnchors) push(a, this.currentStateId);
    for (const v of this.sampler.verifiedAuto) push(v, this.currentStateId);
    for (const p of this.past) push(p, p.trackId.startsWith('past:') ? this.states[0]?.id ?? this.currentStateId : this.currentStateId);
    return {
      schemaVersion: APPEARANCE_GALLERY_POLICY.gallerySchemaVersion,
      policyVersion: APPEARANCE_GALLERY_POLICY.policyVersion,
      galleryVersion: this.galleryVersion,
      generation: this.generation,
      ownerId: this.scope.ownerId,
      videoId: this.scope.videoId,
      subjectId: this.scope.subjectId,
      runId: this.scope.runId,
      persistMode: this.persistMode,
      extractorId: HSV_TEXTURE_EXTRACTOR_ID,
      extractorVersion: EXTRACTOR_VERSION,
      currentStateId: this.currentStateId,
      states: this.states.map((s) => ({ ...s })),
      samples,
      recent: this.recent ? Array.from(this.recent.values) : null,
      slow: this.slow ? Array.from(this.slow.values) : null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + APPEARANCE_GALLERY_POLICY.ttlMinutes * 60_000,
      estimatedBytes: this.estimatedBytes(),
    };
  }

  hydrateFromCheckpoint(snap: AppearanceCheckpointSnapshot): { ok: boolean; reason: string } {
    if (snap.schemaVersion !== APPEARANCE_GALLERY_POLICY.gallerySchemaVersion) {
      return { ok: false, reason: 'schema-mismatch' };
    }
    if (snap.extractorId !== HSV_TEXTURE_EXTRACTOR_ID || snap.extractorVersion !== EXTRACTOR_VERSION) {
      return { ok: false, reason: 'feature-version-mismatch' };
    }
    if (snap.ownerId !== this.scope.ownerId || snap.videoId !== this.scope.videoId || snap.subjectId !== this.scope.subjectId) {
      return { ok: false, reason: 'scope-mismatch' };
    }
    this.sampler.clear();
    this.past.length = 0;
    this.states.length = 0;
    this.states.push(...snap.states.map((s) => ({ ...s })));
    this.currentStateId = snap.currentStateId;
    const currentVerified: StableSample[] = [];
    for (const s of snap.samples) {
      if (s.source !== 'user_anchor' && s.source !== 'verified_auto') {
        return { ok: false, reason: 'tentative-not-restored' };
      }
      if (s.values.some((v) => !Number.isFinite(v)) || s.values.length !== DESCRIPTOR_SIZE) {
        return { ok: false, reason: 'corrupt-vector' };
      }
      const desc: Descriptor = {
        values: Float32Array.from(s.values),
        samples: s.samples,
        trust: s.trust,
        bandSamples: s.bandSamples,
      };
      const row = {
        tSec: s.tSec,
        trackId: s.trackId,
        quality: s.quality,
        visibility: s.visibility,
        view: s.view,
        box: { ...s.box },
        overlapOthers: false,
        cameraOk: true,
        gmcOk: true,
        descriptor: desc,
      };
      const full: StableSample = {
        ...row,
        source: s.source,
        hash: null,
        admittedAt: s.tSec,
        futureHits: APPEARANCE_GALLERY_POLICY.minAdmitObs,
      };
      if (s.source === 'user_anchor') this.sampler.rememberUserAnchor(row);
      else if (s.appearanceStateId === snap.currentStateId) currentVerified.push(full);
      else this.past.push(full);
    }
    this.sampler.hydrateVerified(currentVerified);
    this.galleryVersion = snap.galleryVersion;
    this.generation = snap.generation;
    this.dirty = false;
    this.compareCache.clear();
    return { ok: true, reason: 'feature-reuse' };
  }

  private bump(reason: string): void {
    this.galleryVersion += 1;
    this.dirty = true;
    this.compareCache.clear();
    this.compareCacheVersion = this.galleryVersion;
    void reason;
  }
}

export const APPEARANCE_BYTE_BUDGET_NOTE = Object.freeze({
  targetBytes: APPEARANCE_GALLERY_POLICY.byteBudget,
  descriptorFloats: DESCRIPTOR_SIZE,
  perSampleBytes: DESCRIPTOR_SIZE * 4 + 180,
  slots: APPEARANCE_GALLERY_POLICY.total,
  expectedFeatureBytes: APPEARANCE_GALLERY_POLICY.total * (DESCRIPTOR_SIZE * 4 + 180) + 2 * DESCRIPTOR_SIZE * 4,
  excludes: 'crop-buffers, decoded-frames, model-weights, JS-heap',
});
