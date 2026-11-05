/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·3c119850 @license @preserve */
/* 브라우저 어댑터. 정본은 packages/hilit-vision/src/motion-tracker.ts
 * 코어는 generated/motion-tracker.js 로 빌드한다. 이 파일은 캔버스만 잇는다.
 */
export {
  HilitMotionTrackerCore,
  rgbaToGray,
  applyMotion,
  motionQuality,
  estimateMotion,
  preferInnerPairs,
  sadCoarseRange,
  SIZE_MIN_RATIO,
  SIZE_MAX_RATIO,
  SIZE_UPDATE_MIN_QUALITY,
  SAD_COARSE_RANGE,
} from './generated/motion-tracker.js';
import { HilitMotionTrackerCore, rgbaToGray } from './generated/motion-tracker.js';

function canvasGray(ctx) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const id = ctx.getImageData(0, 0, w, h);
  return rgbaToGray(id.data, w, h);
}

function roundBox(box) {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

/** 파이프라인이 부르는 브라우저 어댑터. ONNX 세션이 없다. */
export class HilitMotionTracker {
  constructor() {
    this.core = new HilitMotionTrackerCore();
  }

  get w0() { return this.core.w0; }
  set w0(v) { this.core.w0 = v; }
  get h0() { return this.core.h0; }
  set h0(v) { this.core.h0 = v; }

  static async load() {
    return new HilitMotionTracker();
  }

  async init(ctx, box, timeSec = null) {
    this.core.init(canvasGray(ctx), {
      x: box.x, y: box.y,
      width: box.width ?? box.w,
      height: box.height ?? box.h,
    }, timeSec);
  }

  async update(ctx, timeSec = null) {
    const r = this.core.update(canvasGray(ctx), timeSec);
    return {
      box: roundBox(r.box),
      confidence: r.confidence,
      status: r.status,
      observed: r.observed,
      pointsUsed: r.pointsUsed,
      pointsKept: r.pointsKept,
      fbError: r.fbError,
      scaleEvidence: r.scaleEvidence,
      reason: r.reason,
      frameTimestamp: r.frameTimestamp,
      referenceTimestamp: r.referenceTimestamp,
    };
  }

  async refreshTemplate(ctx, box, timeSec = null) {
    const next = {
      x: box.x ?? this.core.current()?.x ?? 0,
      y: box.y ?? this.core.current()?.y ?? 0,
      width: box.width ?? this.core.current()?.width ?? this.w0,
      height: box.height ?? this.core.current()?.height ?? this.h0,
    };
    this.core.reposition(next, { trustSize: true });
    this.core.adoptFrame(canvasGray(ctx), timeSec);
  }

  reset() {
    this.core.reset();
  }

  reposition(box, opts = {}) {
    this.core.reposition({
      x: box.x, y: box.y,
      width: box.width ?? box.w,
      height: box.height ?? box.h,
    }, opts);
  }
}
