/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·353359ce @license @preserve */
/* CourtHint — 선이 보일 때만 바닥 힌트.

교정된 경기장 카메라가 아니면 실패가 기본값이다.
외부 코트 모델·키포인트를 쓰지 않는다. 호모그래피가 안 나오면
usable=false 이고 추적을 바꾸지 않는다.
*/

export const COURT_MIN_LINES = 4;
export const COURT_MIN_QUALITY = 0.35;

export interface CourtPoint {
  x: number;
  y: number;
}

export interface CourtHintResult {
  usable: boolean;
  quality: number;
  reason: string;
  lineCount: number;
  foot: CourtPoint | null;
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  angle: number;
  length: number;
}

function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) {
    const p = i * 4;
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

function edges(gray: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      out[i] = Math.min(255, Math.abs(gx) + Math.abs(gy));
    }
  }
  return out;
}

function collectLines(edge: Uint8Array, w: number, h: number): Line[] {
  const lines: Line[] = [];
  const step = 3;
  for (let y = 2; y < h - 2; y += step) {
    let run = 0;
    let start = 0;
    for (let x = 2; x < w - 2; x += 1) {
      if (edge[y * w + x] > 46) {
        if (run === 0) start = x;
        run += 1;
      } else if (run >= 14) {
        lines.push({
          x1: start, y1: y, x2: x, y2: y,
          angle: 0,
          length: run,
        });
        run = 0;
      } else run = 0;
    }
  }
  for (let x = 2; x < w - 2; x += step) {
    let run = 0;
    let start = 0;
    for (let y = 2; y < h - 2; y += 1) {
      if (edge[y * w + x] > 46) {
        if (run === 0) start = y;
        run += 1;
      } else if (run >= 14) {
        lines.push({
          x1: x, y1: start, x2: x, y2: y,
          angle: Math.PI / 2,
          length: run,
        });
        run = 0;
      } else run = 0;
    }
  }
  return lines.filter((l) => l.length >= Math.min(w, h) * 0.18);
}

export function estimateCourtHint(input: {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  subject?: { x: number; y: number; width: number; height: number } | null;
}): CourtHintResult {
  if (input.width < 64 || input.height < 64) {
    return { usable: false, quality: 0, reason: 'frame-too-small', lineCount: 0, foot: null };
  }
  const gray = toGray(input.rgba, input.width, input.height);
  const edge = edges(gray, input.width, input.height);
  const lines = collectLines(edge, input.width, input.height);
  const horiz = lines.filter((l) => Math.abs(l.angle) < 0.2).length;
  const vert = lines.filter((l) => Math.abs(l.angle - Math.PI / 2) < 0.2).length;
  if (lines.length < COURT_MIN_LINES || horiz < 2 || vert < 1) {
    return { usable: false, quality: 0, reason: 'not-enough-lines', lineCount: lines.length, foot: null };
  }
  const quality = Math.max(0, Math.min(1, (horiz + vert) / 10));
  if (quality < COURT_MIN_QUALITY) {
    return { usable: false, quality, reason: 'low-line-quality', lineCount: lines.length, foot: null };
  }
  const sub = input.subject;
  const foot = sub
    ? { x: sub.x + sub.width / 2, y: sub.y + sub.height }
    : null;
  return {
    usable: true,
    quality,
    reason: 'axis-aligned-lines',
    lineCount: lines.length,
    foot,
  };
}

export function courtFootDistance(
  a: CourtPoint | null,
  b: CourtPoint | null,
  height: number,
): number | null {
  if (!a || !b || height <= 0) return null;
  return Math.hypot(a.x - b.x, a.y - b.y) / height;
}
