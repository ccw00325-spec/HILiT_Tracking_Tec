/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·519f02f6 @license @preserve */
/* 착용 장비·부착물의 모양/색 대리 특징.

모자·가방을 의미적으로 분류하지 않는다. 사람 crop의 머리 윗부분과
상체 좌우에서 색 분포와 경계 방향을 재어, 사용자가 확인한 모습과
일관되는지만 본다. 같은 화소에서 나온 단서이므로 독립 인증으로
계산하지 않고, 신뢰 가능한 모순을 H0(미복귀/판단불가)에만 보탠다.
*/

export type EquipmentProxyStatus = 'ok' | 'unknown';
export type EquipmentProxyZoneName = 'head_top' | 'upper_left' | 'upper_right';

export interface EquipmentProxyZone {
  name: EquipmentProxyZoneName;
  values: Float32Array;
  pixels: number;
  gradientEnergy: number;
  status: EquipmentProxyStatus;
}

export interface EquipmentProxyDescriptor {
  zones: [EquipmentProxyZone, EquipmentProxyZone, EquipmentProxyZone];
  role: 'same-pixel-equipment-proxy';
  semanticClassification: false;
}

export interface EquipmentProxyCompare {
  score: number | null;
  usedZones: number;
  contradictions: number;
  reliable: boolean;
  independentAuth: false;
}

const COLOR_BINS = 12;
const EDGE_BINS = 4;
const SIZE = COLOR_BINS + EDGE_BINS;
const MIN_PIXELS = 32;
const MIN_GRADIENT = 120;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function toHsv(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
    else if (max === gg) h = ((bb - rr) / d + 2) / 6;
    else h = ((rr - gg) / d + 4) / 6;
  }
  return [h, max > 1e-6 ? d / max : 0, max];
}

function normalizeSlice(values: Float32Array, start: number, end: number): void {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += values[i];
  if (sum <= 0) return;
  for (let i = start; i < end; i += 1) values[i] /= sum;
}

function describeZone(
  name: EquipmentProxyZoneName,
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  hasAlpha: boolean,
): EquipmentProxyZone {
  const values = new Float32Array(SIZE);
  const stride = hasAlpha ? 4 : 3;
  let pixels = 0;
  let gradientEnergy = 0;
  const x0 = Math.max(1, Math.floor(rect.x0 * w));
  const y0 = Math.max(1, Math.floor(rect.y0 * h));
  const x1 = Math.min(w - 1, Math.ceil(rect.x1 * w));
  const y1 = Math.min(h - 1, Math.ceil(rect.y1 * h));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * w + x) * stride;
      if (hasAlpha && rgb[i + 3] < 8) continue;
      const [hh, ss, vv] = toHsv(rgb[i], rgb[i + 1], rgb[i + 2]);
      const colorBin = ss < 0.16
        ? 8 + Math.min(3, Math.floor(vv * 4))
        : Math.min(7, Math.floor(hh * 8));
      values[colorBin] += 1;
      const left = i - stride;
      const up = i - w * stride;
      const gx = luma(rgb[i], rgb[i + 1], rgb[i + 2])
        - luma(rgb[left], rgb[left + 1], rgb[left + 2]);
      const gy = luma(rgb[i], rgb[i + 1], rgb[i + 2])
        - luma(rgb[up], rgb[up + 1], rgb[up + 2]);
      const mag = Math.hypot(gx, gy);
      if (mag >= 6) {
        let a = Math.atan2(gy, gx);
        if (a < 0) a += Math.PI;
        const bin = Math.min(EDGE_BINS - 1, Math.floor((a / Math.PI) * EDGE_BINS));
        values[COLOR_BINS + bin] += mag;
        gradientEnergy += mag;
      }
      pixels += 1;
    }
  }
  normalizeSlice(values, 0, COLOR_BINS);
  normalizeSlice(values, COLOR_BINS, SIZE);
  return {
    name,
    values,
    pixels,
    gradientEnergy,
    status: pixels >= MIN_PIXELS && gradientEnergy >= MIN_GRADIENT ? 'ok' : 'unknown',
  };
}

export function describeEquipmentProxy(
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  hasAlpha = false,
): EquipmentProxyDescriptor {
  const zones: [EquipmentProxyZone, EquipmentProxyZone, EquipmentProxyZone] = [
    describeZone('head_top', rgb, w, h, { x0: 0.18, y0: 0.01, x1: 0.82, y1: 0.24 }, hasAlpha),
    describeZone('upper_left', rgb, w, h, { x0: 0.04, y0: 0.24, x1: 0.50, y1: 0.68 }, hasAlpha),
    describeZone('upper_right', rgb, w, h, { x0: 0.50, y0: 0.24, x1: 0.96, y1: 0.68 }, hasAlpha),
  ];
  return { zones, role: 'same-pixel-equipment-proxy', semanticClassification: false };
}

function zoneSimilarity(a: EquipmentProxyZone, b: EquipmentProxyZone): number | null {
  if (a.status !== 'ok' || b.status !== 'ok') return null;
  let color = 0;
  for (let i = 0; i < COLOR_BINS; i += 1) color += Math.min(a.values[i], b.values[i]);
  let edge = 0;
  for (let i = COLOR_BINS; i < SIZE; i += 1) edge += Math.sqrt(a.values[i] * b.values[i]);
  return clamp01(color * 0.72 + edge * 0.28);
}

export function compareEquipmentProxy(
  a: EquipmentProxyDescriptor,
  b: EquipmentProxyDescriptor,
  visible: readonly [boolean, boolean, boolean],
): EquipmentProxyCompare {
  let sum = 0;
  let used = 0;
  let contradictions = 0;
  for (let i = 0; i < 3; i += 1) {
    const bodyPart = i === 0 ? 0 : 1;
    if (!visible[bodyPart]) continue;
    const score = zoneSimilarity(a.zones[i], b.zones[i]);
    if (score == null) continue;
    sum += score;
    used += 1;
    if (score < 0.38) contradictions += 1;
  }
  return {
    score: used ? sum / used : null,
    usedZones: used,
    contradictions,
    reliable: used >= 2,
    independentAuth: false,
  };
}

