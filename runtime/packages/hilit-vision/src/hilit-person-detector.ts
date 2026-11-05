/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·9a2c693c @license @preserve */
/* 브라우저·노드에서 쓰는 사람 후보 공급기.

격자 합성곱(합성 막대로 학습)과 세로 에너지 창을 함께 돌릴 수 있다.
둘 다 후보만 낸다. 동일인 판정은 하지 않는다.

기본 경로는 프레임 전체를 64×96 으로 줄인다. 조각·영역 확대는
평가와 진단에서만 켠다. 자동 복구 기본값이 되지는 않는다.
*/
import {
  GRID_IN_H, GRID_IN_W, MODEL_ID, MODEL_VERSION, QUALITY_STATUS,
  decodeBoxes, forwardLogits, nms, rgbFromRgba, type GridWeights,
} from './hilit-grid-net';
import { STAND_MODEL_ID, STAND_MODEL_VERSION, proposeStandEnergy } from './hilit-stand-energy';
import { isClipped, planSlices, type Rect } from './tiling';
import { DETECTOR_SCORE_MIN } from './detector-thresholds';

export type DetectorRunOutcome = 'ok' | 'empty' | 'unavailable' | 'error';

export interface DetectorProposal {
  candidateId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  detectorScore: number;
  source: 'hilit-grid' | 'stand-energy' | 'hog-window';
}

export interface DetectorRun {
  outcome: DetectorRunOutcome;
  availability: 'ready' | 'unavailable' | 'error';
  modelId: string | null;
  modelVersion: string | null;
  qualityStatus: 'pipeline-check' | 'heuristic-only' | 'unavailable';
  proposals: DetectorProposal[];
  reason: string | null;
  elapsedMs: number;
  analysisWidth: number;
  analysisHeight: number;
  frameWidth: number;
  frameHeight: number;
  timestamp: number;
  sliceCount?: number;
}

export interface ProposeOptions {
  sliced?: boolean;
  /** 연구용(기본 꺼짐): 조각을 합칠 때 더 큰 상자 안에 이 비율 이상 들어간 작은 상자를 지운다(예: 0.8). 제품은 쓰지 않는다. */
  crossTileContainment?: number | null;
  forceSlice?: boolean;
  focus?: Rect | null;
  subjectHeight?: number | null;
  maxSlices?: number;
  /** 이 사각형만 64×96 으로 본다. 위치를 아는 보조 경로. 전수 검출이 아니다. */
  region?: Rect | null;
  sources?: 'all' | 'grid' | 'stand';
  /** 이 호출의 점수 문턱. 쓰임새별 값은 detector-thresholds.ts 참조. */
  scoreMin?: number;
  signal?: AbortSignal;
}

export function cropRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  region: Rect,
): { rgba: Uint8ClampedArray; width: number; height: number; originX: number; originY: number } {
  const originX = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const originY = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const cropW = Math.max(1, Math.min(width - originX, Math.floor(region.width)));
  const cropH = Math.max(1, Math.min(height - originY, Math.floor(region.height)));
  const out = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    const src = ((originY + y) * width + originX) * 4;
    out.set(rgba.subarray(src, src + cropW * 4), y * cropW * 4);
  }
  return { rgba: out, width: cropW, height: cropH, originX, originY };
}

export class HilitPersonDetector {
  readonly weights: GridWeights | null;
  readonly reason: string | null;

  constructor(weights: GridWeights | null, reason: string | null = null) {
    this.weights = weights;
    this.reason = reason;
  }

  static fromWeights(weights: GridWeights): HilitPersonDetector {
    return new HilitPersonDetector(weights, null);
  }

  static unavailable(reason: string): HilitPersonDetector {
    return new HilitPersonDetector(null, reason);
  }

  proposeRgba(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    timestamp = 0,
    options: ProposeOptions = {},
  ): DetectorRun {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      if (options.signal?.aborted) {
        return this.finish('error', 'cancelled', [], t0, width, height, timestamp, 'error');
      }
      if (!(width > 2) || !(height > 2) || rgba.length < width * height * 4) {
        return this.finish('error', 'bad-frame', [], t0, width, height, timestamp, 'error');
      }
      let proposals: DetectorProposal[] = [];
      let sliceCount = 1;
      if (options.region) {
        proposals = this.proposeOnRegion(rgba, width, height, options.region, options.sources, options.scoreMin);
      } else if (options.sliced) {
        const subjectHeight = options.subjectHeight
          ?? (options.focus && height > 0 ? options.focus.height / height : null);
        const slices = planSlices(width, height, {
          focus: options.focus ?? null,
          subjectHeight,
          maxSlices: options.maxSlices ?? 3,
          force: options.forceSlice === true,
        });
        sliceCount = slices.length;
        const raw: DetectorProposal[] = [];
        for (const slice of slices) {
          const local = this.proposeOnRegion(rgba, width, height, slice.region, options.sources, options.scoreMin);
          for (const box of local) {
            if (isClipped(box, slice)) continue;
            raw.push(box);
          }
        }
        proposals = nmsProposals(raw, 0.5, 24, options.crossTileContainment ?? null);
      } else {
        proposals = this.proposeOnRegion(rgba, width, height, null, options.sources, options.scoreMin);
      }
      const named = proposals.map((p, i) => ({
        ...p,
        candidateId: `${p.source}-${i + 1}`,
      }));
      const quality = this.weights ? 'pipeline-check' : 'heuristic-only';
      const modelId = this.weights ? (this.weights.modelId ?? MODEL_ID) : STAND_MODEL_ID;
      const modelVersion = this.weights ? MODEL_VERSION : STAND_MODEL_VERSION;
      const run = named.length
        ? this.finish('ok', null, named, t0, width, height, timestamp, 'ready', quality, modelId, modelVersion)
        : this.finish('empty', null, [], t0, width, height, timestamp, 'ready', quality, modelId, modelVersion);
      run.sliceCount = sliceCount;
      return run;
    } catch (err) {
      return this.finish('error', err instanceof Error ? err.message : String(err), [], t0, width, height, timestamp, 'error');
    }
  }

  private proposeOnRegion(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    region: Rect | null,
    sources: ProposeOptions['sources'] = 'all',
    /* 쓰임새마다 다른 문턱. 안 주면 예전 기본값(0.35)이다.
     * 값의 근거는 detector-thresholds.ts 에 적혀 있다. */
    scoreMin: number = DETECTOR_SCORE_MIN.default,
  ): DetectorProposal[] {
    let view = { rgba, width, height, originX: 0, originY: 0 };
    if (region) view = cropRgba(rgba, width, height, region);
    const useGrid = sources !== 'stand';
    const useStand = sources !== 'grid';
    const proposals: DetectorProposal[] = [];
    const rgb = rgbFromRgba(view.rgba, view.width, view.height);
    if (useGrid && this.weights) {
      const logits = forwardLogits(rgb, this.weights);
      const grid = nms(decodeBoxes(logits, scoreMin, this.weights.sizeEncoding ?? 'v1'));
      for (const box of grid) {
        proposals.push(offsetProposal(
          scaleProposal(box, 'hilit-grid', view.width, view.height),
          view.originX,
          view.originY,
        ));
      }
    }
    if (useStand) {
      const smallGray = new Float32Array(GRID_IN_W * GRID_IN_H);
      const plane = GRID_IN_W * GRID_IN_H;
      for (let i = 0; i < plane; i += 1) {
        smallGray[i] = (0.299 * rgb[i] + 0.587 * rgb[plane + i] + 0.114 * rgb[2 * plane + i]) * 255;
      }
      const stand = proposeStandEnergy(smallGray, GRID_IN_W, GRID_IN_H, 8);
      for (const box of stand) {
        proposals.push(offsetProposal(
          scaleProposal(box, 'stand-energy', view.width, view.height),
          view.originX,
          view.originY,
        ));
      }
    }
    return nmsProposals(proposals, 0.5);
  }

  private finish(
    outcome: DetectorRunOutcome,
    reason: string | null,
    proposals: DetectorProposal[],
    t0: number,
    width: number,
    height: number,
    timestamp: number,
    availability: DetectorRun['availability'],
    qualityStatus: DetectorRun['qualityStatus'] = 'unavailable',
    modelId: string | null = this.weights ? MODEL_ID : null,
    modelVersion: string | null = this.weights ? MODEL_VERSION : null,
  ): DetectorRun {
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      outcome,
      availability,
      modelId,
      modelVersion,
      qualityStatus,
      proposals,
      reason: reason ?? this.reason,
      elapsedMs: Math.max(0, t1 - t0),
      analysisWidth: GRID_IN_W,
      analysisHeight: GRID_IN_H,
      frameWidth: width,
      frameHeight: height,
      timestamp,
    };
  }
}

function scaleProposal(
  box: { x: number; y: number; width: number; height: number; score: number },
  source: DetectorProposal['source'],
  frameW: number,
  frameH: number,
): DetectorProposal {
  const sx = frameW / GRID_IN_W;
  const sy = frameH / GRID_IN_H;
  return {
    candidateId: '',
    x: box.x * sx,
    y: box.y * sy,
    width: box.width * sx,
    height: box.height * sy,
    detectorScore: box.score,
    source,
  };
}

function offsetProposal(box: DetectorProposal, dx: number, dy: number): DetectorProposal {
  return { ...box, x: box.x + dx, y: box.y + dy };
}

/* 조각까지 합치면 후보가 는다. 12 로 묶어 두면 조각에서 나온 작은
 * 사람들이 큰 사람에게 밀려 잘린다 — 실측에서 키 50px 구간 검출률이
 * 92.5%에서 72.5%로 떨어졌다. 조각을 쓸 때는 24 까지 받는다. */
function nmsProposals(
  boxes: DetectorProposal[], iouThr: number, maxKeep = 12, containThr: number | null = null,
): DetectorProposal[] {
  const sorted = [...boxes].sort((a, b) => b.detectorScore - a.detectorScore);
  const keep: DetectorProposal[] = [];
  for (const box of sorted) {
    if (keep.some((k) => iou(k, box) > iouThr)) continue;
    /* 포함 관계: 점수 높은 큰 상자 안에 대부분 들어간 작은 상자(상반신·조각 일부)는 같은 사람이다. */
    if (containThr !== null && keep.some((k) => k.width * k.height >= 1.5 * box.width * box.height && containedShare(box, k) >= containThr)) continue;
    keep.push(box);
    if (keep.length >= maxKeep) break;
  }
  return keep;
}

/** 작은 상자 a 가 큰 상자 b 안에 들어간 비율(교집합 / a 넓이). */
function containedShare(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const area = a.width * a.height;
  return area > 0 ? (w * h) / area : 0;
}

function iou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const uni = a.width * a.height + b.width * b.height - inter;
  return uni <= 0 ? 0 : inter / uni;
}

export { QUALITY_STATUS };
