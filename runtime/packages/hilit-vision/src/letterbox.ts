/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·0e590b8c @license @preserve */
/* 검출 입력 크기 맞추기와 원본 좌표 복원.

지금 제품 격자는 64×96으로 **늘여 넣는다**(종횡비를 버린다).
letterbox는 검은 여백을 넣어 비율을 지킨다. 두 방식을 한 숫자로 섞지 않는다.
검출 점수는 여기서 만들지 않는다.
*/

export type PreprocessMode = 'stretch' | 'letterbox';

export interface PreprocessMeta {
  mode: PreprocessMode;
  sourceWidth: number;
  sourceHeight: number;
  analysisWidth: number;
  analysisHeight: number;
  padX: number;
  padY: number;
  contentWidth: number;
  contentHeight: number;
  scale: number;
}

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function planPreprocess(
  sourceWidth: number,
  sourceHeight: number,
  analysisWidth: number,
  analysisHeight: number,
  mode: PreprocessMode,
): PreprocessMeta {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(analysisWidth > 0) || !(analysisHeight > 0)) {
    throw new Error('bad-preprocess-size');
  }
  if (mode === 'stretch') {
    return {
      mode,
      sourceWidth,
      sourceHeight,
      analysisWidth,
      analysisHeight,
      padX: 0,
      padY: 0,
      contentWidth: analysisWidth,
      contentHeight: analysisHeight,
      scale: analysisWidth / sourceWidth,
    };
  }
  const scale = Math.min(analysisWidth / sourceWidth, analysisHeight / sourceHeight);
  const contentWidth = Math.max(1, Math.round(sourceWidth * scale));
  const contentHeight = Math.max(1, Math.round(sourceHeight * scale));
  const padX = Math.floor((analysisWidth - contentWidth) / 2);
  const padY = Math.floor((analysisHeight - contentHeight) / 2);
  return {
    mode,
    sourceWidth,
    sourceHeight,
    analysisWidth,
    analysisHeight,
    padX,
    padY,
    contentWidth,
    contentHeight,
    scale,
  };
}

export function restorePoint(point: { x: number; y: number }, meta: PreprocessMeta): { x: number; y: number } {
  if (meta.mode === 'stretch') {
    return {
      x: point.x * (meta.sourceWidth / meta.analysisWidth),
      y: point.y * (meta.sourceHeight / meta.analysisHeight),
    };
  }
  return {
    x: (point.x - meta.padX) / meta.scale,
    y: (point.y - meta.padY) / meta.scale,
  };
}

export function restoreBox(box: PixelBox, meta: PreprocessMeta): PixelBox {
  const origin = restorePoint({ x: box.x, y: box.y }, meta);
  if (meta.mode === 'stretch') {
    return {
      x: origin.x,
      y: origin.y,
      width: box.width * (meta.sourceWidth / meta.analysisWidth),
      height: box.height * (meta.sourceHeight / meta.analysisHeight),
    };
  }
  return {
    x: origin.x,
    y: origin.y,
    width: box.width / meta.scale,
    height: box.height / meta.scale,
  };
}

export function clampBox(box: PixelBox, width: number, height: number): PixelBox | null {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null;
  if (!(box.width > 2) || !(box.height > 2)) return null;
  const x1 = Math.max(0, Math.min(width, box.x));
  const y1 = Math.max(0, Math.min(height, box.y));
  const x2 = Math.max(0, Math.min(width, box.x + box.width));
  const y2 = Math.max(0, Math.min(height, box.y + box.height));
  const w = x2 - x1;
  const h = y2 - y1;
  if (!(w > 2) || !(h > 2)) return null;
  return { x: x1, y: y1, width: w, height: h };
}

export function filterRestoredBoxes(boxes: PixelBox[], width: number, height: number): PixelBox[] {
  const out: PixelBox[] = [];
  for (const box of boxes) {
    const clamped = clampBox(box, width, height);
    if (clamped) out.push(clamped);
  }
  return out;
}

/** 분석 화면에 RGBA를 그린다. stretch는 축마다 따로 샘플한다. letterbox 여백은 0. */
export function letterboxRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  meta: PreprocessMeta,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(meta.analysisWidth * meta.analysisHeight * 4);
  if (meta.mode === 'stretch') {
    for (let y = 0; y < meta.analysisHeight; y += 1) {
      const sy = Math.min(meta.sourceHeight - 1, Math.floor((y + 0.5) * meta.sourceHeight / meta.analysisHeight));
      for (let x = 0; x < meta.analysisWidth; x += 1) {
        const sx = Math.min(meta.sourceWidth - 1, Math.floor((x + 0.5) * meta.sourceWidth / meta.analysisWidth));
        const si = (sy * meta.sourceWidth + sx) * 4;
        const di = (y * meta.analysisWidth + x) * 4;
        out[di] = rgba[si];
        out[di + 1] = rgba[si + 1];
        out[di + 2] = rgba[si + 2];
        out[di + 3] = 255;
      }
    }
    return out;
  }
  for (let y = 0; y < meta.contentHeight; y += 1) {
    const sy = Math.min(meta.sourceHeight - 1, Math.floor(y / meta.scale));
    for (let x = 0; x < meta.contentWidth; x += 1) {
      const sx = Math.min(meta.sourceWidth - 1, Math.floor(x / meta.scale));
      const si = (sy * meta.sourceWidth + sx) * 4;
      const di = ((y + meta.padY) * meta.analysisWidth + (x + meta.padX)) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}
