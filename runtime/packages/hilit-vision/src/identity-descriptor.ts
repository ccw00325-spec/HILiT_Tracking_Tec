/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·46e06f4f @license @preserve */
/* 실제 픽셀에서 색·무늬·부위 질감·HSV 보조·품질·가시성을 한 번에 낸다.

학습 임베딩이 아니다. 정면·측면·후면을 추측하지 않는다.
HSV는 같은 가족 보조다. 두 번 통과했다고 동일인 확정이 아니다.
가시성 불명을 visible=true로 바꾸지 않는다.
*/

import { extractAppearance, HSV_TEXTURE_EXTRACTOR_ID, EXTRACTOR_VERSION } from './feature-extractor';
import { describePartTexture, partTextureSimilarity, type PartTextureDescriptor } from './part-texture';
import { describeHsvAux, compareHsvAux, applyHsvAuxiliary, type HsvAuxDescriptor } from './hsv-aux';
import { scoreRegionProxy, ALIGNMENT_LEVEL, type RegionProxyObservation } from './region-proxy';
import { scoreObservationQuality, type ObservationQuality } from './appearance-quality';
import { EXTRACTOR_CONTRACT } from './descriptor-layout';
import { similarityByBand, maskedBandSimilarity, type Descriptor } from './appearance';
import type { TextureDescriptor } from './appearance-texture';
import type { ReentryEvidence } from './reentry-match';
import {
  describeEquipmentProxy,
  compareEquipmentProxy,
  type EquipmentProxyDescriptor,
} from './equipment-proxy';
import {
  describeColorAttributes,
  compareColorAttributes,
  type ColorAttributeDescriptor,
} from './color-attribute';
import {
  describeEmbeddingGroups,
  compareEmbeddingGroups,
  type EmbeddingGroupDescriptor,
} from './embedding-groups';

export interface IdentityDescriptor {
  extractorId: typeof HSV_TEXTURE_EXTRACTOR_ID;
  extractorVersion: number;
  kind: 'handcrafted';
  alignment: typeof ALIGNMENT_LEVEL;
  viewHint: 'unknown';
  color: Descriptor;
  texture: TextureDescriptor;
  partTexture: PartTextureDescriptor;
  hsvAux: HsvAuxDescriptor;
  equipmentProxy: EquipmentProxyDescriptor;
  colorAttribute: ColorAttributeDescriptor;
  /** 머리·상체·하체·정체성·휴대물품 다섯 갈래. */
  embeddingGroups: EmbeddingGroupDescriptor;
  region: RegionProxyObservation;
  quality: ObservationQuality;
  descriptorVersion: {
    color: 1;
    texture: 1;
    partTexture: 1;
    hsvAux: 1;
    equipmentProxy: 1;
    colorAttribute: 1;
    embeddingGroups: 1;
  };
}

function lumaVariance(rgb: Uint8Array | Uint8ClampedArray, w: number, h: number, hasAlpha: boolean): number {
  const stride = hasAlpha ? 4 : 3;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 400)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * stride;
      if (hasAlpha && rgb[i + 3] < 8) continue;
      const yv = (0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]) / 255;
      sum += yv;
      sum2 += yv * yv;
      n += 1;
    }
  }
  if (n < 8) return 0;
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

export function extractIdentityDescriptor(
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  opts?: {
    hasAlpha?: boolean;
    box?: { x: number; y: number; width: number; height: number };
    frame?: { width: number; height: number };
    overlapRisk?: number;
  },
): IdentityDescriptor {
  const hasAlpha = opts?.hasAlpha === true;
  const base = extractAppearance(rgb, w, h, undefined, hasAlpha);
  const partTexture = describePartTexture(rgb, w, h, hasAlpha);
  const hsvAux = describeHsvAux(rgb, w, h, hasAlpha);
  const equipmentProxy = describeEquipmentProxy(rgb, w, h, hasAlpha);
  const colorAttribute = describeColorAttributes(rgb, w, h, hasAlpha);
  const box = opts?.box ?? { x: 0, y: 0, width: w, height: h };
  const frame = opts?.frame ?? { width: w, height: h };
  const region = scoreRegionProxy({
    box,
    frame,
    overlapRisk: opts?.overlapRisk ?? 0,
  });
  const quality = scoreObservationQuality({
    samples: base.color.samples,
    trust: base.color.trust,
    box,
    frame,
    overlapOther: opts?.overlapRisk,
    visibleRatio: 1 - (region.parts.reduce((s, p) => s + p.clippedShare, 0) / 3),
    lumaVariance: lumaVariance(rgb, w, h, hasAlpha),
  });
  const embeddingGroups = describeEmbeddingGroups(rgb, w, h, {
    region,
    hasAlpha,
    boxAspect: box.height / Math.max(1e-6, box.width),
  });
  return {
    extractorId: HSV_TEXTURE_EXTRACTOR_ID,
    extractorVersion: EXTRACTOR_VERSION,
    kind: 'handcrafted',
    alignment: ALIGNMENT_LEVEL,
    viewHint: 'unknown',
    color: base.color,
    texture: base.texture,
    partTexture,
    hsvAux,
    equipmentProxy,
    colorAttribute,
    embeddingGroups,
    region,
    quality,
    descriptorVersion: {
      color: 1, texture: 1, partTexture: 1, hsvAux: 1, equipmentProxy: 1, colorAttribute: 1,
      embeddingGroups: 1,
    },
  };
}

export function scoreIdentityPair(
  memory: IdentityDescriptor,
  candidate: IdentityDescriptor,
): { combined: number | null; evidence: ReentryEvidence } {
  const visible: [boolean, boolean, boolean] = [
    memory.region.visibleMask[0] && candidate.region.visibleMask[0],
    memory.region.visibleMask[1] && candidate.region.visibleMask[1],
    memory.region.visibleMask[2] && candidate.region.visibleMask[2],
  ];
  const usedVisible = visible.filter(Boolean).length;
  const headOnly = visible[0] && !visible[1] && !visible[2];
  const minEvidenceMet = usedVisible >= 2 && !headOnly
    && memory.region.minEvidenceMet && candidate.region.minEvidenceMet;

  let unmaskedColor = 0;
  const n = Math.min(memory.color.values.length, candidate.color.values.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += memory.color.values[i] * candidate.color.values[i];
    na += memory.color.values[i] * memory.color.values[i];
    nb += candidate.color.values[i] * candidate.color.values[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  unmaskedColor = denom > 1e-9 ? Math.max(0, Math.min(1, dot / denom)) : 0;

  const bodyPartScores = similarityByBand(memory.color, candidate.color);
  const maskedColor = maskedBandSimilarity(bodyPartScores, visible);

  const part = partTextureSimilarity(memory.partTexture, candidate.partTexture, visible);
  const hsv = compareHsvAux(memory.hsvAux, candidate.hsvAux, visible);
  const equipment = compareEquipmentProxy(memory.equipmentProxy, candidate.equipmentProxy, visible);
  const colorAttr = compareColorAttributes(memory.colorAttribute, candidate.colorAttribute, visible);
  /* 다섯 갈래 대조. 정체성은 1차(상체·하체·머리·휴대물품)가 애매하거나
   * 아예 없을 때만 들어온다 — 체형으로 먼저 사람을 고르지 않는다. */
  const groups = compareEmbeddingGroups(memory.embeddingGroups, candidate.embeddingGroups);
  const color = maskedColor.score;
  const aux = applyHsvAuxiliary(color, hsv);
  const partScore = part.score;
  const global = color;
  const visiblePart = color == null
    ? null
    : partScore != null ? partScore * 0.45 + color * 0.55 : color;
  const bodyContradictions = bodyPartScores.reduce<number>((count, score, i) => (
    visible[i] && score != null && score < 0.42 ? count + 1 : count
  ), 0);

  const evidence: ReentryEvidence = {
    globalAppearance: global,
    visiblePartAppearance: visiblePart,
    colorConsistency: aux.score,
    hsvAux: hsv,
    observationQuality: candidate.quality.score,
    exitEntryPlausible: null,
    trackletContinuous: null,
    rivalMargin: null,
    knownOtherConflict: false,
    simultaneousPresenceConflict: false,
    evidenceCount: usedVisible,
    headOnly,
    minEvidenceMet,
    bodyPartScores,
    bodyContradictions,
    equipmentConsistency: equipment.score,
    equipmentReliable: equipment.reliable,
    equipmentContradictions: equipment.contradictions,
    unmaskedGlobalAppearance: unmaskedColor,
    colorAttributeAgreement: colorAttr.score,
    colorAttributeUsedRegions: colorAttr.usedRegions,
    colorAttributeMaskedRegions: colorAttr.maskedRegions,
    colorAttributeContradictions: colorAttr.contradictions,
    groupAppearance: groups.score,
    groupPrimaryAppearance: groups.primaryScore,
    groupIdentityAppearance: groups.identityScore,
    groupDecidedBy: groups.decidedBy,
    groupIdentityUsed: groups.identityUsed,
    groupUsedPrimary: groups.usedPrimaryGroups,
    groupMasked: groups.maskedGroups,
    groupContradictions: groups.contradictions,
  };
  const combined = minEvidenceMet && !headOnly && visiblePart != null
    ? Math.max(0, Math.min(1, visiblePart * 0.78 + (aux.score ?? color ?? visiblePart) * 0.22))
    : null;
  return { combined, evidence };
}

/** 사용자 확인을 받은 여러 시점 중 가장 잘 설명하는 모습을 고른다. */
export function scoreIdentityAgainstMemories(
  memories: readonly IdentityDescriptor[],
  candidate: IdentityDescriptor,
): { combined: number | null; evidence: ReentryEvidence; memoryIndex: number } | null {
  let best: { combined: number | null; evidence: ReentryEvidence; memoryIndex: number } | null = null;
  for (let i = 0; i < memories.length; i += 1) {
    const pair = scoreIdentityPair(memories[i], candidate);
    if (!best || (pair.combined ?? -1) > (best.combined ?? -1)) {
      best = { ...pair, memoryIndex: i };
    }
  }
  return best;
}

export function assertDescriptorFamily(a: IdentityDescriptor, b: IdentityDescriptor): boolean {
  return a.extractorId === b.extractorId
    && a.extractorVersion === b.extractorVersion
    && a.color.values.length === EXTRACTOR_CONTRACT.color.size
    && b.color.values.length === EXTRACTOR_CONTRACT.color.size
    && a.partTexture.values.length === EXTRACTOR_CONTRACT.partTexture.size
    && a.equipmentProxy.zones.length === 3
    && b.equipmentProxy.zones.length === 3
    && a.colorAttribute.scheme === b.colorAttribute.scheme
    && a.embeddingGroups.scheme === b.embeddingGroups.scheme
    && a.embeddingGroups.groups.length === 5
    && b.embeddingGroups.groups.length === 5
    && a.alignment === 'region_proxy'
    && b.alignment === 'region_proxy';
}
