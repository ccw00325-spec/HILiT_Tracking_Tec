/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·bf25b000 @license @preserve */
/* 고전 세로 에너지 창 — 학습 가중치가 없다.

Dalal–Triggs HOG 사람 검출기(2005)의 착상만 빌린다: 사람은 세로로 길고
가장자리가 많다. 코드·가중치는 가져오지 않았다.

점수는 "세로로 선 덩어리일 가능성"이지 사람 클래스 확률도,
동일인 확률도 아니다. 제품에서 자동 확정에 쓰지 않는다.
*/

import { boxIou } from './hilit-grid-net';

export const STAND_MODEL_ID = 'hilit-stand-energy-v0';
export const STAND_MODEL_VERSION = '0.1.0';

export interface StandBox {
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

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    g[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return g;
}

function windowScore(
  gray: Float32Array, width: number, height: number,
  x: number, y: number, w: number, h: number,
): number {
  let edge = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 12));
  for (let yy = y; yy < y + h; yy += step) {
    for (let xx = x; xx < x + w; xx += step) {
      const dx = grayAt(gray, width, height, xx + 1, yy) - grayAt(gray, width, height, xx - 1, yy);
      const dy = grayAt(gray, width, height, xx, yy + 1) - grayAt(gray, width, height, xx, yy - 1);
      edge += Math.abs(dx) * 0.35 + Math.abs(dy);
      n += 1;
    }
  }
  const mean = n ? edge / n : 0;
  const aspect = h / Math.max(1, w);
  const aspectOk = aspect >= 1.6 && aspect <= 5.2 ? 1 : 0.15;
  return mean * aspectOk;
}

export function proposeStandEnergy(
  gray: Float32Array,
  width: number,
  height: number,
  maxKeep = 8,
): StandBox[] {
  if (width < 16 || height < 24) return [];
  const cand: StandBox[] = [];
  const h0 = Math.max(16, Math.round(height * 0.22));
  const h1 = Math.max(h0 + 1, Math.round(height * 0.78));
  const hStep = Math.max(8, Math.round(height * 0.1));
  for (let h = h0; h <= h1; h += hStep) {
    const w = Math.max(8, Math.round(h * 0.36));
    const yStep = Math.max(4, Math.round(h * 0.28));
    const xStep = Math.max(4, Math.round(w * 0.4));
    for (let y = 0; y <= height - h; y += yStep) {
      for (let x = 0; x <= width - w; x += xStep) {
        const score = windowScore(gray, width, height, x, y, w, h);
        cand.push({ x, y, width: w, height: h, score });
      }
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const floor = cand.length ? cand[0].score * 0.42 : 0;
  const keep: StandBox[] = [];
  for (const box of cand) {
    if (box.score < Math.max(4, floor)) continue;
    if (keep.some((k) => boxIou(k, box) > 0.4)) continue;
    keep.push(box);
    if (keep.length >= maxKeep) break;
  }
  if (!keep.length) return [];
  const max = keep[0].score || 1;
  return keep.map((b) => ({ ...b, score: Math.min(0.99, b.score / max) }));
}
