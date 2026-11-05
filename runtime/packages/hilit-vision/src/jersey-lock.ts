/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·5bd99464 @license @preserve */
/* JerseyLock — 등번호 잠금. 세션 한정.

SoccerNet·리그 영상·외부 OCR 가중치를 쓰지 않는다.
숫자는 우리가 그린 7분획 템플릿과 crop의 이진화 형상을 비교한다.
얼굴이 아니고, 전 영상 갤러리가 아니다. 사용자 확인 전에 번호를
앵커로 올리지 않는다. 점수는 확률이 아니다.
*/

export const JERSEY_ACCEPT = 0.72;
export const JERSEY_MARGIN = 0.10;
export const JERSEY_TPL_W = 12;
export const JERSEY_TPL_H = 18;

export interface JerseyRead {
  digits: string | null;
  score: number;
  quality: number;
  reason: string;
}

export interface JerseyDecision {
  action: 'agree' | 'hold' | 'conflict';
  reason: string;
  locked: string | null;
  read: string | null;
  identityConfirmed: false;
  eligibleForAutoReacquire: false;
}

const SEGMENTS: Record<string, number> = {
  '0': 0b1110111,
  '1': 0b0010010,
  '2': 0b1011101,
  '3': 0b1011011,
  '4': 0b0111010,
  '5': 0b1101011,
  '6': 0b1101111,
  '7': 0b1010010,
  '8': 0b1111111,
  '9': 0b1111011,
};

function paintDigit(digit: string): Uint8Array {
  const bits = SEGMENTS[digit] ?? 0;
  const out = new Uint8Array(JERSEY_TPL_W * JERSEY_TPL_H);
  const on = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (x >= 0 && y >= 0 && x < JERSEY_TPL_W && y < JERSEY_TPL_H) {
          out[y * JERSEY_TPL_W + x] = 1;
        }
      }
    }
  };
  /* 7분획: a b c d e f g */
  if (bits & 0b1000000) on(2, 1, 9, 2);
  if (bits & 0b0100000) on(9, 2, 10, 8);
  if (bits & 0b0010000) on(9, 9, 10, 15);
  if (bits & 0b0001000) on(2, 15, 9, 16);
  if (bits & 0b0000100) on(1, 9, 2, 15);
  if (bits & 0b0000010) on(1, 2, 2, 8);
  if (bits & 0b0000001) on(2, 8, 9, 9);
  return out;
}

const TEMPLATES = '0123456789'.split('').map((d) => ({ d, img: paintDigit(d) }));

function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) {
    const p = i * 4;
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

function cropBand(gray: Uint8Array, w: number, h: number): { data: Uint8Array; width: number; height: number } {
  const x0 = Math.floor(w * 0.22);
  const x1 = Math.ceil(w * 0.78);
  const y0 = Math.floor(h * 0.28);
  const y1 = Math.ceil(h * 0.62);
  const bw = Math.max(4, x1 - x0);
  const bh = Math.max(4, y1 - y0);
  const data = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y += 1) {
    data.set(gray.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + bw), y * bw);
  }
  return { data, width: bw, height: bh };
}

function binarize(gray: Uint8Array): Uint8Array {
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) sum += gray[i];
  const mean = sum / Math.max(1, gray.length);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = gray[i] < mean - 8 ? 1 : 0;
  return out;
}

function resizeBinary(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}

function matchDigit(bin: Uint8Array): { digit: string; score: number } {
  let best = '0';
  let bestScore = -1;
  for (const tpl of TEMPLATES) {
    let same = 0;
    for (let i = 0; i < bin.length; i += 1) if (bin[i] === tpl.img[i]) same += 1;
    const score = same / bin.length;
    if (score > bestScore) {
      bestScore = score;
      best = tpl.d;
    }
  }
  return { digit: best, score: bestScore };
}

export function readJerseyNumber(input: {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}): JerseyRead {
  if (input.width < 16 || input.height < 24) {
    return { digits: null, score: 0, quality: 0, reason: 'crop-too-small' };
  }
  const gray = toGray(input.rgba, input.width, input.height);
  const band = cropBand(gray, input.width, input.height);
  const bin = binarize(band.data);
  let ink = 0;
  for (let i = 0; i < bin.length; i += 1) ink += bin[i];
  const fill = ink / bin.length;
  if (fill < 0.04 || fill > 0.55) {
    return { digits: null, score: 0, quality: fill, reason: 'no-digit-contrast' };
  }
  const mid = Math.floor(band.width / 2);
  const left = new Uint8Array(Math.floor(band.width / 2) * band.height);
  const right = new Uint8Array((band.width - mid) * band.height);
  for (let y = 0; y < band.height; y += 1) {
    left.set(bin.subarray(y * band.width, y * band.width + mid), y * mid);
    right.set(bin.subarray(y * band.width + mid, y * band.width + band.width), y * (band.width - mid));
  }
  const leftInk = left.reduce((s, v) => s + v, 0) / Math.max(1, left.length);
  const rightInk = right.reduce((s, v) => s + v, 0) / Math.max(1, right.length);
  if (leftInk > 0.06 && rightInk > 0.06) {
    const a = matchDigit(resizeBinary(left, mid, band.height, JERSEY_TPL_W, JERSEY_TPL_H));
    const b = matchDigit(resizeBinary(right, band.width - mid, band.height, JERSEY_TPL_W, JERSEY_TPL_H));
    const score = Math.min(a.score, b.score);
    if (score < JERSEY_ACCEPT) return { digits: null, score, quality: fill, reason: 'two-digit-weak' };
    return { digits: `${a.digit}${b.digit}`, score, quality: fill, reason: 'two-digit' };
  }
  const one = matchDigit(resizeBinary(bin, band.width, band.height, JERSEY_TPL_W, JERSEY_TPL_H));
  if (one.score < JERSEY_ACCEPT) return { digits: null, score: one.score, quality: fill, reason: 'one-digit-weak' };
  return { digits: one.digit, score: one.score, quality: fill, reason: 'one-digit' };
}

export class JerseyLock {
  private locked: string | null = null;

  get value(): string | null { return this.locked; }

  remember(read: JerseyRead, userConfirmed: boolean): boolean {
    if (!userConfirmed || !read.digits || read.score < JERSEY_ACCEPT) return false;
    this.locked = read.digits;
    return true;
  }

  clear(): void { this.locked = null; }

  decide(read: JerseyRead): JerseyDecision {
    const base = {
      locked: this.locked,
      read: read.digits,
      identityConfirmed: false as const,
      eligibleForAutoReacquire: false as const,
    };
    if (!this.locked) {
      return { action: 'hold', reason: 'no-lock', ...base };
    }
    if (!read.digits || read.score < JERSEY_ACCEPT) {
      return { action: 'hold', reason: 'unreadable', ...base };
    }
    if (read.digits === this.locked) {
      return { action: 'agree', reason: 'same-number', ...base };
    }
    return { action: 'conflict', reason: 'different-number', ...base };
  }
}
