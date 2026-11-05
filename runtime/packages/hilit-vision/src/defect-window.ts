/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·bd42d71a @license @preserve */
/* 시간 구간 특징. 프레임 수가 아니라 실제 timestamp 로 창을 자른다.

push 는 시간이 앞으로만 간다(되돌아가는 시각은 거부). stats(now) 는 now 이하의
기록만 본다 — 미래 프레임이 입력에 섞이지 않게 하는 것이 이 클래스의 존재 이유다.
*/

export const DEFECT_WINDOWS_SEC = [0.25, 0.5, 1.0, 2.0] as const;

export interface WindowStat {
  mean: number;
  std: number;
  min: number;
  max: number;
  median: number;
  p10: number;
  p90: number;
  slope: number;
  lastMinusMean: number;
  maxStep: number;
  missingRatio: number;
  count: number;
}

export const WINDOW_STAT_KEYS = ['mean', 'std', 'min', 'max', 'median', 'p10', 'p90', 'slope', 'lastMinusMean', 'maxStep', 'missingRatio'] as const;

function nanStat(count: number): WindowStat {
  return {
    mean: Number.NaN, std: Number.NaN, min: Number.NaN, max: Number.NaN, median: Number.NaN,
    p10: Number.NaN, p90: Number.NaN, slope: Number.NaN, lastMinusMean: Number.NaN, maxStep: Number.NaN,
    missingRatio: 1, count,
  };
}

export class TimeWindowBuffer {
  private rows: Array<{ t: number; v: Float64Array }> = [];
  constructor(readonly width: number, private readonly keepSec = 2.5) {}

  /** @returns 받아들였는지. 시간이 거꾸로 가거나 폭이 다르면 버린다. */
  push(tSec: number, values: ArrayLike<number>): boolean {
    if (!Number.isFinite(tSec) || values.length !== this.width) return false;
    const last = this.rows[this.rows.length - 1];
    if (last && tSec <= last.t) return false;
    this.rows.push({ t: tSec, v: Float64Array.from(values as ArrayLike<number>) });
    const cut = tSec - this.keepSec;
    while (this.rows.length && this.rows[0].t < cut) this.rows.shift();
    return true;
  }

  get size(): number {
    return this.rows.length;
  }

  lastTime(): number | null {
    return this.rows.length ? this.rows[this.rows.length - 1].t : null;
  }

  /** now 이하 · (now − windowSec, now] 안의 기록 한 열의 통계. */
  stat(nowSec: number, windowSec: number, col: number): WindowStat {
    const pts: Array<{ t: number; v: number }> = [];
    let total = 0;
    for (const r of this.rows) {
      if (r.t > nowSec + 1e-9) continue; // 미래는 보지 않는다
      if (r.t <= nowSec - windowSec - 1e-9) continue;
      total += 1;
      const v = r.v[col];
      if (Number.isFinite(v)) pts.push({ t: r.t, v });
    }
    if (!pts.length) return nanStat(total);
    const vals = pts.map((p) => p.v).sort((a, b) => a - b);
    const n = vals.length;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const std = n > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
    const q = (p: number) => vals[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
    let slope = 0;
    if (n >= 2) {
      const tm = pts.reduce((s, p) => s + p.t, 0) / n;
      let num = 0;
      let den = 0;
      for (const p of pts) {
        num += (p.t - tm) * (p.v - mean);
        den += (p.t - tm) ** 2;
      }
      slope = den > 1e-12 ? num / den : 0;
    }
    let maxStep = 0;
    for (let i = 1; i < pts.length; i += 1) maxStep = Math.max(maxStep, Math.abs(pts[i].v - pts[i - 1].v));
    return {
      mean, std, min: vals[0], max: vals[n - 1], median: q(0.5), p10: q(0.1), p90: q(0.9),
      slope, lastMinusMean: pts[pts.length - 1].v - mean, maxStep,
      missingRatio: total ? 1 - n / total : 1, count: total,
    };
  }

  /** 행 전체(최근 windowSec 안). 시간 특징 행렬 SVD 용. */
  matrix(nowSec: number, windowSec: number): Float64Array[] {
    return this.rows.filter((r) => r.t <= nowSec + 1e-9 && r.t > nowSec - windowSec - 1e-9).map((r) => r.v);
  }
}
