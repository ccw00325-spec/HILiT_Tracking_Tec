/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·1d2e1e4a @license @preserve */
/* 재등장 후보의 공통 순위.

직접 외형 → (표본 충분 시) 이웃 재순위 → 소프트 공간 결합.
H0/H1/H2 와 judgeReentry 가 같은 순서를 쓰게 한다.

절대 문턱(수락·H0 이득)은 외형 점수를 유지한다.
공간은 가까운 경쟁자 순서만 바꾼다. 외형 부족을 채워 확정하지 않는다.
예측 점수는 ReentryEvidence 칸에 넣지 않는다.
*/

import type { Descriptor } from './appearance';
import { composeReentryScore, type ReentryCandidateScore } from './reentry-match';
import {
  kReciprocalRerank,
  kReciprocalRerankCached,
  shouldNeighborRerank,
  type JaccardNeighborCache,
  type RerankSample,
} from './k-reciprocal-rerank';
import {
  fuseAppearanceSpace,
  spatialCuesFromBoxes,
  type FusionMode,
  type SpaceCues,
} from './space-appearance-fusion';
import {
  assessSpatialQuality,
  mahalanobis2d,
  type SpatialQualityInput,
} from './spatial-quality';

export interface RankSpatialRef {
  pred: { x: number; y: number; width: number; height: number };
  stdX: number;
  stdY: number;
  cameraDx: number;
  cameraDy: number;
  prev?: { x: number; y: number } | null;
  dtSec: number;
  turning: boolean;
  zoomLikely: boolean;
}

export interface RankReentryInput {
  candidates: readonly ReentryCandidateScore[];
  descriptors?: ReadonlyMap<string, Descriptor>;
  gallery?: readonly RerankSample[];
  enableNeighborRerank?: boolean;
  galleryVersion?: number;
  neighborCache?: JaccardNeighborCache;
  fusionMode?: FusionMode;
  spatialQuality?: SpatialQualityInput | null;
  spatialRef?: RankSpatialRef | null;
}

export interface RankedReentryCandidate extends ReentryCandidateScore {
  appearanceScore: number | null;
  rankScore: number | null;
  spaceScore: number | null;
  rankReason: string;
  fusionHold: boolean;
}

export function rankReentryCandidates(input: RankReentryInput): RankedReentryCandidate[] {
  const fusionMode = input.fusionMode ?? 'off';
  const quality = input.spatialQuality
    ? assessSpatialQuality(input.spatialQuality)
    : assessSpatialQuality({
      camera: null,
      covariance: null,
      predictionUsable: false,
      sceneCut: false,
    });

  let appearanceById = new Map<string, number | null>();
  for (const c of input.candidates) {
    appearanceById.set(c.id, composeReentryScore(c.evidence));
  }

  if (input.enableNeighborRerank && input.descriptors && input.gallery?.length) {
    const rerankCandidates = input.candidates.flatMap((c) => {
      const d = input.descriptors!.get(c.id);
      const direct = appearanceById.get(c.id);
      if (!d || direct == null) return [];
      return [{ id: c.id, descriptor: d, directScore: direct }];
    });
    const gate = shouldNeighborRerank({
      scores: rerankCandidates.map((c) => c.directScore),
      galleryCount: input.gallery.length,
      distinctGallery: input.gallery.length,
      candidateCount: rerankCandidates.length,
    });
    if (gate.run) {
      const payload = {
        gallery: input.gallery,
        candidates: rerankCandidates,
        galleryVersion: input.galleryVersion ?? 0,
      };
      const rerank = input.neighborCache
        ? kReciprocalRerankCached(payload, input.neighborCache)
        : kReciprocalRerank(payload);
      if (!rerank.usedFallback) {
        for (const row of rerank.rows) appearanceById.set(row.id, row.blended);
      }
    }
  }

  const out: RankedReentryCandidate[] = input.candidates.map((c) => {
    const appearance = appearanceById.get(c.id) ?? composeReentryScore(c.evidence);
    let space: SpaceCues | null = null;
    let spaceScore: number | null = null;
    if (input.spatialRef && fusionMode !== 'off') {
      const ref = input.spatialRef;
      const cx = c.box.x + c.box.width / 2;
      const cy = c.box.y + c.box.height / 2;
      const px = ref.pred.x + ref.pred.width / 2;
      const py = ref.pred.y + ref.pred.height / 2;
      const mahal = mahalanobis2d({
        ex: cx - px,
        ey: cy - py,
        stdX: ref.stdX,
        stdY: ref.stdY,
      });
      space = spatialCuesFromBoxes({
        predCx: px,
        predCy: py,
        candCx: cx,
        candCy: cy,
        predW: ref.pred.width,
        predH: ref.pred.height,
        candW: c.box.width,
        candH: c.box.height,
        d2: mahal.d2,
        inflatedCovariance: mahal.inflatedCovariance,
        dtSec: ref.dtSec,
        cameraDx: ref.cameraDx,
        cameraDy: ref.cameraDy,
        prevCx: ref.prev ? ref.prev.x : null,
        prevCy: ref.prev ? ref.prev.y : null,
        turning: ref.turning,
        zoomLikely: ref.zoomLikely,
        exitEntryPlausible: c.evidence.exitEntryPlausible,
      });
    }
    const fused = fuseAppearanceSpace({
      appearance,
      appearanceObserved: appearance != null && c.evidence.minEvidenceMet && !c.evidence.headOnly,
      space,
      quality,
      mode: fusionMode,
    });
    spaceScore = fused.sSpace;
    return {
      ...c,
      appearanceScore: appearance,
      rankScore: fused.sRank,
      spaceScore,
      rankReason: fused.reason,
      fusionHold: fused.hold,
      combined: fused.sRank,
    };
  });

  return out.slice().sort((a, b) => (b.rankScore ?? -1) - (a.rankScore ?? -1));
}
