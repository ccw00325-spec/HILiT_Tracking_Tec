/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·1d69fdd4 @license @preserve */
/* 검출 연결 추적(linked-v1) — 브라우저 부분. 영상을 읽고 사람을 검출해 linked-core.js 에 넘긴다.
 *
 * 왜 이렇게 나눴나: 검출(느림)은 대상과 상관없이 한 번만 하면 된다. 「이 사람이 맞나요?」에 답한 뒤 다시 찾을 때,
 * 「여긴 내가 없어요」 뒤에 이어 찾을 때 검출을 다시 하지 않고 잇기(빠름)만 다시 한다. 검출 결과는 이 영상이
 * 열려 있는 동안 파이프라인 객체에만 남는다(기기 밖으로 나가지 않는다).
 *
 * 검출기는 편집 2단계와 같은 MediaPipe EfficientDet-Lite0(작업자, Apache-2.0)이다. 화면 전체 한 번 + 정사각 조각
 * 두 번(작게 찍힌 사람을 키워 본다). 점수는 「사람처럼 보이는 정도」지 동일인 확률이 아니다.
 *
 * 2026-10-27(사용자 승인 제안 1·2·5번) 더한 것:
 *   - 검출마다 색·밝기·윤곽 단서와 상자 둘레 배경 단서(linked-cues.js) — 잇기가 장면별 무게를 고른다.
 *   - 1초에 한 번, 큰 사람 상자에 사람 모양 마스크(person-mask-client.js) — 배경 화소를 뺀 단서.
 *   - 놓친 자리 확대 재검출 — 대상 줄이 끊긴 직후 내다본 자리만 잘라 한 번 더 검출하고 다시 잇는다. 상자는 여전히
 *     검출된 사람 위에만 놓인다(배경에 붙지 않는다).
 */
import { describeRgba, CROP_W, CROP_H } from './hilit-appearance.js';
import { describeCues } from './linked-cues.js';
import { personMask, personMaskAvailable } from './person-mask-client.js';
import {
  LINKED_ENGINE, LINKED_POLICY, mergeDetections, buildTracklets, linkTarget, renderTrajectory, iou, accumulatedShift,
} from './linked-core.js';

const SAMPLE_KEY = (t) => Math.round(t * 1000);

/** 검출 뒤 다듬기 값(2026-10-27). */
export const LINKED_REFINE = Object.freeze({
  /** 사람 모양 마스크(제안 1번). 이 간격(초, 영상 시간 격자)마다, 키가 fgMaskMinH 이상인 큰 사람부터 fgMaskMax 명. */
  fgMask: true,
  fgMaskEverySec: 1,
  fgMaskMax: 8,
  fgMaskMinH: 48,
  /** 놓친 자리 확대 재검출(제안 5번). 대상 줄이 끊긴 뒤 zoomWindowSec 동안 내다본 자리를, 키의 zoomSide 배 정사각으로. */
  zoom: true,
  zoomWindowSec: 1.2,
  zoomSide: 2.6,
  zoomMinSide: 96,
  /** 확대 검출을 받는 점수. 2026-10-27 dev 96명(SAM 2 채점): 0.15 → IoU0.5 78.9%·다른 사람 188, 0.4 → 80.1%·179,
   *  0.6 → 80.3%·175(확대 없이 1·2·4번만 79.8→80.2%). 값은 dev 로만 골랐다. */
  zoomScoreMin: 0.6,
  /** 한 번 찾기에서 확대 검출을 부르는 상한, 다시 잇기 횟수. */
  zoomBudget: 90,
  zoomRounds: 2,
  /** 내다본 자리에서 이만큼(키 배수) 안, 키 비율 이 범위 안의 검출만 받는다. */
  zoomNear: 1.2,
  zoomRatioMin: 0.55,
  zoomRatioMax: 1.8,
});

/** 조각 자리 — 가로 영상이면 왼쪽·오른쪽 정사각, 세로 영상이면 위·아래 정사각. 거의 정사각이면 조각 없음. */
export function tileRegions(width, height) {
  const long = Math.max(width, height), short = Math.min(width, height);
  if (long / short < 1.25) return [];
  if (width >= height) return [{ x: 0, y: 0, width: short, height: short }, { x: width - short, y: 0, width: short, height: short }];
  return [{ x: 0, y: 0, width: short, height: short }, { x: 0, y: height - short, width: short, height: short }];
}

/** 조각 안쪽 경계(화면 가장자리가 아닌 쪽)에 닿은 상자는 잘린 사람일 수 있어 버린다. */
function cutAtSeam(hit, region, frame) {
  const m = 3;
  const left = hit.x <= m && region.x > 0;
  const right = hit.x + hit.width >= region.width - m && region.x + region.width < frame.width;
  const top = hit.y <= m && region.y > 0;
  const bottom = hit.y + hit.height >= region.height - m && region.y + region.height < frame.height;
  return left || right || top || bottom;
}

let scratch = null;
function scratchCanvas(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  return scratch;
}

/** 한 장의 모든 사람. probe(canvas) → [{x,y,width,height,score}] 캔버스 화소. */
async function detectAll(canvas, probe, frame) {
  const all = [];
  const full = await probe(canvas);
  if (!Array.isArray(full)) return null;
  for (const h of full) all.push({ x: h.x, y: h.y, width: h.width, height: h.height, score: h.score ?? 0 });
  for (const r of tileRegions(frame.width, frame.height)) {
    const c = scratchCanvas(r.width, r.height);
    c.getContext('2d').drawImage(canvas, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    const hits = await probe(c);
    if (!Array.isArray(hits)) continue;
    for (const h of hits) {
      if (cutAtSeam(h, r, frame)) continue;
      all.push({ x: h.x + r.x, y: h.y + r.y, width: h.width, height: h.height, score: h.score ?? 0 });
    }
  }
  return mergeDetections(all.map((d) => clampBox(d, frame)).filter((d) => d.width > 2 && d.height > 2));
}

function clampBox(b, frame) {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { ...b, x, y, width: Math.min(frame.width, b.x + b.width) - x, height: Math.min(frame.height, b.y + b.height) - y };
}

/** 한 장 전체 화소(검출된 사람 여럿의 겉모습을 한 번 읽어 센다). 못 읽으면 null. */
function frameImage(ctx) {
  try { return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height); } catch { return null; }
}

/** img 의 [x0,x1)×[y0,y1) 를 CROP_W×CROP_H 로 줄인 rgba. 예전 describeBox 와 같은 표본 자리다. */
function resampleRect(img, x0, y0, x1, y1) {
  const sw = x1 - x0, sh = y1 - y0;
  if (sw < 1 || sh < 1) return null;
  const sd = img.data, W = img.width;
  const out = new Uint8ClampedArray(CROP_W * CROP_H * 4);
  for (let j = 0; j < CROP_H; j += 1) {
    const yy = y0 + Math.min(sh - 1, Math.floor(j * sh / CROP_H));
    for (let i = 0; i < CROP_W; i += 1) {
      const xx = x0 + Math.min(sw - 1, Math.floor(i * sw / CROP_W));
      const si = (yy * W + xx) * 4, di = (j * CROP_W + i) * 4;
      out[di] = sd[si]; out[di + 1] = sd[si + 1]; out[di + 2] = sd[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

function boxRect(img, box) {
  const sx = Math.max(0, Math.floor(box.x)), sy = Math.max(0, Math.floor(box.y));
  const ex = Math.min(img.width, Math.ceil(box.x + box.width)), ey = Math.min(img.height, Math.ceil(box.y + box.height));
  return { sx, sy, ex, ey };
}

/** 상자 왼쪽·오른쪽 띠(상자 너비의 절반)를 붙여 만든 「둘레 배경」 조각. 띠가 화면 밖이면 반대쪽으로 채운다. */
function ringRgba(img, box) {
  const strip = Math.max(4, Math.round(box.width * 0.5));
  const y0 = Math.max(0, Math.floor(box.y)), y1 = Math.min(img.height, Math.ceil(box.y + box.height));
  const lx0 = Math.max(0, Math.floor(box.x) - strip), lx1 = Math.max(0, Math.floor(box.x));
  const rx0 = Math.min(img.width, Math.ceil(box.x + box.width)), rx1 = Math.min(img.width, Math.ceil(box.x + box.width) + strip);
  const left = lx1 - lx0 >= 3 && y1 - y0 >= 8 ? resampleRect(img, lx0, y0, lx1, y1) : null;
  const right = rx1 - rx0 >= 3 && y1 - y0 >= 8 ? resampleRect(img, rx0, y0, rx1, y1) : null;
  const a = left || right, b = right || left;
  if (!a) return null;
  const out = new Uint8ClampedArray(CROP_W * CROP_H * 4);
  const half = CROP_W / 2;
  for (let j = 0; j < CROP_H; j += 1) {
    for (let i = 0; i < CROP_W; i += 1) {
      const src = i < half ? a : b;
      const u = Math.min(CROP_W - 1, Math.floor((i < half ? i : i - half) * 2));
      const si = (j * CROP_W + u) * 4, di = (j * CROP_W + i) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

/** 한 장 화소에서 상자 하나의 겉모습(색 분포) + 단서 + 둘레 배경 단서. 너무 작으면 null. */
export function describeFromImage(img, box) {
  if (!img) return null;
  const { sx, sy, ex, ey } = boxRect(img, box);
  if (ex - sx < 8 || ey - sy < 16) return null;
  const crop = resampleRect(img, sx, sy, ex, ey);
  const d = describeRgba(crop, CROP_W, CROP_H);
  if (d.samples < 60) return null;
  d.cues = describeCues(crop, CROP_W, CROP_H);
  const ring = ringRgba(img, box);
  d.ring = ring ? describeCues(ring, CROP_W, CROP_H, null, true) : null;
  return d;
}

/** 평가 덤프(debugDump)용 — 단서 배열까지 JSON 으로. 사용자 화면·저장에는 쓰지 않는다. */
function serializeDesc(d) {
  if (!d) return null;
  const cue = (c) => (c ? { v: Array.from(c.v), n: c.n, fg: c.fg } : null);
  return { values: Array.from(d.values), samples: d.samples, trust: d.trust, cues: cue(d.cues), ring: cue(d.ring), cuesFg: cue(d.cuesFg) };
}

/** 상자 하나의 겉모습(색 분포). 너무 작으면 null. */
export function describeBox(ctx, box) {
  return describeFromImage(frameImage(ctx), box);
}

/** 사람 모양 마스크로 센 단서를 desc.cuesFg 에 붙인다. 붙였으면 true. */
async function attachFg(ctx, img, det) {
  if (!det.desc || !img) return false;
  const mask = await personMask(ctx.canvas, det, CROP_W, CROP_H);
  if (!mask) return false;
  const { sx, sy, ex, ey } = boxRect(img, det);
  const crop = resampleRect(img, sx, sy, ex, ey);
  if (!crop) return false;
  const fg = describeCues(crop, CROP_W, CROP_H, mask);
  if (fg.n < 60) return false;
  det.desc.cuesFg = fg;
  return true;
}

const maskTick = (t, every) => every > 0 && Math.abs(t / every - Math.round(t / every)) < 1e-3;

/* ── 놓친 자리 확대 재검출(제안 5번) ─────────────────────────────── */

/** 대상 줄이 끊긴 직후 표본마다 내다본 상자. [{si, pred}] */
export function lossSlots(samples, built, link, refine = LINKED_REFINE) {
  const out = [];
  const st = link.state;
  const end = link.ask ? link.ask.si : samples.length;
  for (let si = Math.max(0, link.s0); si < end - 1; si += 1) {
    if (st[si]?.kind !== 'obs' || st[si + 1]?.kind === 'obs') continue;
    const last = st[si];
    /* 직전 1초 같은 줄 관측으로 속도(화면 좌표 — 카메라 이동은 따로 더한다). */
    let k = si;
    while (k - 1 >= link.s0 && st[k - 1]?.kind === 'obs' && st[k - 1].trackId === last.trackId && samples[si].t - samples[k - 1].t <= 1 + 1e-6) k -= 1;
    let vx = 0, vy = 0;
    const dt0 = samples[si].t - samples[k].t;
    if (k < si && dt0 >= 0.3) {
      const cam = accumulatedShift(built.shifts, k, si);
      const a = st[k].box;
      vx = ((last.box.x + last.box.width / 2) - (a.x + a.width / 2) - cam.dx) / dt0;
      vy = ((last.box.y + last.box.height / 2) - (a.y + a.height / 2) - cam.dy) / dt0;
      const cap = 3 * last.box.height;
      vx = Math.max(-cap, Math.min(cap, vx)); vy = Math.max(-cap, Math.min(cap, vy));
    }
    for (let j = si + 1; j < end && samples[j].t - samples[si].t <= refine.zoomWindowSec + 1e-6; j += 1) {
      if (st[j]?.kind === 'obs') break;
      const dt = samples[j].t - samples[si].t;
      const cam = accumulatedShift(built.shifts, si, j);
      out.push({ si: j, pred: { x: last.box.x + cam.dx + vx * dt, y: last.box.y + cam.dy + vy * dt, width: last.box.width, height: last.box.height } });
    }
  }
  return out;
}

/** 내다본 자리를 둘러싼 정사각(화면 안). */
export function zoomRegion(pred, frame, refine = LINKED_REFINE) {
  const side = Math.round(Math.min(Math.min(frame.width, frame.height), Math.max(refine.zoomMinSide, refine.zoomSide * pred.height)));
  const cxp = pred.x + pred.width / 2, cyp = pred.y + pred.height / 2;
  const x = Math.round(Math.max(0, Math.min(frame.width - side, cxp - side / 2)));
  const y = Math.round(Math.max(0, Math.min(frame.height - side, cyp - side / 2)));
  return { x, y, width: side, height: side };
}

/** 확대 검출 중 받을 것 — 내다본 자리 가까이, 키가 비슷하고, 이미 있는 검출과 겹치지 않는 사람. */
export function acceptZoomHits(hits, region, pred, existing, frame, refine = LINKED_REFINE) {
  const out = [];
  for (const h of hits) {
    if ((h.score ?? 0) < refine.zoomScoreMin || cutAtSeam(h, region, frame)) continue;
    const d = clampBox({ x: h.x + region.x, y: h.y + region.y, width: h.width, height: h.height, score: h.score ?? 0 }, frame);
    if (d.width <= 2 || d.height <= 2) continue;
    const ratio = d.height / Math.max(1, pred.height);
    if (ratio < refine.zoomRatioMin || ratio > refine.zoomRatioMax) continue;
    const dist = Math.hypot(d.x + d.width / 2 - (pred.x + pred.width / 2), d.y + d.height / 2 - (pred.y + pred.height / 2)) / Math.max(1, pred.height);
    if (dist > refine.zoomNear) continue;
    if ([...existing, ...out].some((e) => iou(e, d) >= 0.4)) continue;
    out.push(d);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 2);
}

let zoomScratch = null;
async function zoomDetect(pipe, row, slot, frame, probe, refine, cache) {
  const region = zoomRegion(slot.pred, frame, refine);
  const key = `${SAMPLE_KEY(row.realT ?? row.t)}:${region.x >> 3}:${region.y >> 3}:${region.width >> 3}`;
  if (cache.has(key)) return { dets: cache.get(key), probed: false };
  const ctx = await pipe.seekDraw(row.realT ?? row.t);
  if (!zoomScratch) zoomScratch = document.createElement('canvas');
  zoomScratch.width = region.width; zoomScratch.height = region.height;
  zoomScratch.getContext('2d').drawImage(ctx.canvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  let hits = null;
  try { hits = await probe(zoomScratch); } catch { hits = null; }
  const dets = Array.isArray(hits) ? acceptZoomHits(hits, region, slot.pred, row.dets, frame, refine) : [];
  if (dets.length) {
    const img = frameImage(ctx);
    for (const d of dets) { d.zoom = true; d.desc = d.height >= 20 && d.score >= 0.15 ? describeFromImage(img, d) : null; }
  }
  cache.set(key, dets);
  return { dets, probed: true };
}

/**
 * 배경을 누른 겉모습 — 상자 왼쪽·오른쪽 띠(상자 너비의 절반)의 색을 「배경」으로 주어, 사람 뒤 조명·벽 색이 겉모습을
 * 지배하지 않게 한다(hilit-appearance.js describeRgba 의 background). 띠가 화면 밖이면 반대쪽 띠로 채운다.
 */
export function describeBoxBg(ctx, box) {
  const inner = describeBox(ctx, box);
  if (!inner) return null;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const strip = Math.max(4, Math.round(box.width * 0.5));
  const y0 = Math.max(0, Math.floor(box.y)), y1 = Math.min(ch, Math.ceil(box.y + box.height));
  const lx0 = Math.max(0, Math.floor(box.x) - strip), lx1 = Math.max(0, Math.floor(box.x));
  const rx0 = Math.min(cw, Math.ceil(box.x + box.width)), rx1 = Math.min(cw, Math.ceil(box.x + box.width) + strip);
  const read = (x0, x1) => { if (x1 - x0 < 3 || y1 - y0 < 8) return null; try { return ctx.getImageData(x0, y0, x1 - x0, y1 - y0); } catch { return null; } };
  const left = read(lx0, lx1), right = read(rx0, rx1);
  const a = left || right, b = right || left;
  if (!a) return inner;
  const half = CROP_W / 2;
  const out = new Uint8ClampedArray(CROP_W * CROP_H * 4);
  for (let j = 0; j < CROP_H; j += 1) {
    for (let i = 0; i < CROP_W; i += 1) {
      const src = i < half ? a : b;
      const u = i < half ? i : i - half;
      const yy = Math.min(src.height - 1, Math.floor(j * src.height / CROP_H));
      const xx = Math.min(src.width - 1, Math.floor(u * src.width / half));
      const si = (yy * src.width + xx) * 4, di = (j * CROP_W + i) * 4;
      out[di] = src.data[si]; out[di + 1] = src.data[si + 1]; out[di + 2] = src.data[si + 2]; out[di + 3] = 255;
    }
  }
  const bg = describeRgba(out, CROP_W, CROP_H);
  /* 사람 상자를 다시 그려 배경을 눌러 준다. */
  const sx = Math.max(0, Math.floor(box.x)), ex = Math.min(cw, Math.ceil(box.x + box.width));
  const src = read(sx, ex);
  if (!src) return inner;
  const px = new Uint8ClampedArray(CROP_W * CROP_H * 4);
  for (let j = 0; j < CROP_H; j += 1) {
    const yy = Math.min(src.height - 1, Math.floor(j * src.height / CROP_H));
    for (let i = 0; i < CROP_W; i += 1) {
      const xx = Math.min(src.width - 1, Math.floor(i * src.width / CROP_W));
      const si = (yy * src.width + xx) * 4, di = (j * CROP_W + i) * 4;
      px[di] = src.data[si]; px[di + 1] = src.data[si + 1]; px[di + 2] = src.data[si + 2]; px[di + 3] = 255;
    }
  }
  const d = describeRgba(px, CROP_W, CROP_H, bg.samples > 0 ? bg : undefined);
  return d.samples >= 60 ? d : inner;
}

/** 표본 시각 — 0.2초 격자(다시 찾을 때 같은 장을 다시 쓰게) + 시작 시각. */
export function sampleTimes(start, end, hz = LINKED_POLICY.sampleHz) {
  const times = [start];
  for (let k = Math.floor(start * hz + 1e-6) + 1; k / hz <= end + 1e-6; k += 1) {
    const t = k / hz;
    if (t - times[times.length - 1] > 0.02) times.push(t);
  }
  return times;
}

/**
 * pipe: BrowserPipeline(meta·seekDraw). 돌려주는 모양은 trackLegacy 와 같다. 검출기를 못 쓰거나 고른 상자를
 * 검출로 확인하지 못하면 null — 부르는 쪽이 예전 경로로 돌린다.
 *
 * options.fromTime(2026-11-03): startTime 에서 고른 사람을 fromTime~endTime 전체에서 찾는다. 편집기 바 가운데에서
 * 골라도 그 바 앞뒤가 모두 추적된다. 앞쪽은 시간을 뒤집은 표본을 **같은 잇기 정본**(linkTarget)에 넣어 찾는다 —
 * 상자 겹침만 보는 별도 규칙이 아니므로 재등장·교차·겉모습 판단이 뒤쪽과 같다. 검출은 표본 표를 함께 쓴다.
 */
export async function trackLinked(pipe, rawBox, options = {}) {
  const seedT = Math.max(0, Number(options.startTime) || 0);
  const from = Number(options.fromTime);
  if (!Number.isFinite(from) || from > seedT - 0.05) return trackLinkedOneWay(pipe, rawBox, options);
  const m = pipe.meta;
  if (!m) return null;
  const reqEnd = Number(options.endTime);
  const end = Number.isFinite(reqEnd) && reqEnd > seedT ? Math.min(m.duration, reqEnd) : m.duration;
  const lo = Math.max(0, from);
  /* 진행률은 바 전체 기준 — 앞쪽을 지나 뒤쪽까지 한 번만 0→100 으로 간다. */
  const whole = Math.max(1e-3, end - lo);
  const backShare = (seedT - lo) / whole;
  const span = (base, share) => (i, total) => Math.round((base + share * (i / Math.max(1, total))) * 100);
  const both = { ...options, stopOnAsk: false, followThrough: true };
  delete both.fromTime;
  let backward = await trackLinkedOneWay(pipe, rawBox, { ...both, mirrorFrom: lo, progressOf: span(0, backShare) });
  if (options.signal?.aborted) throw new DOMException('Tracking aborted', 'AbortError');
  let forward = await trackLinkedOneWay(pipe, rawBox, { ...both, progressOf: span(backShare, 1 - backShare) });
  /* 한쪽만 고른 상자를 검출 줄에서 찾지 못했으면(고르기 상자와 추적 검출의 겹침이 기준 아래 — 2026-11-03 운영 에뮬레이터
   * 2/2 재현), 성공한 쪽이 고른 시각에 실제로 잡은 검출 상자로 실패한 쪽을 한 번 더 잇는다. 검출은 표본 표를 함께 써서 빠르다. */
  let seedRetry = null;
  if (!forward && backward) {
    const anchor = seedAnchor(backward.trajectory, seedT);
    if (anchor) { forward = await trackLinkedOneWay(pipe, anchor, both); seedRetry = 'forward'; }
  } else if (forward && !backward) {
    const anchor = seedAnchor(forward.trajectory, seedT);
    if (anchor) { backward = await trackLinkedOneWay(pipe, anchor, { ...both, mirrorFrom: lo }); seedRetry = 'backward'; }
  }
  if (options.signal?.aborted) throw new DOMException('Tracking aborted', 'AbortError');
  if (!forward) return null;
  /* 앞쪽 잇기만 실패했으면 뒤쪽 결과는 그대로 돌려준다. metrics.trackedStart 로 부르는 쪽이 덮지 못한 앞을 안다. */
  if (!backward) return forward;
  const trajectory = [...backward.trajectory.filter((p) => p.t < seedT - 1e-6), ...forward.trajectory];
  trajectory.forEach((p, i) => { p.frame = i; });
  const lost = trajectory.filter((p) => p.state === 'TARGET_LOST').length;
  return {
    ...forward,
    trajectory,
    linkDecisions: [...backward.linkDecisions, ...forward.linkDecisions],
    metrics: {
      ...forward.metrics,
      frames: trajectory.length,
      analysisSeconds: backward.metrics.analysisSeconds + forward.metrics.analysisSeconds,
      samples: backward.metrics.samples + forward.metrics.samples,
      detectCalls: backward.metrics.detectCalls + forward.metrics.detectCalls,
      detectFailed: backward.metrics.detectFailed + forward.metrics.detectFailed,
      reentries: backward.metrics.reentries + forward.metrics.reentries,
      swaps: backward.metrics.swaps + forward.metrics.swaps,
      lostFrames: lost,
      trackedStart: lo,
      bothWays: true,
      seedRetry,
      backwardReentries: backward.metrics.reentries,
      healthMean: trajectory.reduce((sum, p) => sum + p.health, 0) / Math.max(1, trajectory.length),
    },
  };
}

/** 고른 시각에 가장 가까운, 실제로 잡힌(TARGET_LOST 가 아닌) 궤적 점의 상자. 0.3초 넘게 떨어져 있으면 쓰지 않는다. */
export function seedAnchor(trajectory, seedT) {
  let best = null;
  for (const p of trajectory || []) {
    if (p.state === 'TARGET_LOST' || !p.box || !(p.box.width > 1) || !(p.box.height > 1)) continue;
    if (!best || Math.abs(p.t - seedT) < Math.abs(best.t - seedT)) best = p;
  }
  return best && Math.abs(best.t - seedT) <= 0.3 ? { ...best.box } : null;
}

/** 영상 시간 순서의 표본을, 고른 시각에서 거꾸로 가는 시간(0, 0.2, …)의 표본으로 바꾼다. 원본 표는 건드리지 않는다. */
export function mirrorSamples(samples, seedT) {
  return samples.slice().reverse().map((row) => ({ t: seedT - row.t, realT: row.t, dets: row.dets }));
}

/** 뒤집은 시간으로 만든 궤적을 실제 시각의 시간순으로 되돌린다(제자리). */
export function unmirrorTrajectory(trajectory, seedT) {
  for (const p of trajectory) p.t = seedT - p.t;
  trajectory.reverse();
  return trajectory;
}

/**
 * 한 방향 찾기. mirrorFrom 이 있으면 startTime → mirrorFrom 쪽으로 찾는다: 검출은 시간 순서대로 하고(되감기 seek 가 없다),
 * 잇기에 넘길 때만 시간을 startTime - t 로 뒤집는다. 궤적은 실제 시각으로 되돌려 시간순으로 돌려준다.
 */
async function trackLinkedOneWay(pipe, rawBox, options = {}) {
  const m = pipe.meta;
  const probe = options.personProbe;
  if (!m || typeof probe !== 'function') return null;
  const seedBox = {
    x: Number(rawBox?.x), y: Number(rawBox?.y),
    width: Number(rawBox?.width ?? rawBox?.w), height: Number(rawBox?.height ?? rawBox?.h),
  };
  if (![seedBox.x, seedBox.y, seedBox.width, seedBox.height].every(Number.isFinite) || seedBox.width < 1 || seedBox.height < 1) {
    throw new Error(`추적 대상 박스가 유효하지 않습니다: ${JSON.stringify(rawBox)}`);
  }
  const frame = { width: m.width, height: m.height };
  const began = performance.now();
  const start = Math.max(0, Math.min(Number(options.startTime) || 0, m.duration - 0.05));
  const mirrorFrom = Number(options.mirrorFrom);
  const mirror = Number.isFinite(mirrorFrom) && mirrorFrom < start;
  const reqEnd = Number(options.endTime);
  const end = mirror ? start : (Number.isFinite(reqEnd) && reqEnd > start ? Math.min(m.duration, reqEnd) : m.duration);
  const times = mirror ? [...sampleTimes(mirrorFrom, Math.max(mirrorFrom, start - 0.02)), start] : sampleTimes(start, Math.max(start, end - 0.02));
  const cacheKey = `${m.srcWidth}x${m.srcHeight}:${m.duration}:${m.width}`;
  if (!pipe._linkedCache || pipe._linkedCache.key !== cacheKey) pipe._linkedCache = { key: cacheKey, samples: new Map() };
  const cache = pipe._linkedCache.samples;
  if (!pipe._linkedCache.zoom) pipe._linkedCache.zoom = new Map();
  const refine = { ...LINKED_REFINE, ...(options.linkedRefine || {}) };
  const useMask = refine.fgMask === true && personMaskAvailable();
  const seen = [];
  let detectCalls = 0, detectFailed = 0, fgMasks = 0, fgMs = 0;
  const total = times.length;
  for (let i = 0; i < times.length; i += 1) {
    if (options.signal?.aborted) throw new DOMException('Tracking aborted', 'AbortError');
    const t = times[i];
    let row = cache.get(SAMPLE_KEY(t));
    if (!row) {
      const ctx = await pipe.seekDraw(t);
      let dets = null;
      try { dets = await detectAll(ctx.canvas, probe, frame); } catch { dets = null; }
      detectCalls += 1;
      if (!dets) {
        detectFailed += 1;
        /* 검출기가 처음부터 안 되면 예전 경로로. */
        if (i === 0) return null;
        dets = [];
      }
      const img = dets.length ? frameImage(ctx) : null;
      for (const d of dets) {
        const big = d.height >= 20 && d.score >= 0.2;
        d.desc = big ? describeFromImage(img, d) : null;
        d.descBg = big && options.debugDump === true ? describeBoxBg(ctx, d) : null;
      }
      /* 1초에 한 번 큰 사람부터 사람 모양 마스크 — 영상 시간 격자에 맞춰 다시 찾을 때도 같은 장이 마스크를 가진다. */
      if (useMask && img && maskTick(t, refine.fgMaskEverySec)) {
        const big = dets.filter((d) => d.desc && d.height >= refine.fgMaskMinH && d.score >= 0.3)
          .sort((a, b) => b.height - a.height).slice(0, refine.fgMaskMax);
        const f0 = performance.now();
        for (const d of big) if (await attachFg(ctx, img, d)) fgMasks += 1;
        fgMs += performance.now() - f0;
      }
      row = { t, dets };
      cache.set(SAMPLE_KEY(t), row);
    }
    seen.push(row);
    pipe.onProgress?.({ phase: 'track', frame: i, total, percent: options.progressOf ? options.progressOf(i, total) : Math.round((i / Math.max(1, total)) * 100) });
  }
  /* 표본 표는 영상 시간 그대로 두고(다시 찾을 때 함께 쓴다), 잇기에 넘길 줄만 뒤집는다. */
  const samples = mirror ? mirrorSamples(seen, start) : seen;
  /* 고른 상자의 겉모습 — 처음 고른 모습은 기억에서 지우지 않는다. 사용자가 고른 모습은 마스크도 꼭 붙여 본다. */
  const seedView = async (time, box) => {
    const c = await pipe.seekDraw(time);
    const img = frameImage(c);
    const d = describeFromImage(img, box);
    if (d && useMask && await attachFg(c, img, { ...box, desc: d })) fgMasks += 1;
    return d;
  };
  const seedDescs = [await seedView(start, seedBox)].filter(Boolean);
  for (const view of (Array.isArray(options.confirmedViews) ? options.confirmedViews.slice(0, 6) : [])) {
    if (view?.userConfirmed !== true || !view.box || !Number.isFinite(view.time)) continue;
    try { const d = await seedView(view.time, view.box); if (d) seedDescs.push(d); } catch { /* 못 읽으면 뺀다 */ }
  }
  const rejected = (Array.isArray(options.rejectedViews) ? options.rejectedViews : [])
    .filter((r) => r && Number.isFinite(r.time) && r.box)
    .map((r) => ({ t: mirror ? start - r.time : r.time, box: r.box }));
  const linkOn = (rows, b) => linkTarget({
    samples: rows, built: b, frame, seed: { t: mirror ? 0 : start, box: seedBox }, rejected, seedDescs,
    stopOnAsk: options.stopOnAsk === true, askNotBefore: options.askNotBefore, followThrough: options.followThrough === true,
  });
  let rows = samples;
  let built = buildTracklets(rows, frame);
  let link = linkOn(rows, built);
  if (!link.ok) return null;
  /* 놓친 자리 확대 재검출 — 끊긴 직후 내다본 자리에서 사람을 더 찾았으면 다시 잇는다. 찾은 검출은 이 찾기에서만 쓴다
   * (다른 대상을 찾을 때 섞이지 않게 검출 표에 넣지 않는다). */
  const zoomDets = new Map();
  let zoomProbes = 0, zoomAdded = 0, zoomRelinks = 0;
  const z0 = performance.now();
  if (refine.zoom === true) {
    const tried = new Set();
    for (let round = 0; round < refine.zoomRounds; round += 1) {
      let added = 0;
      for (const slot of lossSlots(rows, built, link, refine)) {
        if (options.signal?.aborted) throw new DOMException('Tracking aborted', 'AbortError');
        if (tried.has(slot.si) || zoomProbes >= refine.zoomBudget) continue;
        tried.add(slot.si);
        const r = await zoomDetect(pipe, rows[slot.si], slot, frame, probe, refine, pipe._linkedCache.zoom);
        if (r.probed) zoomProbes += 1;
        const fresh = r.dets.filter((d) => !(zoomDets.get(slot.si) || []).includes(d));
        if (!fresh.length) continue;
        zoomDets.set(slot.si, [...(zoomDets.get(slot.si) || []), ...fresh]);
        added += fresh.length;
      }
      if (!added) break;
      zoomAdded += added;
      const nextRows = samples.map((row, si) => (zoomDets.has(si) ? { ...row, dets: [...row.dets, ...zoomDets.get(si)] } : row));
      const nextBuilt = buildTracklets(nextRows, frame);
      const nextLink = linkOn(nextRows, nextBuilt);
      if (!nextLink.ok) break;
      rows = nextRows; built = nextBuilt; link = nextLink; zoomRelinks += 1;
    }
  }
  const zoomMs = performance.now() - z0;
  const trajectory = renderTrajectory(rows, link, mirror ? { startT: 0, endT: start - mirrorFrom } : { startT: start, endT: end });
  /* 대상 곁의 다른 사람(편집기 재획득 게이트·연구실 검수용). */
  for (const p of trajectory) {
    let si = 0;
    while (si + 1 < rows.length && rows[si + 1].t <= p.t + 1e-6) si += 1;
    if (p.state === 'TARGET_LOST') continue;
    const near = built.perSample[si]
      .map((r) => r.obs.box)
      .filter((b) => iou(b, p.box) < 0.5 && Math.hypot(b.x + b.width / 2 - (p.box.x + p.box.width / 2), b.y + b.height / 2 - (p.box.y + p.box.height / 2)) < 2 * p.box.height);
    if (near.length) p.nearbyBoxes = near.slice(0, 4);
  }
  if (mirror) {
    unmirrorTrajectory(trajectory, start);
    for (const d of link.decisions) if (Number.isFinite(d.at)) d.at = start - d.at;
  }
  const stoppedForAsk = link.ask ? {
    t: link.ask.t,
    reason: link.ask.reason,
    lastBox: link.ask.lastBox,
    proposal: link.ask.proposal?.box ? { t: link.ask.proposal.t, box: link.ask.proposal.box } : null,
  } : null;
  const seconds = (performance.now() - began) / 1000;
  const lost = trajectory.filter((p) => p.state === 'TARGET_LOST').length;
  const result = {
    meta: m,
    engine: LINKED_ENGINE,
    trajectory,
    reviews: [], events: [], causes: {},
    doubtSpans: [],
    uncertainAt: [],
    verified: true,
    detector: 'mediapipe-efficientdet-lite0',
    autoRecovery: 'linked-reentry',
    stoppedForAsk,
    linkDecisions: link.decisions,
    metrics: {
      engine: LINKED_ENGINE,
      frames: trajectory.length,
      analysisSeconds: seconds,
      analysisFps: trajectory.length / Math.max(1e-3, seconds),
      chosenAnalysisFps: LINKED_POLICY.outFps,
      samples: samples.length,
      sampleHz: LINKED_POLICY.sampleHz,
      detectCalls, detectFailed,
      tracklets: built.tracks.length,
      reentries: link.decisions.filter((d) => d.kind === 'reentry').length,
      swaps: link.decisions.filter((d) => d.kind === 'swap').length,
      fgMasks, fgSeconds: fgMs / 1000, zoomProbes, zoomAdded, zoomRelinks, zoomSeconds: zoomMs / 1000,
      cueAdapted: link.cues?.adapted === true,
      screenTracks: link.screenTracks ?? 0,
      lostFrames: lost,
      unverifiedFrames: 0,
      trackedStart: mirror ? mirrorFrom : start,
      trackedEnd: trajectory.at(-1)?.t ?? start,
      healthMean: trajectory.reduce((s, p) => s + p.health, 0) / Math.max(1, trajectory.length),
      seedOverlap: link.seedOverlap,
    },
    limits: { cameraMotionCompensation: true, learnedReid: false },
  };
  if (options.debugDump === true) {
    const det = (d) => ({ x: d.x, y: d.y, width: d.width, height: d.height, score: d.score, ...(d.zoom ? { zoom: true } : {}), desc: serializeDesc(d.desc), descBg: d.descBg ? { values: Array.from(d.descBg.values), samples: d.descBg.samples, trust: d.descBg.trust } : null });
    result.debugSamples = samples.map((s) => ({ t: s.t, dets: s.dets.map(det) }));
    result.debugZoom = [...zoomDets].map(([si, dets]) => ({ t: samples[si].t, dets: dets.map(det) }));
    result.debugSeedDescs = seedDescs.map(serializeDesc);
    result.debugCues = link.cues;
  }
  return result;
}
