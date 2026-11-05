/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·7c473d1c @license @preserve */
/* 자체 검출기 최소 입출력.

검출기는 사람 **후보** 만 낸다. 동일인 여부는 Re-ID·이동·시간·사용자 확인이
맡는다. 검출 점수를 동일인 확률로 읽지 않는다.
"사람이 없다"와 "검출기가 없다"는 서로 다른 결과다.
*/

export type DetectorAvailability = 'ready' | 'unavailable' | 'error';

export type DetectorOutcomeKind = 'ok' | 'empty' | 'unavailable' | 'error' | 'cancelled' | 'timeout';

export interface DetectorFrameRef {
  frameId: string;
  timestamp: number;
  width: number;
  height: number;
  /** 분석에 쓴 이미지 크기. 원본과 다를 수 있다. */
  analysisWidth: number;
  analysisHeight: number;
}

export interface PersonProposal {
  candidateId: string;
  /** 분석 이미지 좌표의 화소 상자 */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * 모델이 내는 점수. 동일인 확률이 아니다.
   * 없는 검출기에서는 이 필드를 채우지 않는다.
   */
  detectorScore?: number;
}

export interface DetectorRequest {
  frame: DetectorFrameRef;
  /** 이미 알고 있는 대략 위치. 교정·재획득에 쓴다. */
  hint?: { x: number; y: number; width: number; height: number };
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DetectorResult {
  outcome: DetectorOutcomeKind;
  availability: DetectorAvailability;
  modelId: string | null;
  modelVersion: string | null;
  proposals: PersonProposal[];
  reason: string | null;
  elapsedMs?: number;
  qualityStatus?: 'pipeline-check' | 'heuristic-only' | 'consented-person' | 'unavailable';
}

export const DETECTOR_UNAVAILABLE: DetectorResult = {
  outcome: 'unavailable',
  availability: 'unavailable',
  modelId: null,
  modelVersion: null,
  proposals: [],
  reason: 'detector-removed',
};

export function emptyScene(frame: DetectorFrameRef, modelId: string, modelVersion: string): DetectorResult {
  return {
    outcome: 'empty',
    availability: 'ready',
    modelId,
    modelVersion,
    proposals: [],
    reason: null,
  };
}

export function detectorOk(
  frame: DetectorFrameRef,
  modelId: string,
  modelVersion: string,
  proposals: PersonProposal[],
  elapsedMs: number,
  qualityStatus: NonNullable<DetectorResult['qualityStatus']> = 'pipeline-check',
): DetectorResult {
  if (!proposals.length) return emptyScene(frame, modelId, modelVersion);
  return {
    outcome: 'ok',
    availability: 'ready',
    modelId,
    modelVersion,
    proposals,
    reason: null,
    elapsedMs,
    qualityStatus,
  };
}

/** 평가 전용 가짜 후보는 제품 경로에서 부르면 안 된다. */
export const EVAL_ONLY_DETECTOR_ID = 'eval-fixture-not-for-product';
