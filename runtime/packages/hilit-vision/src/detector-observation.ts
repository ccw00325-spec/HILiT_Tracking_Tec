/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·2f5f0491 @license @preserve */
/* 검출 상자를 신원 관측으로 쓰기 전의 품질·연결 가드.

상자가 있다는 것만으로 사람 검출·동일인 근거가 되지 않는다.
휴리스틱·픽스처·가중치 없는 경로는 후보 탐색에는 쓸 수 있어도
확정 관측으로는 쓰지 않는다.
*/

export type DetectorObservationReason =
  | 'trusted'
  | 'disconnected'
  | 'weights-absent'
  | 'heuristic-not-person'
  | 'fixture-not-person'
  | 'score-missing'
  | 'crop-invalid'
  | 'unassigned'
  | 'not-claimed-person';

export interface DetectorObservationInput {
  connected: boolean;
  weightsPresent: boolean;
  claimedPersonDetection?: boolean;
  source?: string;
  score?: number | null;
  scoreMin?: number;
  cropValid: boolean;
  assignedToTracklet?: boolean;
}

export function detectorObservationTrust(input: DetectorObservationInput): {
  trusted: boolean;
  reason: DetectorObservationReason;
} {
  if (!input.connected) return { trusted: false, reason: 'disconnected' };
  if (!input.cropValid) return { trusted: false, reason: 'crop-invalid' };
  const source = input.source || '';
  if (source === 'heuristic_not_person' || source.includes('heuristic')) {
    return { trusted: false, reason: 'heuristic-not-person' };
  }
  if (source === 'fixture' || source === 'fixture_not_person') {
    return { trusted: false, reason: 'fixture-not-person' };
  }
  if (!input.weightsPresent) return { trusted: false, reason: 'weights-absent' };
  if (input.claimedPersonDetection !== true) {
    return { trusted: false, reason: 'not-claimed-person' };
  }
  if (input.score == null || !Number.isFinite(input.score)) {
    return { trusted: false, reason: 'score-missing' };
  }
  if (input.scoreMin != null && input.score < input.scoreMin) {
    return { trusted: false, reason: 'score-missing' };
  }
  if (input.assignedToTracklet === false) return { trusted: false, reason: 'unassigned' };
  return { trusted: true, reason: 'trusted' };
}
