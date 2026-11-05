/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·02aafa9a @license @preserve */
/* Re-ID 단계 시간. 해시만 빠른 것을 전체 추적 가속이라고 적지 않는다. */

export type ReidTimingKey =
  | 'decode_crop'
  | 'detect'
  | 'pose'
  | 'camera'
  | 'motion'
  | 'cheap_quality'
  | 'feature'
  | 'hash'
  | 'direct_compare'
  | 'neighbor_rerank'
  | 'gallery_admit'
  | 'pipeline';

export interface ReidTimingSample {
  key: ReidTimingKey;
  ms: number;
  candidates?: number;
  samples?: number;
  bytes?: number;
}

export class ReidTimer {
  private readonly buckets = new Map<ReidTimingKey, number[]>();
  mark(key: ReidTimingKey, ms: number, extra?: Omit<ReidTimingSample, 'key' | 'ms'>): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const list = this.buckets.get(key) ?? [];
    list.push(ms);
    this.buckets.set(key, list);
    void extra;
  }
  percentile(key: ReidTimingKey, p: number): number | null {
    const list = this.buckets.get(key);
    if (!list?.length) return null;
    const s = list.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[i];
  }
  summary(): Record<string, { n: number; p50: number | null; p95: number | null }> {
    const out: Record<string, { n: number; p50: number | null; p95: number | null }> = {};
    for (const key of this.buckets.keys()) {
      const list = this.buckets.get(key)!;
      out[key] = { n: list.length, p50: this.percentile(key, 50), p95: this.percentile(key, 95) };
    }
    return out;
  }
}

export function nowMs(): number {
  const c = globalThis.performance;
  return c && typeof c.now === 'function' ? c.now() : Date.now();
}
