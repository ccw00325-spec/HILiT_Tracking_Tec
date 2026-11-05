/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·4567bb52 @license @preserve */
/* 스포츠 개인 추적 보조 — packages/hilit-vision 의 브라우저 사본.
 * 자동 재획득을 열지 않는다. 옆 사람으로의 점프만 막는다.
 */

import { applyAffineToBox } from './affine-gmc.js';

export const TRACKLET_MIN_HITS = 3;
export const TRACKLET_SWITCH_BODIES = 0.8;
export const TRACKLET_BIND_IOU = 0.35;

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

function centre(b) {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export class TrackletGraph {
  constructor() {
    this.items = [];
    this.nextId = 1;
    this.subjectId = null;
  }

  clear() {
    this.items = [];
    this.nextId = 1;
    this.subjectId = null;
  }

  update({ t, detections, affine, subject }) {
    const dets = (detections || []).filter((b) => b.width > 4 && b.height > 4);
    if (dets.length < 2) return [];
    const predicted = this.items.map((item) => {
      const dt = Math.max(0, t - item.lastT);
      let box = {
        x: item.box.x + item.vx * dt,
        y: item.box.y + item.vy * dt,
        width: item.box.width,
        height: item.box.height,
      };
      if (affine && Number.isFinite(affine.a)) box = applyAffineToBox(box, affine);
      return { item, box };
    });
    const usedT = new Set();
    const usedD = new Set();
    const pairs = [];
    for (let ti = 0; ti < predicted.length; ti += 1) {
      for (let di = 0; di < dets.length; di += 1) {
        const overlap = iou(predicted[ti].box, dets[di]);
        const moved = Math.hypot(
          centre(predicted[ti].box).x - centre(dets[di]).x,
          centre(predicted[ti].box).y - centre(dets[di]).y,
        );
        if (moved > Math.max(8, predicted[ti].item.box.width) * 3.2) continue;
        pairs.push({ ti, di, cost: moved / Math.max(8, predicted[ti].item.box.width) - overlap });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const assigned = new Array(dets.length).fill(0);
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti);
      usedD.add(p.di);
      const item = predicted[p.ti].item;
      const det = dets[p.di];
      const dt = Math.max(1e-3, t - item.lastT);
      item.vx = (det.x - item.box.x) / dt;
      item.vy = (det.y - item.box.y) / dt;
      item.box = { ...det };
      item.lastT = t;
      item.hits += 1;
      item.misses = 0;
      assigned[p.di] = item.id;
    }
    for (let di = 0; di < dets.length; di += 1) {
      if (usedD.has(di)) continue;
      const id = this.nextId++;
      this.items.push({
        id, box: { ...dets[di] }, vx: 0, vy: 0, lastT: t, startT: t, hits: 1, misses: 0,
      });
      assigned[di] = id;
    }
    this.items = this.items.filter((item) => {
      if (item.lastT === t) return true;
      item.misses += 1;
      return item.misses <= 3;
    });
    if (subject) this.bindSubject(subject);
    return assigned;
  }

  bindSubject(box) {
    let best = null;
    let bestIou = TRACKLET_BIND_IOU;
    for (const item of this.items) {
      const v = iou(item.box, box);
      if (v > bestIou) {
        bestIou = v;
        best = item;
      }
    }
    if (!best || best.hits < 2) return this.subjectId;
    this.subjectId = best.id;
    return best.id;
  }

  find(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  coVisible(a, b) {
    const A = this.find(a);
    const B = this.find(b);
    if (!A || !B) return false;
    return Math.abs(A.lastT - B.lastT) < 1.5 && A.hits >= 2 && B.hits >= 2;
  }

  decideSwitch(candidate) {
    const none = (reason) => ({
      action: 'continue',
      reason,
      subjectTrackletId: this.subjectId,
      candidateTrackletId: null,
      identityConfirmed: false,
      eligibleForAutoReacquire: false,
    });
    const mine = this.find(this.subjectId);
    if (!mine || mine.hits < TRACKLET_MIN_HITS) return none('subject-tracklet-unready');
    let other = null;
    let best = TRACKLET_BIND_IOU;
    for (const item of this.items) {
      const v = iou(item.box, candidate);
      if (v > best) {
        best = v;
        other = item;
      }
    }
    if (!other) return none('candidate-unbound');
    if (other.id === mine.id) return none('same-tracklet');
    if (other.hits < TRACKLET_MIN_HITS) return none('candidate-tracklet-unready');
    const body = Math.max(8, mine.box.width);
    const dx = (candidate.x + candidate.width / 2) - (mine.box.x + mine.box.width / 2);
    const dy = (candidate.y + candidate.height / 2) - (mine.box.y + mine.box.height / 2);
    if (Math.hypot(dx, dy) < TRACKLET_SWITCH_BODIES * body) return none('near-current-box');
    if (!this.coVisible(other.id, mine.id)) {
      return {
        action: 'hold', reason: 'different-tracklet-not-covisible',
        subjectTrackletId: mine.id, candidateTrackletId: other.id,
        identityConfirmed: false, eligibleForAutoReacquire: false,
      };
    }
    return {
      action: 'block-switch', reason: 'co-visible-other-person',
      subjectTrackletId: mine.id, candidateTrackletId: other.id,
      identityConfirmed: false, eligibleForAutoReacquire: false,
    };
  }
}

export function gateSportsIdentity(input) {
  const deny = (reason) => ({
    action: 'reject-switch', reason, identityConfirmed: false, eligibleForAutoReacquire: false,
  });
  const hold = (reason) => ({
    action: 'hold', reason, identityConfirmed: false, eligibleForAutoReacquire: false,
  });
  if (input.jersey?.action === 'conflict') return deny('jersey-conflict');
  if (input.tracklet?.action === 'block-switch') return deny(input.tracklet.reason);
  if (input.appearance === 'reject') return deny('appearance-reject');
  if (input.jersey?.action === 'hold' && input.jersey.locked) return hold('jersey-unreadable');
  if (input.tracklet?.action === 'hold') return hold(input.tracklet.reason);
  if (input.appearance === 'hold') return hold('appearance-hold');
  if (input.team?.sameTeam === true && (input.gapSeconds ?? 0) > 0.8) return hold('same-team-after-gap');
  if (input.courtFar === true && (input.gapSeconds ?? 0) < 0.5) return hold('court-teleport');
  if (input.appearance === 'accept' && input.tracklet?.action !== 'block-switch' && input.jersey?.action !== 'conflict') {
    return { action: 'accept', reason: 'multi-signal-ok', identityConfirmed: false, eligibleForAutoReacquire: false };
  }
  return hold('insufficient-sports-evidence');
}

const JERSEY_ACCEPT = 0.72;
const JERSEY_TPL_W = 12;
const JERSEY_TPL_H = 18;
const SEGMENTS = {
  '0': 0b1110111, '1': 0b0010010, '2': 0b1011101, '3': 0b1011011, '4': 0b0111010,
  '5': 0b1101011, '6': 0b1101111, '7': 0b1010010, '8': 0b1111111, '9': 0b1111011,
};

function paintDigit(digit) {
  const bits = SEGMENTS[digit] ?? 0;
  const out = new Uint8Array(JERSEY_TPL_W * JERSEY_TPL_H);
  const on = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (x >= 0 && y >= 0 && x < JERSEY_TPL_W && y < JERSEY_TPL_H) out[y * JERSEY_TPL_W + x] = 1;
      }
    }
  };
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

function matchDigit(bin) {
  let best = '0', bestScore = -1;
  for (const tpl of TEMPLATES) {
    let same = 0;
    for (let i = 0; i < bin.length; i += 1) if (bin[i] === tpl.img[i]) same += 1;
    const score = same / bin.length;
    if (score > bestScore) { bestScore = score; best = tpl.d; }
  }
  return { digit: best, score: bestScore };
}

function resizeBinary(src, sw, sh, dw, dh) {
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

export function readJerseyNumber(rgba, width, height) {
  if (width < 16 || height < 24) return { digits: null, score: 0, quality: 0, reason: 'crop-too-small' };
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    const p = i * 4;
    gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  const x0 = Math.floor(width * 0.22), x1 = Math.ceil(width * 0.78);
  const y0 = Math.floor(height * 0.28), y1 = Math.ceil(height * 0.62);
  const bw = Math.max(4, x1 - x0), bh = Math.max(4, y1 - y0);
  const band = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y += 1) band.set(gray.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + bw), y * bw);
  let sum = 0;
  for (let i = 0; i < band.length; i += 1) sum += band[i];
  const mean = sum / band.length;
  const bin = new Uint8Array(band.length);
  let ink = 0;
  for (let i = 0; i < band.length; i += 1) {
    bin[i] = band[i] < mean - 8 ? 1 : 0;
    ink += bin[i];
  }
  const fill = ink / bin.length;
  if (fill < 0.04 || fill > 0.55) return { digits: null, score: 0, quality: fill, reason: 'no-digit-contrast' };
  const one = matchDigit(resizeBinary(bin, bw, bh, JERSEY_TPL_W, JERSEY_TPL_H));
  if (one.score < JERSEY_ACCEPT) return { digits: null, score: one.score, quality: fill, reason: 'one-digit-weak' };
  return { digits: one.digit, score: one.score, quality: fill, reason: 'one-digit' };
}

export class JerseyLock {
  constructor() { this.locked = null; }
  get value() { return this.locked; }
  remember(read, userConfirmed) {
    if (!userConfirmed || !read.digits || read.score < JERSEY_ACCEPT) return false;
    this.locked = read.digits;
    return true;
  }
  decide(read) {
    const base = { locked: this.locked, read: read.digits, identityConfirmed: false, eligibleForAutoReacquire: false };
    if (!this.locked) return { action: 'hold', reason: 'no-lock', ...base };
    if (!read.digits || read.score < JERSEY_ACCEPT) return { action: 'hold', reason: 'unreadable', ...base };
    if (read.digits === this.locked) return { action: 'agree', reason: 'same-number', ...base };
    return { action: 'conflict', reason: 'different-number', ...base };
  }
}

const TEAM_BINS = 8;
const TEAM_SAME = 0.78;
const TEAM_DIFF = 0.52;

export function describeTeam(rgba, width, height) {
  const hist = new Array(TEAM_BINS).fill(0);
  let samples = 0;
  const y0 = Math.floor(height * 0.22), y1 = Math.ceil(height * 0.70);
  const x0 = Math.floor(width * 0.18), x1 = Math.ceil(width * 0.82);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * width + x) * 4;
      const r = rgba[p] / 255, g = rgba[p + 1] / 255, b = rgba[p + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
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

export function decideTeamCue(self, other) {
  if (!self || !other || self.samples < 40 || other.samples < 40) {
    return { sameTeam: null, score: null, reason: 'weak-color', identityConfirmed: false };
  }
  let s = 0;
  for (let i = 0; i < TEAM_BINS; i += 1) s += Math.sqrt(self.hist[i] * other.hist[i]);
  const score = Math.max(0, Math.min(1, s));
  if (score >= TEAM_SAME) return { sameTeam: true, score, reason: 'same-kit-color', identityConfirmed: false };
  if (score <= TEAM_DIFF) return { sameTeam: false, score, reason: 'different-kit-color', identityConfirmed: false };
  return { sameTeam: null, score, reason: 'ambiguous-kit', identityConfirmed: false };
}

export function estimateCourtHint(rgba, width, height, subject) {
  if (width < 64 || height < 64) {
    return { usable: false, quality: 0, reason: 'frame-too-small', lineCount: 0, foot: null };
  }
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    const p = i * 4;
    gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  const edge = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      edge[i] = Math.min(255, Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + width] - gray[i - width]));
    }
  }
  let lines = 0, horiz = 0, vert = 0;
  const minLen = Math.round(Math.min(width, height) * 0.18);
  for (let y = 2; y < height - 2; y += 3) {
    let run = 0;
    for (let x = 2; x < width - 2; x += 1) {
      if (edge[y * width + x] > 46) run += 1;
      else {
        if (run >= 14 && run >= minLen) { lines += 1; horiz += 1; }
        run = 0;
      }
    }
  }
  for (let x = 2; x < width - 2; x += 3) {
    let run = 0;
    for (let y = 2; y < height - 2; y += 1) {
      if (edge[y * width + x] > 46) run += 1;
      else {
        if (run >= 14 && run >= minLen) { lines += 1; vert += 1; }
        run = 0;
      }
    }
  }
  if (lines < 4 || horiz < 2 || vert < 1) {
    return { usable: false, quality: 0, reason: 'not-enough-lines', lineCount: lines, foot: null };
  }
  const quality = Math.max(0, Math.min(1, (horiz + vert) / 10));
  if (quality < 0.35) return { usable: false, quality, reason: 'low-line-quality', lineCount: lines, foot: null };
  const foot = subject ? { x: subject.x + subject.width / 2, y: subject.y + subject.height } : null;
  return { usable: true, quality, reason: 'axis-aligned-lines', lineCount: lines, foot };
}

export function courtFootDistance(a, b, height) {
  if (!a || !b || height <= 0) return null;
  return Math.hypot(a.x - b.x, a.y - b.y) / height;
}

export function applyOcclusionCrop({ cropShare, maxCropShare, subject, others }) {
  let overlap = 0;
  for (const other of others || []) overlap = Math.max(overlap, iou(subject, other));
  const factor = overlap > 0.22 ? 1 + 0.32 * Math.min(1, (overlap - 0.22) / 0.45) : 1;
  return { cropShare: Math.min(maxCropShare, cropShare * factor), overlap, widened: factor > 1.001 };
}

export function scoreEventForMe(input) {
  const clamp01 = (v) => (v == null || !Number.isFinite(v) ? null : Math.max(0, Math.min(1, v)));
  const speed = clamp01(input.subjectSpeed);
  if (speed == null && input.subjectAccel == null) {
    return { score: 0, reason: ['no-subject-motion'], usedGlobalShake: false };
  }
  const accel = clamp01(input.subjectAccel) ?? 0;
  const dir = clamp01(input.directionChange) ?? 0;
  const size = clamp01(input.sizeChange) ?? 0;
  const health = clamp01(input.trackingHealth) ?? 0.4;
  let raw = (speed ?? 0) * 0.36 + accel * 0.28 + dir * 0.18 + size * 0.10;
  if (input.jerseyReadable) raw += 0.08;
  const overlap = clamp01(input.overlapOthers) ?? 0;
  raw *= 1 - 0.45 * overlap;
  if (input.identityHold) raw *= 0.35;
  raw *= 0.55 + 0.45 * health;
  if ((input.cameraShake ?? 0) > 0.55 && (speed ?? 0) < 0.12) raw *= 0.25;
  const reason = [];
  if ((speed ?? 0) > 0.45) reason.push('subject-fast');
  if (accel > 0.45) reason.push('subject-accel');
  if (dir > 0.45) reason.push('subject-turn');
  if (input.jerseyReadable) reason.push('jersey-readable');
  if (overlap > 0.22) reason.push('overlap-penalized');
  if (!reason.length) reason.push('subject-motion');
  return { score: Math.max(0, Math.min(1, raw)), reason: reason.slice(0, 3), usedGlobalShake: false };
}
