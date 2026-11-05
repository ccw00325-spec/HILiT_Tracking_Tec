/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·245ef29a @license @preserve */
/* 카메라 이동 보정.
 *
 * PoC 의 mobile/vision/camera_motion.py 를 브라우저로 옮긴 것이다.
 * 지금까지 브라우저 경로에는 이게 빠져 있었고, 그래서 "처음에는 잘 잡는데
 * 후반에 놓치는" 증상이 났다.
 *
 * 왜 필요한가
 * ----------
 * 카메라가 움직이면 화면 안의 모든 것이 함께 움직인다. 대상은 가만히
 * 있는데도 "갑자기 크게 이동했다" 로 읽혀 Health 의 motion 신호가 떨어지고,
 * bad frame 이 쌓여 LOST 로 넘어간다. 경기 후반에 카메라를 따라 돌리는
 * 구간이 많을수록 이 오판이 누적된다.
 *
 * PoC 벤치마크에서 이 보정이 있는 경우 카메라 Pan 케이스의 서버 호출이
 * 0회였다. 보정이 없으면 Pan 을 사람의 이상 이동으로 읽는다.
 *
 * 구현
 * ----
 * 파이썬은 sparse Lucas-Kanade 광류를 썼다. 브라우저에서 그걸 그대로
 * 옮기면 무겁고 OpenCV.js(8MB) 를 끌고 와야 한다. 대신 아주 작은
 * 흑백 축소본에서 **전역 평행이동만** 블록 매칭으로 찾는다.
 *
 *   40x24 로 축소 -> ±5 픽셀 범위에서 SAD 최소 이동량
 *   121개 후보 x 960 픽셀 = 12만 회 -> 1ms 미만
 *
 * 평행이동 SAD는 그대로 두고, 배경이 충분하면 자체 아핀 GMC를 먼저 쓴다.
 * 회전·줌이 있는 핸드헬드에서 옆 사람 자리와 IoU가 생기는 것을 줄인다.
 * OpenCV는 가져오지 않는다.
 */

import { estimateAffineGmc, assessGmcEvidence } from './affine-gmc.js';

const W = 40;
const H = 24;
const RANGE = 5;          // 축소본 기준 탐색 반경
const MIN_CONFIDENCE = 0.12;

export class CameraMotion {
  constructor() {
    this.prev = null;
    this.mask = null;
    this.scratch = document.createElement('canvas');
    this.scratch.width = W; this.scratch.height = H;
    this.ctx = this.scratch.getContext('2d', { willReadFrequently: true });
    this.dx = 0; this.dy = 0; this.confidence = 0;
    this.affine = null;
    this.scale = 1;
    this.rotationRad = 0;
    this.scratchGmc = document.createElement('canvas');
    this.scratchGmc.width = 80; this.scratchGmc.height = 48;
    this.ctxGmc = this.scratchGmc.getContext('2d', { willReadFrequently: true });
    this.prevGmc = null;
  }

  /** 현재 프레임을 넣고 직전 프레임 대비 카메라 이동량을 얻는다.
   *  반환값은 **원본 프레임 픽셀 단위** 다.
   *  excludeBox 가 있으면 그 칸은 배경으로 쓰지 않는다. */
  update(sourceCanvas, excludeBox) {
    const gray = this._gray(sourceCanvas);
    const mask = this._mask(sourceCanvas, excludeBox);
    const gmcGray = this._grayGmc(sourceCanvas);
    if (!this.prev) {
      this.prev = gray;
      this.mask = mask;
      this.prevGmc = gmcGray;
      this.dx = 0; this.dy = 0; this.confidence = 0;
      this.affine = null; this.scale = 1; this.rotationRad = 0;
      return { dx: 0, dy: 0, confidence: 0, usable: false, status: 'first_frame', affine: null, scale: 1, rotationRad: 0, comparedCells: null, backgroundShare: 1 };
    }
    const exclude = excludeBox ? [excludeBox] : [];
    const gmc = estimateAffineGmc({
      prevGray: this.prevGmc,
      nextGray: gmcGray,
      width: 80,
      height: 48,
      excludeBoxes: exclude.map((b) => ({
        x: (b.x / sourceCanvas.width) * 80,
        y: (b.y / sourceCanvas.height) * 48,
        width: (b.width / sourceCanvas.width) * 80,
        height: (b.height / sourceCanvas.height) * 48,
      })),
    });
    this.prevGmc = gmcGray;
    /* 잔차가 작다는 것만으로 아핀을 쓰지 않는다. 틀린 대응들도 서로 일관된
       움직임을 만든다 — 그때 잘못된 아핀을 적용하면 상자가 옆 사람 자리로
       밀린다. 근거가 모자라면 아래 평행이동 경로로 내려간다(예전에도
       usable=false 면 그 길이었다). */
    const gmcEvidence = assessGmcEvidence(gmc);
    if (gmc.usable && gmcEvidence.evidenceOk) {
      const sx = sourceCanvas.width / 80;
      const sy = sourceCanvas.height / 48;
      const affine = {
        a: gmc.affine.a,
        b: gmc.affine.b * (sx / sy),
        tx: gmc.affine.tx * sx,
        c: gmc.affine.c * (sy / sx),
        d: gmc.affine.d,
        ty: gmc.affine.ty * sy,
      };
      this.affine = affine;
      this.dx = gmc.dxPx * sx;
      this.dy = gmc.dyPx * sy;
      this.scale = gmc.scale;
      this.rotationRad = gmc.rotationRad;
      this.confidence = gmc.quality;
      this.prev = gray;
      return {
        dx: this.dx, dy: this.dy, confidence: this.confidence, usable: true,
        status: 'ok', affine, scale: gmc.scale, rotationRad: gmc.rotationRad, method: gmc.method,
        comparedCells: null, backgroundShare: 0.5,
      };
    }

    let bg = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) bg++;
    const share = bg / mask.length;
    if (excludeBox && share < 0.45) {
      this.prev = gray;
      this.mask = mask;
      this.dx = 0; this.dy = 0; this.confidence = 0;
      this.affine = null;
      return { dx: 0, dy: 0, confidence: 0, usable: false, status: 'person_fills', affine: null, scale: 1, rotationRad: 0, backgroundShare: share, comparedCells: 0 };
    }

    let bestX = 0, bestY = 0, best = Infinity, baseline = 0, bestN = 0;
    for (let oy = -RANGE; oy <= RANGE; oy++) {
      for (let ox = -RANGE; ox <= RANGE; ox++) {
        let sum = 0, n = 0;
        // 가장자리는 건너뛴다. 이동으로 새로 들어온 화소라 비교 의미가 없다.
        for (let y = RANGE; y < H - RANGE; y += 1) {
          const row = y * W;
          const srow = (y + oy) * W;
          for (let x = RANGE; x < W - RANGE; x += 1) {
            const i = row + x;
            const j = srow + x + ox;
            if (mask[i] === 0 || mask[j] === 0) continue;
            sum += Math.abs(gray[j] - this.prev[i]);
            n++;
          }
        }
        const mean = sum / Math.max(n, 1);
        if (ox === 0 && oy === 0) baseline = mean;
        if (mean < best) { best = mean; bestX = ox; bestY = oy; bestN = n; }
      }
    }

    /* 신뢰도: 정지 상태 대비 얼마나 나아졌는가.
     * 화면이 평평하거나(벽만 보임) 노이즈뿐이면 어떤 이동도 개선이 없다.
     * 그럴 때 억지로 보정하면 오히려 궤적을 흔든다. */
    const gain = baseline > 1e-6 ? (baseline - best) / baseline : 0;
    this.confidence = Math.max(0, Math.min(1, gain));
    this.prev = gray;

    if (bestN < 40) {
      this.dx = 0; this.dy = 0;
      this.affine = null;
      return {
        dx: 0, dy: 0, confidence: this.confidence, usable: false, status: 'low_texture',
        affine: null, scale: 1, rotationRad: 0, backgroundShare: share, comparedCells: bestN,
      };
    }

    if (this.confidence < MIN_CONFIDENCE) {
      this.dx = 0; this.dy = 0;
      this.affine = null;
      return {
        dx: 0, dy: 0, confidence: this.confidence, usable: true, status: 'ok', affine: null,
        scale: 1, rotationRad: 0, backgroundShare: share, comparedCells: bestN,
      };
    }

    // 축소본 좌표를 원본 좌표로 되돌린다.
    this.dx = bestX * (sourceCanvas.width / W);
    this.dy = bestY * (sourceCanvas.height / H);
    this.affine = { a: 1, b: 0, tx: this.dx, c: 0, d: 1, ty: this.dy };
    this.scale = 1;
    this.rotationRad = 0;
    return {
      dx: this.dx, dy: this.dy, confidence: this.confidence, usable: true, status: 'ok',
      affine: this.affine, scale: 1, rotationRad: 0, backgroundShare: share, comparedCells: bestN,
    };
  }

  reset() {
    this.prev = null; this.mask = null; this.prevGmc = null;
    this.dx = 0; this.dy = 0; this.confidence = 0;
    this.affine = null; this.scale = 1; this.rotationRad = 0;
  }

  _grayGmc(sourceCanvas) {
    this.ctxGmc.drawImage(sourceCanvas, 0, 0, 80, 48);
    const px = this.ctxGmc.getImageData(0, 0, 80, 48).data;
    const out = new Uint8Array(80 * 48);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = (px[p] * 77 + px[p + 1] * 150 + px[p + 2] * 29) >> 8;
    }
    return out;
  }

  _mask(sourceCanvas, excludeBox) {
    const out = new Uint8Array(W * H);
    out.fill(1);
    if (!excludeBox) return out;
    const x0 = Math.max(0, Math.floor((excludeBox.x / sourceCanvas.width) * W));
    const y0 = Math.max(0, Math.floor((excludeBox.y / sourceCanvas.height) * H));
    const x1 = Math.min(W, Math.ceil(((excludeBox.x + excludeBox.width) / sourceCanvas.width) * W));
    const y1 = Math.min(H, Math.ceil(((excludeBox.y + excludeBox.height) / sourceCanvas.height) * H));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) out[y * W + x] = 0;
    }
    return out;
  }

  _gray(sourceCanvas) {
    this.ctx.drawImage(sourceCanvas, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      // 정수 근사 휘도. 부동소수 곱보다 빠르고 정확도는 충분하다.
      out[i] = (px[p] * 77 + px[p + 1] * 150 + px[p + 2] * 29) >> 8;
    }
    return out;
  }
}
