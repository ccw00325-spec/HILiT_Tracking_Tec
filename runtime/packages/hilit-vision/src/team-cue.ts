/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·5e128502 @license @preserve */
/* TeamCue — 유니폼 색 군집. 개인 신원이 아니다.

같은 팀 후보를 표시해, 같은 색 안에서 여유 문턱을 높이려고 쓴다.
학습 가중치가 없다. 전 세션 갤러리가 아니다.
*/

export const TEAM_BINS = 8;
export const TEAM_SAME = 0.78;
export const TEAM_DIFF = 0.52;

export interface TeamVector {
  hist: number[];
  samples: number;
}

export interface TeamDecision {
  sameTeam: boolean | null;
  score: number | null;
  reason: string;
  identityConfirmed: false;
}

function hueHist(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): TeamVector {
  const hist = new Array(TEAM_BINS).fill(0);
  let samples = 0;
  const y0 = Math.floor(h * 0.22);
  const y1 = Math.ceil(h * 0.70);
  const x0 = Math.floor(w * 0.18);
  const x1 = Math.ceil(w * 0.82);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * w + x) * 4;
      const r = rgba[p] / 255;
      const g = rgba[p + 1] / 255;
      const b = rgba[p + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const s = max === 0 ? 0 : (max - min) / max;
      if (s < 0.12 || max < 0.12) continue;
      let hue = 0;
      const d = max - min;
      if (d > 1e-6) {
        if (max === r) hue = ((g - b) / d) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue /= 6;
        if (hue < 0) hue += 1;
      }
      hist[Math.min(TEAM_BINS - 1, Math.floor(hue * TEAM_BINS))] += 1;
      samples += 1;
    }
  }
  const sum = hist.reduce((a, b) => a + b, 0);
  return { hist: sum ? hist.map((v) => v / sum) : hist, samples };
}

export function describeTeam(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): TeamVector {
  return hueHist(rgba, width, height);
}

export function teamAffinity(a: TeamVector, b: TeamVector): number | null {
  if (a.samples < 40 || b.samples < 40) return null;
  let s = 0;
  for (let i = 0; i < TEAM_BINS; i += 1) s += Math.sqrt(a.hist[i] * b.hist[i]);
  return Math.max(0, Math.min(1, s));
}

export function decideTeamCue(self: TeamVector, other: TeamVector): TeamDecision {
  const score = teamAffinity(self, other);
  if (score == null) {
    return { sameTeam: null, score: null, reason: 'weak-color', identityConfirmed: false };
  }
  if (score >= TEAM_SAME) {
    return { sameTeam: true, score, reason: 'same-kit-color', identityConfirmed: false };
  }
  if (score <= TEAM_DIFF) {
    return { sameTeam: false, score, reason: 'different-kit-color', identityConfirmed: false };
  }
  return { sameTeam: null, score, reason: 'ambiguous-kit', identityConfirmed: false };
}

export function clusterTeamLabels(vectors: readonly TeamVector[]): Array<number | null> {
  if (vectors.length === 0) return [];
  const labels: Array<number | null> = vectors.map(() => null);
  let next = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    if (vectors[i].samples < 40) continue;
    if (labels[i] != null) continue;
    labels[i] = next;
    for (let j = i + 1; j < vectors.length; j += 1) {
      const aff = teamAffinity(vectors[i], vectors[j]);
      if (aff != null && aff >= TEAM_SAME) labels[j] = next;
    }
    next += 1;
  }
  return labels;
}
