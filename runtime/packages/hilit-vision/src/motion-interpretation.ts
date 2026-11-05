/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·477c2595 @license @preserve */
/* 해석. 관측과 같은 필드에 두지 않는다.

화면 상승만으로 점프라고 하지 않는다.
카메라 흔들림을 착지 불안정으로 바꾸지 않는다.
근거가 없으면 unsupported 다.
*/

import { MOTION_ANALYSIS_VERSION, type InterpretationKind } from './analysis-contract';
import type { CameraEstimate } from './camera-motion';
import type { SubjectMotionStep } from './subject-motion';
import type { PoseObservation } from './pose-observation';
import { bodyLowerSpans, type PoseFeatureSample } from './pose-features';

export interface MotionInterpretation {
  kind: InterpretationKind;
  videoId: string;
  subjectId: string | null;
  t0Sec: number;
  t1Sec: number;
  analysisVersion: string;
  evidence: string[];
  uncertain: boolean;
  supported: boolean;
  reason: string;
}

export function interpretSubjectAndCamera(input: {
  camera: CameraEstimate | null;
  subject: SubjectMotionStep | null;
}): MotionInterpretation {
  const videoId = input.subject?.videoId ?? input.camera?.videoId ?? '';
  const subjectId = input.subject?.subjectId ?? input.camera?.subjectId ?? null;
  const t0 = input.subject?.t0Sec ?? input.camera?.t0Sec ?? 0;
  const t1 = input.subject?.t1Sec ?? input.camera?.t1Sec ?? 0;
  const base = {
    videoId,
    subjectId,
    t0Sec: t0,
    t1Sec: t1,
    analysisVersion: MOTION_ANALYSIS_VERSION,
    evidence: [] as string[],
    uncertain: true,
    supported: false,
  };

  if (input.subject && !input.subject.identityOk) {
    return {
      ...base,
      kind: 'unsupported',
      reason: '신원 불확실. 이동 해석을 확정하지 않습니다.',
    };
  }

  const camOk = !!input.camera?.usable;
  const camMove = camOk && Math.hypot(input.camera?.dxPx ?? 0, input.camera?.dyPx ?? 0) > 4;
  const subComp = input.subject?.cameraCompensatedDxPx != null
    && input.subject.cameraCompensatedDyPx != null
    && input.subject.status === 'ok';
  const subRaw = input.subject?.status === 'ok' && (input.subject.screenSpeedPerSec ?? 0) > 8;
  const subRel = subComp && Math.hypot(input.subject!.cameraCompensatedDxPx!, input.subject!.cameraCompensatedDyPx!) > 4;

  if (camOk && camMove && (!input.subject || input.subject.status === 'jitter' || !subRel)) {
    return {
      ...base,
      kind: 'camera_move',
      evidence: ['camera-translation'],
      uncertain: false,
      supported: true,
      reason: '배경 이동이 있고 대상 상대 이동은 작습니다.',
    };
  }
  if (subRel) {
    return {
      ...base,
      kind: 'subject_screen_move',
      evidence: ['camera-compensated-box'],
      uncertain: false,
      supported: true,
      reason: '카메라 보정 뒤에도 박스가 움직입니다. 점프가 아닙니다.',
    };
  }
  if (!camOk && subRaw) {
    return {
      ...base,
      kind: 'hard_to_separate',
      evidence: ['raw-box-only'],
      uncertain: true,
      supported: true,
      reason: '카메라 보정을 못 해 화면 이동과 대상 이동을 가르지 못합니다.',
    };
  }
  if (input.subject?.status === 'jitter') {
    return {
      ...base,
      kind: 'unsupported',
      evidence: ['box-jitter'],
      reason: '박스 흔들림을 인물 동작으로 해석하지 않습니다.',
    };
  }
  return {
    ...base,
    kind: 'unsupported',
    reason: '이동 해석 근거가 부족합니다.',
  };
}

export function interpretPoseRequest(input: {
  utterance: string;
  features: readonly PoseFeatureSample[];
  poses: readonly PoseObservation[];
}): MotionInterpretation[] {
  const text = input.utterance;
  if (/착지/.test(text) || (/점프/.test(text) && /불안|성공|득점/.test(text))) {
    return [{
      kind: 'unsupported',
      videoId: input.poses[0]?.videoId ?? '',
      subjectId: input.poses[0]?.subjectId ?? null,
      t0Sec: 0,
      t1Sec: 0,
      analysisVersion: MOTION_ANALYSIS_VERSION,
      evidence: [],
      uncertain: true,
      supported: false,
      reason: '착지 안정·점프 성공 판별기가 없습니다. 화면 흔들림으로 대체하지 않습니다.',
    }];
  }
  if (/낮추|무릎|굽히/.test(text)) {
    const hasJoints = input.poses.some((p) => p.status === 'observed');
    if (!hasJoints) {
      return [{
        kind: 'unsupported',
        videoId: input.poses[0]?.videoId ?? '',
        subjectId: input.poses[0]?.subjectId ?? null,
        t0Sec: 0,
        t1Sec: 0,
        analysisVersion: MOTION_ANALYSIS_VERSION,
        evidence: [],
        uncertain: true,
        supported: false,
        reason: '몸을 낮추는 구간은 관절 관측이 필요합니다. 지금은 추정기가 없습니다.',
      }];
    }
    return bodyLowerSpans(input.features).map((span) => ({
      kind: 'body_lower_2d' as const,
      videoId: span.videoId,
      subjectId: span.subjectId,
      t0Sec: span.startSec,
      t1Sec: span.endSec,
      analysisVersion: MOTION_ANALYSIS_VERSION,
      evidence: [span.evidence],
      uncertain: true,
      supported: true,
      reason: `2D 무릎 굽힘이 커진 후보입니다. 확정 없이 게시하지 않습니다. peak=${span.peakFlex.toFixed(1)}`,
    }));
  }
  return [];
}
