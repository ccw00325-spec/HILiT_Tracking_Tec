/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b69db16c @license @preserve */
/* 합성 탐지·마스크. 검출기 수율이 아니라 생성기 가시 마스크에서 만든다.

제품에는 segmentation 이 없다. 여기서 만드는 마스크는 "마스크가 주어진다면"
을 가정한 오프라인 자료이고, 열화(경계 잡음·일부 누락·병합·축소 해상도)는
요청서 18장의 합성 변형을 따른다. 합성 결과는 실사와 섞어 보고하지 않는다.
*/

import type { ContourMaskInput } from '../contour-feature';
import { SIM_H, SIM_W, hashSeed, makeRng, type SimClip, type SimFrame } from './scene';

export interface SimDetection {
  /** 프레임 안 탐지 번호 */
  index: number;
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  /** 평가 전용 정답. 추적 로직은 읽지 않는다. */
  truthId: number;
  /** 병합된 탐지면 섞인 id 들 (평가 전용) */
  truthIds: number[];
  /** 마스크(격자). 없으면 null */
  mask: ContourMaskInput | null;
}

export interface DetectionOptions {
  maskScale: 1 | 0.5 | 0.25;
  /** 경계 잡음 확률 */
  boundaryNoise?: number;
}

function buildMask(frame: SimFrame, ids: number[], box: { x: number; y: number; width: number; height: number },
  scale: 1 | 0.5 | 0.25, rngSeed: number, opts: { missingPart: boolean; noise: number; blur: number }): ContourMaskInput {
  const step = 1 / scale;
  const pad = 3 * step;
  const fx0 = Math.max(0, Math.floor(box.x - pad));
  const fy0 = Math.max(0, Math.floor(box.y - pad));
  const fx1 = Math.min(SIM_W, Math.ceil(box.x + box.width + pad));
  const fy1 = Math.min(SIM_H, Math.ceil(box.y + box.height + pad));
  const w = Math.max(3, Math.ceil((fx1 - fx0) / step));
  const h = Math.max(3, Math.ceil((fy1 - fy0) / step));
  const data = new Uint8Array(w * h);
  const other = new Uint8Array(w * h);
  const occl = new Uint8Array(w * h);
  const idSet = new Set(ids);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // 셀 안 화소 다수결
      let mine = 0;
      let oth = 0;
      let oc = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy += 1) {
        const yy = Math.floor(fy0 + y * step + dy);
        if (yy >= SIM_H) continue;
        for (let dx = 0; dx < step; dx += 1) {
          const xx = Math.floor(fx0 + x * step + dx);
          if (xx >= SIM_W) continue;
          const l = frame.label[yy * SIM_W + xx];
          n += 1;
          if (l >= 0 && idSet.has(l)) mine += 1;
          else if (l >= 0) oth += 1;
          if (frame.occluder[yy * SIM_W + xx]) oc += 1;
        }
      }
      if (n === 0) continue;
      data[y * w + x] = mine * 2 >= n ? 1 : 0;
      other[y * w + x] = oth * 2 >= n ? 1 : 0;
      occl[y * w + x] = oc * 2 >= n ? 1 : 0;
    }
  }
  const rng = makeRng(rngSeed);
  // 경계 잡음: 경계 화소를 뒤집는다 (흐림이 크면 더 많이)
  const noise = opts.noise + opts.blur * 0.25;
  if (noise > 0) {
    const flip: number[] = [];
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const v = data[i];
        const edge = data[i - 1] !== v || data[i + 1] !== v || data[i - w] !== v || data[i + w] !== v;
        if (edge && rng.next() < noise) flip.push(i);
      }
    }
    for (const i of flip) data[i] = data[i] ? 0 : 1;
  }
  if (opts.missingPart) {
    // 몸 일부(팔·다리 쪽 사각형)를 지운다
    const rw = Math.max(2, Math.round(w * 0.45));
    const rh = Math.max(2, Math.round(h * 0.3));
    const rx = rng.int(0, Math.max(0, w - rw));
    const ry = Math.round(h * (rng.next() < 0.5 ? 0.55 : 0.3));
    for (let y = ry; y < Math.min(h, ry + rh); y += 1) {
      for (let x = rx; x < Math.min(w, rx + rw); x += 1) data[y * w + x] = 0;
    }
  }
  return {
    width: w,
    height: h,
    data,
    frameX: fx0,
    frameY: fy0,
    scale: step,
    frameWidth: SIM_W,
    frameHeight: SIM_H,
    otherMask: other,
    occluderMask: occl,
    segConfidence: Math.max(0.2, 0.9 - noise * 1.5 - (opts.missingPart ? 0.25 : 0) - opts.blur * 0.3),
  };
}

function iou(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.width * a.height + b.width * b.height - inter;
  return u > 0 ? inter / u : 0;
}

export function boxIoU(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  return iou(a, b);
}

/** 프레임 하나의 탐지 목록. 결정적이다. */
export function detectFrame(clip: SimClip, frame: SimFrame, opts: DetectionOptions): SimDetection[] {
  const sc = clip.spec.scenario;
  const rng = makeRng(hashSeed('det', sc, clip.spec.sport, clip.spec.seed, frame.index));
  const out: SimDetection[] = [];
  const used = new Set<number>();
  const visible = frame.gt.filter((g) => g.visibleBox && g.visiblePixels >= 25);
  // 병합: 붙어 있는 두 사람이 한 탐지·한 마스크로
  if (sc === 'mask-merge') {
    for (const a of visible) {
      for (const b of visible) {
        if (a.id >= b.id || used.has(a.id) || used.has(b.id)) continue;
        if (iou(a.visibleBox!, b.visibleBox!) < 0.12) continue;
        if (rng.next() > 0.6) continue;
        const x0 = Math.min(a.visibleBox!.x, b.visibleBox!.x);
        const y0 = Math.min(a.visibleBox!.y, b.visibleBox!.y);
        const x1 = Math.max(a.visibleBox!.x + a.visibleBox!.width, b.visibleBox!.x + b.visibleBox!.width);
        const y1 = Math.max(a.visibleBox!.y + a.visibleBox!.height, b.visibleBox!.y + b.visibleBox!.height);
        const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const main = a.visiblePixels >= b.visiblePixels ? a.id : b.id;
        used.add(a.id);
        used.add(b.id);
        out.push({
          index: out.length,
          box,
          confidence: 0.55 + rng.next() * 0.2,
          truthId: main,
          truthIds: [a.id, b.id],
          mask: buildMask(frame, [a.id, b.id], box, opts.maskScale, hashSeed('m', sc, frame.index, a.id, b.id, clip.spec.seed),
            { missingPart: false, noise: opts.boundaryNoise ?? 0.04, blur: frame.blur }),
        });
      }
    }
  }
  for (const g of visible) {
    if (used.has(g.id)) continue;
    const small = g.visibleBox!.height < 30;
    const miss = 0.04 + (small ? 0.08 : 0) + frame.blur * 0.1 + (1 - g.visibleRatio) * 0.15;
    if (rng.next() < miss) continue;
    const vb = g.visibleBox!;
    const j = 0.03 * vb.height;
    const box = {
      x: vb.x + rng.normal() * j,
      y: vb.y + rng.normal() * j,
      width: Math.max(4, vb.width * (1 + rng.normal() * 0.04)),
      height: Math.max(6, vb.height * (1 + rng.normal() * 0.04)),
    };
    const missingPart = sc === 'mask-missing-part' && g.id === clip.targetId && rng.next() < 0.5;
    const noise = (opts.boundaryNoise ?? 0.04) + (sc === 'low-quality' || sc === 'compression' ? 0.08 : 0);
    out.push({
      index: out.length,
      box,
      confidence: Math.max(0.2, Math.min(0.98, 0.55 + 0.4 * g.visibleRatio - (small ? 0.15 : 0) - frame.blur * 0.2 + rng.normal() * 0.05)),
      truthId: g.id,
      truthIds: [g.id],
      mask: buildMask(frame, [g.id], box, opts.maskScale, hashSeed('m', sc, frame.index, g.id, clip.spec.seed),
        { missingPart, noise, blur: frame.blur }),
    });
  }
  return out;
}
