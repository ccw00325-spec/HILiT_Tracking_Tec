/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·ae742381 @license @preserve */
/* UI 상자 → 분석 해상도. 저장 성공만으로 엔진 입력을 완료로 두지 않는다.

정규화(0~1) · 원본 화소 · 분석 캔버스 · 회전을 한 곳에서 바꾼다.
*/

import { planPreprocess, restoreBox, type PreprocessMode } from './letterbox';

export interface ConfirmedSubjectView {
  id: string;
  time: number;
  view: 'front' | 'left' | 'right' | 'back' | 'unknown';
  box: { x: number; y: number; width: number; height: number };
  userConfirmed: true;
  space: 'normalized-source' | 'analysis-pixels' | 'source-pixels';
}

export function normalizedToAnalysis(
  box: { x: number; y: number; width: number; height: number },
  analysis: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const x = box.x * analysis.width;
  const y = box.y * analysis.height;
  const width = box.width * analysis.width;
  const height = box.height * analysis.height;
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { x, y, width, height };
}

export function analysisToNormalized(
  box: { x: number; y: number; width: number; height: number },
  analysis: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  if (!(analysis.width > 0) || !(analysis.height > 0)) return null;
  const out = {
    x: box.x / analysis.width,
    y: box.y / analysis.height,
    width: box.width / analysis.width,
    height: box.height / analysis.height,
  };
  if (![out.x, out.y, out.width, out.height].every(Number.isFinite)) return null;
  return out;
}

export function rotateNormalized(
  box: { x: number; y: number; width: number; height: number },
  rotation: 0 | 90 | 180 | 270,
): { x: number; y: number; width: number; height: number } {
  if (rotation === 0) return { ...box };
  if (rotation === 180) {
    return { x: 1 - box.x - box.width, y: 1 - box.y - box.height, width: box.width, height: box.height };
  }
  if (rotation === 90) {
    return { x: box.y, y: 1 - box.x - box.width, width: box.height, height: box.width };
  }
  return { x: 1 - box.y - box.height, y: box.x, width: box.height, height: box.width };
}

export function confirmedViewsToPipeline(
  views: readonly ConfirmedSubjectView[],
  analysis: { width: number; height: number; duration: number },
): Array<{
  time: number;
  view: 'front' | 'side' | 'back' | 'unknown';
  box: { x: number; y: number; width: number; height: number };
  userConfirmed: true;
}> {
  const out = [];
  for (const view of views) {
    if (view.userConfirmed !== true) continue;
    if (!Number.isFinite(view.time) || view.time < 0 || view.time >= analysis.duration) continue;
    let norm = view.box;
    if (view.space === 'analysis-pixels') {
      const n = analysisToNormalized(view.box, analysis);
      if (!n) continue;
      norm = n;
    }
    if (view.space === 'source-pixels') continue;
    const box = normalizedToAnalysis(norm, analysis);
    if (!box) continue;
    const reidView: 'front' | 'side' | 'back' | 'unknown' =
      view.view === 'left' || view.view === 'right' ? 'side' : view.view;
    out.push({ time: view.time, view: reidView, box, userConfirmed: true as const });
  }
  return out;
}

export function letterboxRoundtrip(
  box: { x: number; y: number; width: number; height: number },
  source: { width: number; height: number },
  analysis: { width: number; height: number },
  mode: PreprocessMode,
): { x: number; y: number; width: number; height: number } {
  const meta = planPreprocess(source.width, source.height, analysis.width, analysis.height, mode);
  const scaled = {
    x: box.x * meta.scale + meta.padX,
    y: box.y * meta.scale + meta.padY,
    width: box.width * meta.scale,
    height: box.height * meta.scale,
  };
  return restoreBox(scaled, meta);
}
