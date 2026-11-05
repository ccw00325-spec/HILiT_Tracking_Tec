/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·3c7f1894 @license @preserve */
/* crop 상대 위치 부위. 해부학 정렬이 아니다.

박스를 세로로 나눈 영역을 머리·몸통·다리 검출이라고 부르지 않는다.
crop 이 화면 안에 있다고 세 부위가 모두 visible 인 것은 아니다.
다른 상자와의 겹침은 가림 위험이지 정확한 마스크가 아니다.
*/

export type AlignmentLevel = 'region_proxy' | 'geometry_validated' | 'anatomically_aligned';
export type PartVisibility = 'visible' | 'occluded' | 'unknown';
export type PartName = 'head' | 'torso' | 'legs';

export const ALIGNMENT_LEVEL: AlignmentLevel = 'region_proxy';

export interface PartQuality {
  name: PartName;
  visibility: PartVisibility;
  pixelArea: number;
  sharpness: number;
  extremeShare: number;
  clippedShare: number;
  overlapRisk: number;
  alignConfidence: number;
  foregroundShare: number | null;
  score: number;
}

export interface RegionProxyObservation {
  alignment: AlignmentLevel;
  parts: [PartQuality, PartQuality, PartQuality];
  visibleMask: [boolean, boolean, boolean];
  minEvidenceMet: boolean;
  headOnly: boolean;
}

const NAMES: [PartName, PartName, PartName] = ['head', 'torso', 'legs'];
const SHARES = [0.25, 0.45, 0.30] as const;

export function clipShare(
  box: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): number {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(frame.width, box.x + box.width);
  const y1 = Math.min(frame.height, box.y + box.height);
  const vis = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = Math.max(1e-6, box.width * box.height);
  return Math.max(0, Math.min(1, 1 - vis / area));
}

export function partBoxes(
  box: { x: number; y: number; width: number; height: number },
): Array<{ x: number; y: number; width: number; height: number }> {
  const out = [];
  let y = box.y;
  for (let i = 0; i < 3; i += 1) {
    const h = i === 2 ? box.y + box.height - y : box.height * SHARES[i];
    out.push({ x: box.x, y, width: box.width, height: h });
    y += h;
  }
  return out;
}

export function scoreRegionProxy(input: {
  box: { x: number; y: number; width: number; height: number };
  frame: { width: number; height: number };
  sharpness?: [number, number, number];
  extremeShare?: [number, number, number];
  overlapRisk?: number;
  foregroundShare?: [number | null, number | null, number | null];
}): RegionProxyObservation {
  const parts = partBoxes(input.box);
  const overlap = Math.max(0, Math.min(1, input.overlapRisk ?? 0));
  const qualities: PartQuality[] = parts.map((p, i) => {
    const clipped = clipShare(p, input.frame);
    const sharp = Math.max(0, Math.min(1, input.sharpness?.[i] ?? 0.5));
    const extreme = Math.max(0, Math.min(1, input.extremeShare?.[i] ?? 0));
    const fg = input.foregroundShare?.[i] ?? null;
    const pixelArea = Math.max(0, p.width * p.height);
    let visibility: PartVisibility = 'unknown';
    if (clipped >= 0.55 || pixelArea < 24) visibility = 'unknown';
    else if (overlap >= 0.45) visibility = 'occluded';
    else if (clipped < 0.2 && pixelArea >= 40) visibility = 'visible';
    const alignConfidence = 0.35;
    const fgPenalty = fg == null ? 0.12 : Math.max(0, 0.35 - fg);
    const score = Math.max(0, Math.min(1,
      0.28 * (1 - clipped)
      + 0.22 * sharp
      + 0.18 * (1 - extreme)
      + 0.16 * (1 - overlap)
      + 0.16 * alignConfidence
      - fgPenalty));
    return {
      name: NAMES[i],
      visibility,
      pixelArea,
      sharpness: sharp,
      extremeShare: extreme,
      clippedShare: clipped,
      overlapRisk: overlap,
      alignConfidence,
      foregroundShare: fg,
      score,
    };
  });
  const visibleMask: [boolean, boolean, boolean] = [
    qualities[0].visibility === 'visible',
    qualities[1].visibility === 'visible',
    qualities[2].visibility === 'visible',
  ];
  const visibleCount = visibleMask.filter(Boolean).length;
  return {
    alignment: 'region_proxy',
    parts: [qualities[0], qualities[1], qualities[2]],
    visibleMask,
    minEvidenceMet: visibleCount >= 2,
    headOnly: visibleMask[0] && !visibleMask[1] && !visibleMask[2],
  };
}

export function poseUncertainHold(input: {
  sizeRatio?: number | null;
  regionShift?: number | null;
}): boolean {
  if (input.sizeRatio != null && input.sizeRatio > 1.85) return true;
  if (input.regionShift != null && input.regionShift > 0.45) return true;
  return false;
}
