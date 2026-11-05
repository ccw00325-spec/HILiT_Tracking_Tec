/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d2c68138 @license @preserve */
/* 외형 특징 공간의 k-reciprocal Jaccard 재순위.

이웃은 화면에서 옆 사람이나 인접 프레임이 아니다.
같은 세션 표본 벡터가 특징 공간에서 가까운 것이다.

전수 비교가 기준선이다. HNSW/LSH 는 넣지 않는다.
새 이웃 점수는 독립 인증이 아니다. 직접 외형 점수와 섞을 뿐이다.
잠정 표본은 그래프에 넣지 않는다. 사용자 확인 표본을 자동 표본이 덮지 않는다.
*/

import { similarity, type Descriptor } from './appearance';
import { isNearDuplicate } from './perceptual-hash';

export type RerankSource = 'user_anchor' | 'verified_auto' | 'tentative';

export interface RerankSample {
  id: string;
  descriptor: Descriptor;
  source: RerankSource;
  trackId?: string;
  tSec?: number;
  hash?: bigint | null;
}

export interface RerankCandidate {
  id: string;
  descriptor: Descriptor;
  /** 이미 계산된 직접 외형 점수 0~1. 확률이 아니다. */
  directScore: number;
  hash?: bigint | null;
}

export interface RerankResultRow {
  id: string;
  directScore: number;
  neighborScore: number | null;
  blended: number;
  usedFallback: boolean;
  reason: string;
  independentAuth: false;
}

export const K_RECIPROCAL_POLICY = Object.freeze({
  k: 3,
  /** 직접 점수에 붙는 이웃 비중. 작은 세션용 초기값. 실사 최적 아님. */
  blend: 0.25,
  minGallery: 3,
  minCandidates: 2,
  minDistinctGallery: 3,
  /** 1·2위 직접 점수 차가 이보다 크면 이웃 그래프를 만들지 않는다. */
  ambiguousMargin: 0.08,
});

export function shouldNeighborRerank(input: {
  scores: ReadonlyArray<number | null | undefined>;
  galleryCount: number;
  distinctGallery: number;
  candidateCount: number;
}): { run: boolean; reason: string } {
  if (input.candidateCount < K_RECIPROCAL_POLICY.minCandidates) {
    return { run: false, reason: 'too-few-candidates' };
  }
  if (input.galleryCount < K_RECIPROCAL_POLICY.minGallery
    || input.distinctGallery < K_RECIPROCAL_POLICY.minDistinctGallery) {
    return { run: false, reason: 'insufficient-gallery' };
  }
  const scores = input.scores
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
    .slice()
    .sort((a, b) => b - a);
  if (scores.length < 2) return { run: false, reason: 'no-competition' };
  const margin = scores[0] - scores[1];
  if (margin >= K_RECIPROCAL_POLICY.ambiguousMargin) {
    return { run: false, reason: 'direct-clear' };
  }
  return { run: true, reason: 'ambiguous-direct' };
}

function descriptorSig(d: Descriptor): string {
  const v = d.values;
  const a = v.length ? v[0] : 0;
  const b = v.length > 8 ? v[8] : 0;
  const c = v.length > 16 ? v[16] : 0;
  return `${d.samples}:${a.toFixed(3)}:${b.toFixed(3)}:${c.toFixed(3)}`;
}

export class JaccardNeighborCache {
  private key = '';
  private result: { rows: RerankResultRow[]; usedFallback: boolean; reason: string } | null = null;
  hits = 0;
  misses = 0;

  fingerprint(input: {
    galleryVersion: number;
    gallery: readonly RerankSample[];
    candidates: readonly RerankCandidate[];
  }): string {
    const g = input.gallery.map((s) => `${s.id}:${descriptorSig(s.descriptor)}`).join('|');
    const c = input.candidates.map((s) => `${s.id}:${descriptorSig(s.descriptor)}:${s.directScore.toFixed(4)}`).join('|');
    return `${input.galleryVersion}#${g}#${c}`;
  }

  take(fp: string): { rows: RerankResultRow[]; usedFallback: boolean; reason: string } | null {
    if (this.result && this.key === fp) {
      this.hits += 1;
      return this.result;
    }
    this.misses += 1;
    return null;
  }

  store(fp: string, result: { rows: RerankResultRow[]; usedFallback: boolean; reason: string }): void {
    this.key = fp;
    this.result = result;
  }

  clear(): void {
    this.key = '';
    this.result = null;
  }
}

export function kReciprocalRerankCached(
  input: {
    gallery: readonly RerankSample[];
    candidates: readonly RerankCandidate[];
    k?: number;
    blend?: number;
    galleryVersion?: number;
  },
  cache: JaccardNeighborCache,
): { rows: RerankResultRow[]; usedFallback: boolean; reason: string } {
  const fp = cache.fingerprint({
    galleryVersion: input.galleryVersion ?? 0,
    gallery: input.gallery,
    candidates: input.candidates,
  });
  const hit = cache.take(fp);
  if (hit) return hit;
  const out = kReciprocalRerank(input);
  cache.store(fp, out);
  return out;
}

function appearanceDistance(a: Descriptor, b: Descriptor): number | null {
  if (a.samples < 60 || b.samples < 60) return null;
  const s = similarity(a, b);
  if (!Number.isFinite(s)) return null;
  return 1 - Math.max(0, Math.min(1, s));
}

function distinctGallery(gallery: readonly RerankSample[]): RerankSample[] {
  const out: RerankSample[] = [];
  for (const g of gallery) {
    if (g.source === 'tentative') continue;
    const dup = out.some((x) => {
      if (g.hash != null && x.hash != null) return isNearDuplicate(g.hash, x.hash);
      if (g.trackId && x.trackId === g.trackId && g.tSec != null && x.tSec != null
        && Math.abs(g.tSec - x.tSec) < 0.12) {
        return appearanceDistance(g.descriptor, x.descriptor) != null
          && (appearanceDistance(g.descriptor, x.descriptor) as number) < 0.04;
      }
      return false;
    });
    if (!dup) out.push(g);
  }
  return out;
}

function kNeighbors(
  index: number,
  dist: Array<Array<number | null>>,
  k: number,
): number[] {
  const row = dist[index]
    .map((d, j) => ({ d, j }))
    .filter((x) => x.j !== index && x.d != null)
    .sort((a, b) => (a.d as number) - (b.d as number))
    .slice(0, k)
    .map((x) => x.j);
  return row;
}

function encodeNeighbors(ids: readonly number[], n: number): Uint8Array {
  const bits = new Uint8Array(n);
  for (const i of ids) if (i >= 0 && i < n) bits[i] = 1;
  return bits;
}

function setJaccard(a: Uint8Array, b: Uint8Array): number | null {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av || bv) union += 1;
    if (av && bv) inter += 1;
  }
  if (union === 0) return null;
  return inter / union;
}

/**
 * 후보 순위를 이웃 Jaccard 로 재평가한다.
 * 표본이 부족하거나 이웃이 불안정하면 직접 점수로 fallback 한다.
 */
export function kReciprocalRerank(input: {
  gallery: readonly RerankSample[];
  candidates: readonly RerankCandidate[];
  k?: number;
  blend?: number;
}): { rows: RerankResultRow[]; usedFallback: boolean; reason: string } {
  const k = input.k ?? K_RECIPROCAL_POLICY.k;
  const blend = input.blend ?? K_RECIPROCAL_POLICY.blend;
  const gallery = distinctGallery(input.gallery);
  const fallback = (reason: string): { rows: RerankResultRow[]; usedFallback: boolean; reason: string } => ({
    usedFallback: true,
    reason,
    rows: input.candidates.map((c) => ({
      id: c.id,
      directScore: c.directScore,
      neighborScore: null,
      blended: c.directScore,
      usedFallback: true,
      reason,
      independentAuth: false as const,
    })),
  });

  if (input.candidates.length < K_RECIPROCAL_POLICY.minCandidates) {
    return fallback('too-few-candidates');
  }
  if (gallery.length < K_RECIPROCAL_POLICY.minGallery
    || gallery.length < K_RECIPROCAL_POLICY.minDistinctGallery) {
    return fallback('insufficient-gallery');
  }

  const nodes: Array<{ kind: 'g' | 'c'; sample?: RerankSample; cand?: RerankCandidate }> = [
    ...gallery.map((g) => ({ kind: 'g' as const, sample: g })),
    ...input.candidates.map((c) => ({ kind: 'c' as const, cand: c })),
  ];
  const n = nodes.length;
  const dist: Array<Array<number | null>> = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  for (let i = 0; i < n; i += 1) {
    dist[i][i] = 0;
    const di = nodes[i].kind === 'g' ? nodes[i].sample!.descriptor : nodes[i].cand!.descriptor;
    for (let j = i + 1; j < n; j += 1) {
      const dj = nodes[j].kind === 'g' ? nodes[j].sample!.descriptor : nodes[j].cand!.descriptor;
      const d = appearanceDistance(di, dj);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  const knn = nodes.map((_, i) => kNeighbors(i, dist, k));
  const reciprocal: number[][] = knn.map((nbrs, i) => nbrs.filter((j) => knn[j].includes(i)));
  const encodings = reciprocal.map((nbrs, i) => {
    const set = encodeNeighbors(nbrs, n);
    set[i] = 1;
    return set;
  });

  const unstable = encodings.every((e) => e.reduce((s, v) => s + v, 0) <= 1);
  if (unstable) return fallback('unstable-neighbors');

  /* 대상 표본만으로 후보가 같은 이웃을 공유하면 순위가 안 갈린다. */
  const candStart = gallery.length;
  let sharedAll = true;
  for (let a = candStart + 1; a < n; a += 1) {
    const j = setJaccard(encodings[candStart], encodings[a]);
    if (j == null || j < 0.999) sharedAll = false;
  }
  if (input.candidates.length > 1 && sharedAll) return fallback('shared-neighbor-collapse');

  const rows: RerankResultRow[] = input.candidates.map((c, ci) => {
    const idx = candStart + ci;
    let best = 0;
    let used = 0;
    for (let g = 0; g < gallery.length; g += 1) {
      const j = setJaccard(encodings[idx], encodings[g]);
      if (j == null) continue;
      const weight = gallery[g].source === 'user_anchor' ? 1 : 0.55;
      best = Math.max(best, j * weight);
      used += 1;
    }
    const neighborScore = used ? best : null;
    const blended = neighborScore == null
      ? c.directScore
      : (1 - blend) * c.directScore + blend * neighborScore;
    return {
      id: c.id,
      directScore: c.directScore,
      neighborScore,
      blended: Math.max(0, Math.min(1, blended)),
      usedFallback: neighborScore == null,
      reason: neighborScore == null ? 'no-reciprocal-overlap' : 'reranked',
      independentAuth: false as const,
    };
  });
  return { rows, usedFallback: false, reason: 'reranked' };
}
