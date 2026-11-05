/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·afdb50ff @license @preserve */
/* 5단계 분석 계약.

관측 네 갈래를 한 필드에 섞지 않는다.
A 카메라 움직임 / B 대상 이동 / C 자세 관절 / D 해석.
추정 점수는 정확도·확률이 아니다. km/h·미터는 거리 보정 없이 만들지 않는다.
*/

export const MOTION_ANALYSIS_VERSION = 'motion-separation-0.90';
export const POSE_ANALYSIS_VERSION = 'pose-observation-0.90';

export type AnalysisProvenance = 'local';
export type TimeBase = 'source';

export interface AnalysisRef {
  videoId: string;
  subjectId: string | null;
  t0Sec: number;
  t1Sec: number;
  timeBase: TimeBase;
  analysisVersion: string;
  provenance: AnalysisProvenance;
}

export type CameraMotionStatus =
  | 'ok'
  | 'first_frame'
  | 'low_texture'
  | 'person_fills'
  | 'scene_cut'
  | 'inconsistent'
  | 'reset';

export type SubjectMotionStatus =
  | 'ok'
  | 'identity_hold'
  | 'gap_too_long'
  | 'invalid_dt'
  | 'camera_unusable'
  | 'jitter'
  | 'box_unusable';

export type PoseObsStatus =
  | 'observed'
  | 'unavailable'
  | 'identity_uncertain'
  | 'overlap'
  | 'too_small'
  | 'clipped'
  | 'blur'
  | 'unsupported';

export type InterpretationKind =
  | 'camera_move'
  | 'subject_screen_move'
  | 'hard_to_separate'
  | 'body_lower_2d'
  | 'knee_flex_2d'
  | 'torso_tilt_2d'
  | 'unsupported';

export function emptyRef(partial: Partial<AnalysisRef> & Pick<AnalysisRef, 'videoId'>): AnalysisRef {
  return {
    videoId: partial.videoId,
    subjectId: partial.subjectId ?? null,
    t0Sec: partial.t0Sec ?? 0,
    t1Sec: partial.t1Sec ?? 0,
    timeBase: 'source',
    analysisVersion: partial.analysisVersion ?? MOTION_ANALYSIS_VERSION,
    provenance: 'local',
  };
}
