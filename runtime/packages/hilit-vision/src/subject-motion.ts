/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·831bad39 @license @preserve */
/* 대상 이동. 카메라와 섞지 않는다.

원본 시각 차이를 쓴다. 보정 전후를 같이 둔다.
보정이 실패하면 보정 후 값을 만들지 않는다.
km/h·미터는 거리·카메라 정보 없이 만들지 않는다.
신원 보류 구간은 연속 이동으로 잇지 않는다.
*/

import {
  MOTION_ANALYSIS_VERSION,
  type AnalysisRef,
  type CameraMotionStatus,
  type SubjectMotionStatus,
} from './analysis-contract';
import type { CameraEstimate } from './camera-motion';

export const SUBJECT_MAX_GAP_SEC = 0.4;
export const SUBJECT_JITTER_PX = 2.5;
export const SUBJECT_MIN_DT_SEC = 1 / 120;

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubjectMotionStep extends AnalysisRef {
  subjectId: string;
  status: SubjectMotionStatus;
  identityOk: boolean;
  rawDxPx: number | null;
  rawDyPx: number | null;
  rawDtSec: number;
  cameraCompensatedDxPx: number | null;
  cameraCompensatedDyPx: number | null;
  cameraStatus: CameraMotionStatus | 'absent';
  boxAreaChange: number | null;
  quality: number;
  screenSpeedPerSec: number | null;
  physicalSpeed: null;
  jitterLikely: boolean;
  reason: string;
}

function center(box: PixelBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function usableBox(box: PixelBox | null | undefined): box is PixelBox {
  return !!box
    && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 4
    && box.height > 8;
}

export function computeSubjectMotionStep(input: {
  videoId: string;
  subjectId: string;
  t0Sec: number;
  t1Sec: number;
  box0: PixelBox | null;
  box1: PixelBox | null;
  identityOk: boolean;
  camera?: CameraEstimate | null;
}): SubjectMotionStep {
  const ref: AnalysisRef = {
    videoId: input.videoId,
    subjectId: input.subjectId,
    t0Sec: input.t0Sec,
    t1Sec: input.t1Sec,
    timeBase: 'source',
    analysisVersion: MOTION_ANALYSIS_VERSION,
    provenance: 'local',
  };
  const dt = input.t1Sec - input.t0Sec;
  const cameraStatus = input.camera?.status ?? 'absent';
  const base = {
    ...ref,
    subjectId: input.subjectId,
    identityOk: input.identityOk,
    rawDxPx: null as number | null,
    rawDyPx: null as number | null,
    rawDtSec: dt,
    cameraCompensatedDxPx: null as number | null,
    cameraCompensatedDyPx: null as number | null,
    cameraStatus: cameraStatus as SubjectMotionStep['cameraStatus'],
    boxAreaChange: null as number | null,
    quality: 0,
    screenSpeedPerSec: null as number | null,
    physicalSpeed: null as null,
    jitterLikely: false,
  };

  if (!input.identityOk) {
    return { ...base, status: 'identity_hold', reason: '신원 불확실 구간은 연속 이동으로 잇지 않습니다.' };
  }
  if (!Number.isFinite(dt) || dt < SUBJECT_MIN_DT_SEC) {
    return { ...base, status: 'invalid_dt', reason: '프레임 시간 차이가 없거나 뒤집혀 있습니다.' };
  }
  if (dt > SUBJECT_MAX_GAP_SEC) {
    return { ...base, status: 'gap_too_long', reason: `빈 간격 ${dt.toFixed(2)}초는 이어서 속도로 쓰지 않습니다.` };
  }
  if (!usableBox(input.box0) || !usableBox(input.box1)) {
    return { ...base, status: 'box_unusable', reason: '박스가 작거나 빠져 이동을 계산하지 않습니다.' };
  }

  const c0 = center(input.box0);
  const c1 = center(input.box1);
  const rawDx = c1.x - c0.x;
  const rawDy = c1.y - c0.y;
  const area0 = input.box0.width * input.box0.height;
  const area1 = input.box1.width * input.box1.height;
  const areaChange = area0 > 0 ? (area1 - area0) / area0 : null;
  const rawMag = Math.hypot(rawDx, rawDy);
  const jitterLikely = rawMag <= SUBJECT_JITTER_PX;

  let compensatedDx: number | null = null;
  let compensatedDy: number | null = null;
  let status: SubjectMotionStatus = 'ok';
  let reason = '원본 화면 이동만 적었습니다.';

  if (input.camera) {
    if (!input.camera.usable || input.camera.dxPx == null || input.camera.dyPx == null) {
      status = 'camera_unusable';
      reason = '카메라 보정이 실패해 보정 후 이동은 만들지 않았습니다.';
    } else {
      compensatedDx = rawDx - input.camera.dxPx;
      compensatedDy = rawDy - input.camera.dyPx;
      reason = '카메라 평행이동을 뺀 상대 이동입니다. 물리 속도가 아닙니다.';
    }
  }

  const useDx = compensatedDx ?? rawDx;
  const useDy = compensatedDy ?? rawDy;
  const speed = Math.hypot(useDx, useDy) / dt;

  if (jitterLikely && (compensatedDx == null || Math.hypot(compensatedDx, compensatedDy ?? 0) <= SUBJECT_JITTER_PX)) {
    status = status === 'camera_unusable' ? status : 'jitter';
    reason = status === 'jitter'
      ? '박스 흔들림 범위라 인물 이동으로 쓰지 않습니다.'
      : reason;
  }

  return {
    ...base,
    status,
    rawDxPx: rawDx,
    rawDyPx: rawDy,
    cameraCompensatedDxPx: compensatedDx,
    cameraCompensatedDyPx: compensatedDy,
    boxAreaChange: areaChange,
    quality: jitterLikely ? 0.2 : 0.7,
    screenSpeedPerSec: status === 'ok' ? speed : null,
    jitterLikely,
    reason,
  };
}

export function mustNotInventPhysicalSpeed(_step: SubjectMotionStep): null {
  return null;
}
