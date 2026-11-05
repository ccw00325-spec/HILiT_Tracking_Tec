/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·7d39fa0a @license @preserve */
/* 외형 추출기 자리. 지금 구현은 손대는 HSV + 기울기 무늬다.

학습된 Re-ID 벡터가 아니다. 외부 가중치를 받지 않는다.
NanoTrack·NanoDet 를 교사로 쓰지 않는다.
*/

import { describe, similarity, similarityBandAware, type Descriptor } from './appearance';
import { describeTexture, textureSimilarity, type TextureDescriptor } from './appearance-texture';

export type FeatureExtractorKind = 'handcrafted' | 'learned';

export const HSV_EXTRACTOR_ID = 'hsv-bands-v1';
export const HSV_TEXTURE_EXTRACTOR_ID = 'hsv-bands-texture-v1';
export const EXTRACTOR_VERSION = 1;
/** 브라우저 crop 전처리(패딩·고정 크기). 레이아웃이 바뀌면 특징 캐시를 버린다. */
export const APPEARANCE_PREPROCESS_VERSION = 1;

export interface ExtractedAppearance {
  extractorId: typeof HSV_EXTRACTOR_ID | typeof HSV_TEXTURE_EXTRACTOR_ID;
  extractorVersion: number;
  kind: FeatureExtractorKind;
  color: Descriptor;
  texture: TextureDescriptor;
}

export interface AppearancePairScore {
  color: number;
  colorAware: number;
  texture: number;
  combined: number;
  extractorId: ExtractedAppearance['extractorId'];
}

export function extractAppearance(
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  background?: Descriptor,
  hasAlpha = false,
): ExtractedAppearance {
  return {
    extractorId: HSV_TEXTURE_EXTRACTOR_ID,
    extractorVersion: EXTRACTOR_VERSION,
    kind: 'handcrafted',
    color: describe(rgb, w, h, background, hasAlpha),
    texture: describeTexture(rgb, w, h, hasAlpha),
  };
}

/**
 * 색은 기존 문턱(0.62)의 기준선이다. 무늬는 색이 비슷할 때만 거들 뿐,
 * 색이 다른데 무늬가 같다고 수락으로 올리지 않는다.
 */
export function scoreExtractedPair(a: ExtractedAppearance, b: ExtractedAppearance): AppearancePairScore {
  const color = similarity(a.color, b.color);
  const colorAware = similarityBandAware(a.color, b.color);
  const texture = textureSimilarity(a.texture, b.texture);
  const colorForMix = colorAware;
  let combined = colorForMix;
  if (texture !== 0.5 && colorForMix >= 0.55) {
    combined = colorForMix * 0.78 + texture * 0.22;
  }
  return {
    color,
    colorAware,
    texture,
    combined: Math.max(0, Math.min(1, combined)),
    extractorId: HSV_TEXTURE_EXTRACTOR_ID,
  };
}

export function learnedReidAvailability(): {
  available: false;
  kind: 'learned';
  reason: 'no-authorized-weights-or-labels';
  needed: string[];
} {
  return {
    available: false,
    kind: 'learned',
    reason: 'no-authorized-weights-or-labels',
    needed: [
      '같은 촬영 세션을 학습·검증·평가에 나누지 않은 인물별 다중 프레임 정답',
      '가능하면 인물도 나눈 train/val/test',
      'rightsStatus ALLOW 와 검수된 identityId',
      '자체 학습 환경. 외부 연구용 가중치·Nano 교사 없음',
    ],
  };
}
