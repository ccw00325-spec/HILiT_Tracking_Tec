/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·cb992ae4 @license @preserve */
/* 손대는 무늬 서술자. 학습 가중치가 아니다.

같은 유니폼 색이어도 줄무늬·단색은 기울기 방향이 다르다.
색이 같으면 이것만으로 사람을 확정하지 않는다.
*/

export const TEXTURE_ORIENT_BINS = 8;
export const TEXTURE_BANDS = 3;
export const TEXTURE_SIZE = TEXTURE_ORIENT_BINS * TEXTURE_BANDS;
export const TEXTURE_MIN_ENERGY = 40;

export interface TextureDescriptor {
  values: Float32Array;
  energy: number;
  bandEnergy: [number, number, number];
}

const BANDS = [0.25, 0.45, 0.30] as const;

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function describeTexture(
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  hasAlpha = false,
): TextureDescriptor {
  const values = new Float32Array(TEXTURE_SIZE);
  const bandEnergy: [number, number, number] = [0, 0, 0];
  const stride = hasAlpha ? 4 : 3;
  if (w < 6 || h < 10) return { values, energy: 0, bandEnergy };

  let y0 = 0;
  for (let band = 0; band < TEXTURE_BANDS; band += 1) {
    const y1 = band === TEXTURE_BANDS - 1 ? h : Math.min(h, y0 + Math.round(h * BANDS[band]));
    const base = band * TEXTURE_ORIENT_BINS;
    let energy = 0;
    for (let y = Math.max(y0, 1); y < Math.min(y1, h - 1); y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = (y * w + x) * stride;
        if (hasAlpha && rgb[i + 3] < 8) continue;
        const c = luma(rgb[i], rgb[i + 1], rgb[i + 2]);
        const rgt = luma(rgb[i + stride], rgb[i + stride + 1], rgb[i + stride + 2]);
        const lft = luma(rgb[i - stride], rgb[i - stride + 1], rgb[i - stride + 2]);
        const downI = ((y + 1) * w + x) * stride;
        const upI = ((y - 1) * w + x) * stride;
        const dn = luma(rgb[downI], rgb[downI + 1], rgb[downI + 2]);
        const up = luma(rgb[upI], rgb[upI + 1], rgb[upI + 2]);
        const gx = rgt - lft;
        const gy = dn - up;
        const mag = Math.hypot(gx, gy);
        if (mag < 6) continue;
        let ang = Math.atan2(gy, gx);
        if (ang < 0) ang += Math.PI;
        const bin = Math.min(TEXTURE_ORIENT_BINS - 1, Math.floor((ang / Math.PI) * TEXTURE_ORIENT_BINS));
        values[base + bin] += mag;
        energy += mag;
      }
    }
    bandEnergy[band] = energy;
    if (energy > 0) {
      for (let k = 0; k < TEXTURE_ORIENT_BINS; k += 1) values[base + k] /= energy;
    }
    y0 = y1;
  }
  return { values, energy: bandEnergy[0] + bandEnergy[1] + bandEnergy[2], bandEnergy };
}

export function textureSimilarity(a: TextureDescriptor, b: TextureDescriptor): number {
  if (a.energy < TEXTURE_MIN_ENERGY || b.energy < TEXTURE_MIN_ENERGY) return 0.5;
  let total = 0;
  let weight = 0;
  const w = [0.6, 2.0, 0.8] as const;
  for (let band = 0; band < TEXTURE_BANDS; band += 1) {
    if (a.bandEnergy[band] < TEXTURE_MIN_ENERGY / 3 || b.bandEnergy[band] < TEXTURE_MIN_ENERGY / 3) continue;
    const base = band * TEXTURE_ORIENT_BINS;
    let inter = 0;
    for (let k = 0; k < TEXTURE_ORIENT_BINS; k += 1) {
      inter += Math.min(a.values[base + k], b.values[base + k]);
    }
    total += inter * w[band];
    weight += w[band];
  }
  if (weight <= 0) return 0.5;
  return Math.max(0, Math.min(1, total / weight));
}
