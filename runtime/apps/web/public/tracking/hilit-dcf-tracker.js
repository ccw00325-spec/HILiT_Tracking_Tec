/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·4711a3c5 @license @preserve */
/* 브라우저 어댑터. 정본은 packages/hilit-vision/src/dcf-tracker.ts
 * 코어는 generated/dcf-tracker.js 로 빌드한다(scripts/build-identity-runtime.mjs).
 * 이 파일은 캔버스만 잇는다. 모양은 hilit-motion-tracker.js 의
 * HilitMotionTracker 와 같다 — 파이프라인은 둘을 구분하지 않고 부른다.
 *
 * confidence 는 상관 응답 PSR 에서 온 위치 관측 품질이다. 동일인 확률이 아니다.
 */
export { HilitDcfTrackerCore, DCF_PARAMS } from './generated/dcf-tracker.js';
import { HilitDcfTrackerCore } from './generated/dcf-tracker.js';

/** 다음 update 가 볼 영역만 읽는다. 전체 프레임 getImageData 는 비싸다. */
function readRegion(ctx, rect) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const x = Math.max(0, Math.min(W - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(H - 1, Math.floor(rect.y)));
  const w = Math.max(1, Math.min(W - x, Math.ceil(rect.width)));
  const h = Math.max(1, Math.min(H - y, Math.ceil(rect.height)));
  const id = ctx.getImageData(x, y, w, h);
  return { data: id.data, width: w, height: h, ox: x, oy: y, frameWidth: W, frameHeight: H };
}

function normBox(box) {
  return {
    x: box.x,
    y: box.y,
    width: box.width ?? box.w,
    height: box.height ?? box.h,
  };
}

function roundBox(box) {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

/** 파이프라인이 부르는 브라우저 어댑터. 가중치·ONNX 가 없다. */
export class HilitDcfTracker {
  constructor(params = {}) {
    this.core = new HilitDcfTrackerCore(params);
    this.kind = 'dcf';
  }

  get w0() { return this.core.w0; }
  set w0(v) { this.core.w0 = v; }
  get h0() { return this.core.h0; }
  set h0(v) { this.core.h0 = v; }

  static async load(params = {}) {
    return new HilitDcfTracker(params);
  }

  async init(ctx, box, timeSec = null) {
    const b = normBox(box);
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    this.core.init(readRegion(ctx, this.core.searchRegion(W, H, b)), b, timeSec);
  }

  async update(ctx, timeSec = null, options = null) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const r = this.core.update(readRegion(ctx, this.core.searchRegion(W, H)), timeSec, options);
    return {
      box: roundBox(r.box),
      confidence: r.confidence,
      status: r.status,
      observed: r.observed,
      /* 점 추적기 필드와 모양을 맞춘다. 상관필터에는 점이 없다. */
      pointsUsed: null,
      pointsKept: null,
      fbError: null,
      scaleEvidence: r.scale,
      psr: r.psr,
      reason: r.reason,
      frameTimestamp: r.frameTimestamp,
      referenceTimestamp: r.referenceTimestamp,
    };
  }

  async refreshTemplate(ctx, box, timeSec = null) {
    const cur = this.core.current();
    const b = {
      x: box.x ?? cur?.x ?? 0,
      y: box.y ?? cur?.y ?? 0,
      width: box.width ?? cur?.width ?? this.w0,
      height: box.height ?? cur?.height ?? this.h0,
    };
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    this.core.refresh(readRegion(ctx, this.core.searchRegion(W, H, b)), b, timeSec);
  }

  reset() {
    this.core.reset();
  }

  reposition(box, opts = {}) {
    this.core.reposition(normBox(box), opts);
  }
}
