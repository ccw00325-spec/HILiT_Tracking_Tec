/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·379cdc51 @license @preserve */
/* 자세 관측.

실제 관절이 있을 때만 observed 다.
박스에서 가상 관절을 만들지 않는다.
추정기가 없으면 unavailable 이고 기능은 미완료다.
모델 가시성 점수는 정확도가 아니다.
*/

import {
  POSE_ANALYSIS_VERSION,
  type AnalysisRef,
  type PoseObsStatus,
} from './analysis-contract';
import type { PreprocessMeta } from './letterbox';
import { restorePoint } from './letterbox';
import { sharedPoseRuntime } from './pose-runtime';

export const POSE_JOINT_NAMES = [
  'nose',
  'l_eye', 'r_eye', 'l_ear', 'r_ear',
  'l_shoulder', 'r_shoulder',
  'l_elbow', 'r_elbow',
  'l_wrist', 'r_wrist',
  'l_hip', 'r_hip',
  'l_knee', 'r_knee',
  'l_ankle', 'r_ankle',
] as const;

export type JointName = (typeof POSE_JOINT_NAMES)[number];

export const POSE_VISIBLE_MIN = 0.35;
export const POSE_MIN_BOX_PX = 28;
export const POSE_MAX_OVERLAP = 0.35;

export interface JointObservation {
  name: JointName;
  x: number;
  y: number;
  visibility: number;
  visible: boolean;
}

export interface PoseObservation extends AnalysisRef {
  subjectId: string;
  tSec: number;
  status: PoseObsStatus;
  joints: JointObservation[] | null;
  coordinateSpace: 'source-pixels' | 'analysis-pixels' | 'none';
  extractorId: string | null;
  extractorVersion: number | null;
  modelVisibilityIsNotAccuracy: true;
  reason: string;
}

export interface PoseEstimatorReport {
  available: boolean;
  kind: 'none' | 'hilit-own';
  reason: string;
  /** 우리 것인가. 외부 가중치를 실었다면 false 여야 한다. */
  ownWeights: boolean;
  /** 우리가 내는 관절 이름. 이 밖의 관절은 만들지 않는다. */
  joints: readonly string[];
  needed: string[];
  candidates: Array<{
    name: string;
    rights: 'unknown' | 'needs-approval' | 'owned';
    note: string;
  }>;
}

/**
 * 자세 추정기가 있는가.
 *
 * 2026-09-21 부터 자체 추정기(HilitPoseNet)가 있다. 다만 런타임에
 * **가중치를 실어야** 관절이 나온다. 안 실렸으면 available 은 false 이고,
 * 그때는 상자에서 가상 관절을 만들지 않는다.
 */
export function poseEstimatorAvailability(): PoseEstimatorReport {
  const runtime = sharedPoseRuntime();
  if (runtime.loaded) {
    return {
      available: true,
      kind: 'hilit-own',
      reason: 'hilit-pose-net-loaded',
      ownWeights: true,
      joints: runtime.joints,
      needed: ['실사 영상 관절 정답으로 정확도 측정'],
      candidates: [{
        name: 'HilitPoseNet (자체)',
        rights: 'owned',
        note: '합성 그림으로만 학습했다. 실사 관절 정확도가 아니다.',
      }],
    };
  }
  return {
    available: false,
    kind: 'none',
    reason: 'weights-not-loaded',
    ownWeights: true,
    joints: runtime.joints,
    needed: ['HilitPoseNet 가중치를 런타임에 싣기'],
    candidates: [{
      name: 'HilitPoseNet (자체)',
      rights: 'owned',
      note: '구조·가중치 모두 우리 것. 외부 keypoint 데이터셋·사전학습 없음. 실사 정확도는 미측정.',
    }],
  };
}

function refOf(input: {
  videoId: string;
  subjectId: string;
  tSec: number;
}): AnalysisRef {
  return {
    videoId: input.videoId,
    subjectId: input.subjectId,
    t0Sec: input.tSec,
    t1Sec: input.tSec,
    timeBase: 'source',
    analysisVersion: POSE_ANALYSIS_VERSION,
    provenance: 'local',
  };
}

export function emptyPoseObservation(input: {
  videoId: string;
  subjectId: string;
  tSec: number;
  status?: PoseObsStatus;
  reason?: string;
}): PoseObservation {
  const avail = poseEstimatorAvailability();
  return {
    ...refOf(input),
    subjectId: input.subjectId,
    tSec: input.tSec,
    status: input.status ?? 'unavailable',
    joints: null,
    coordinateSpace: 'none',
    extractorId: null,
    extractorVersion: null,
    modelVisibilityIsNotAccuracy: true,
    reason: input.reason ?? `${avail.reason}: 실제 추정기가 없어 관절을 만들지 않았습니다.`,
  };
}

/** 박스에서 관절을 만들지 않는다. 호출해도 항상 null. */
export function jointsFromBox(_box: { x: number; y: number; width: number; height: number }): null {
  return null;
}

export function restoreJointsToSource(
  joints: readonly JointObservation[],
  meta: PreprocessMeta,
): JointObservation[] {
  return joints.map((j) => {
    const p = restorePoint({ x: j.x, y: j.y }, meta);
    return { ...j, x: p.x, y: p.y };
  });
}

export function bindPoseToSubject(input: {
  videoId: string;
  subjectId: string;
  tSec: number;
  joints: JointObservation[] | null;
  extractorId: string | null;
  extractorVersion: number | null;
  coordinateSpace: 'source-pixels' | 'analysis-pixels';
  identityOk: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
  overlapOther: number;
  clipped: boolean;
  tooSmall: boolean;
  blurry: boolean;
}): PoseObservation {
  const base = refOf(input);
  const fail = (status: PoseObsStatus, reason: string): PoseObservation => ({
    ...base,
    subjectId: input.subjectId,
    tSec: input.tSec,
    status,
    joints: null,
    coordinateSpace: 'none',
    extractorId: input.extractorId,
    extractorVersion: input.extractorVersion,
    modelVisibilityIsNotAccuracy: true,
    reason,
  });

  if (!input.joints || !input.joints.length) {
    return fail('unavailable', '관절 관측이 없습니다. 박스에서 만들지 않았습니다.');
  }
  if (!input.identityOk) {
    return fail('identity_uncertain', '신원이 불확실해 자세를 그 사람으로 붙이지 않습니다.');
  }
  if (input.overlapOther > POSE_MAX_OVERLAP) {
    return fail('overlap', '영역 안에 다른 사람이 겹쳐 관절 혼입을 막습니다.');
  }
  if (input.clipped) {
    return fail('clipped', '대상 박스가 잘려 관절을 확실한 관측으로 두지 않습니다.');
  }
  if (input.tooSmall || (input.box && (input.box.width < POSE_MIN_BOX_PX || input.box.height < POSE_MIN_BOX_PX * 1.5))) {
    return fail('too_small', '인물이 작아 관절을 확실한 관측으로 두지 않습니다.');
  }
  if (input.blurry) {
    return fail('blur', '흐려 관절을 확실한 관측으로 두지 않습니다.');
  }

  const visible = input.joints.filter((j) => j.visible && j.visibility >= POSE_VISIBLE_MIN);
  if (visible.length < 4) {
    return fail('unavailable', '보이는 관절이 부족합니다.');
  }

  return {
    ...base,
    subjectId: input.subjectId,
    tSec: input.tSec,
    status: 'observed',
    joints: input.joints.map((j) => ({
      ...j,
      visible: j.visible && j.visibility >= POSE_VISIBLE_MIN,
    })),
    coordinateSpace: input.coordinateSpace,
    extractorId: input.extractorId,
    extractorVersion: input.extractorVersion,
    modelVisibilityIsNotAccuracy: true,
    reason: '외부에서 준 관절만 검사해 붙였습니다. 제품 추정기가 생긴 것은 아닙니다.',
  };
}
