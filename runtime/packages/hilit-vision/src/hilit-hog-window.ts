/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d28f3d32 @license @preserve */
/* 방향 기울기 창 후보. 학습 가중치가 없다.

Dalal–Triggs(2005)의 기울기 히스토그램 착상만 쓴다.
INRIA 보행자 SVM·OpenCV HOG 가중치·코드를 가져오지 않는다.
점수는 세로 가장자리 비율이지 사람 클래스 확률도 동일인 확률도 아니다.
*/

import { boxIou } from './hilit-grid-net';

export const HOG_MODEL_ID = 'hilit-hog-window-v0';
export const HOG_MODEL_VERSION = '0.1.0';

export interface HogBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

function grayAt(gray: Float32Array, width: number, height: number, x: number, y: number): number {
  const xx = Math.max(0, Math.min(width - 1, x));
  const yy = Math.max(0, Math.min(height - 1, y));
  return gray[yy * width + xx];
}

function hogWindowScore(
  gray: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const bins = new Float32Array(9);
  const step = Math.max(1, Math.floor(Math.min(w, h) / 10));
  let n = 0;
  for (let yy = y; yy < y + h; yy += step) {
    for (let xx = x; xx < x + w; xx += step) {
      const dx = grayAt(gray, width, height, xx + 1, yy) - grayAt(gray, width, height, xx - 1, yy);
      const dy = grayAt(gray, width, height, xx, yy + 1) - grayAt(gray, width, height, xx, yy - 1);
      const mag = Math.hypot(dx, dy);
      let ang = Math.atan2(dy, dx) * (180 / Math.PI);
      if (ang < 0) ang += 180;
      const bin = Math.min(8, Math.floor(ang / 20));
      bins[bin] += mag;
      n += 1;
    }
  }
  let total = 1e-6;
  for (let i = 0; i < 9; i += 1) total += bins[i];
  /* 60~120도는 세로 실루엣 쪽에 가깝다. */
  const vertical = bins[3] + bins[4] + bins[5];
  const aspect = h / Math.max(1, w);
  const aspectOk = aspect >= 1.5 && aspect <= 5.2 ? 1 : 0.12;
  const density = Math.min(1, total / Math.max(1, n * 12));
  return (vertical / total) * aspectOk * density;
}

export function rgbaToGray255(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    g[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return g;
}

export function proposeHogWindow(
  gray: Float32Array,
  width: number,
  height: number,
  maxKeep = 8,
): HogBox[] {
  if (width < 16 || height < 24) return [];
  const cand: HogBox[] = [];
  const h0 = Math.max(16, Math.round(height * 0.22));
  const h1 = Math.max(h0 + 1, Math.round(height * 0.8));
  const hStep = Math.max(8, Math.round(height * 0.1));
  for (let h = h0; h <= h1; h += hStep) {
    const w = Math.max(8, Math.round(h * 0.34));
    const yStep = Math.max(4, Math.round(h * 0.3));
    const xStep = Math.max(4, Math.round(w * 0.42));
    for (let y = 0; y <= height - h; y += yStep) {
      for (let x = 0; x <= width - w; x += xStep) {
        const score = hogWindowScore(gray, width, height, x, y, w, h);
        cand.push({ x, y, width: w, height: h, score });
      }
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const keep: HogBox[] = [];
  for (const box of cand) {
    if (box.score < 0.12) break;
    if (keep.some((k) => boxIou(k, box) > 0.5)) continue;
    keep.push(box);
    if (keep.length >= maxKeep) break;
  }
  return keep;
}
