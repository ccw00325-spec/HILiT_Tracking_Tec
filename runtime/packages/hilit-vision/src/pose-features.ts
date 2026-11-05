/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·19a3f28a @license @preserve */
/* 자세 특징. 실제 관절 관측이 있는 구간만.

2D 화면 각도다. 3D 신체 각도가 아니다.
가린 관절은 계산하지 않는다. 긴 가림을 보간으로 잇지 않는다.
신원이 다시 확인되기 전에 이전 시퀀스에 붙이지 않는다.
*/

import { POSE_ANALYSIS_VERSION } from './analysis-contract';
import type { JointName, JointObservation, PoseObservation } from './pose-observation';

export const POSE_FEATURE_GAP_SEC = 0.25;
export const POSE_FILTER_WINDOW = 3;

export interface PoseFeatureSample {
  videoId: string;
  subjectId: string;
  tSec: number;
  analysisVersion: string;
  kneeFlexL: number | null;
  kneeFlexR: number | null;
  torsoTilt: number | null;
  hipWristY: number | null;
  filtered: boolean;
  filterDelayFrames: number;
  reason: string;
}

function joint(obs: PoseObservation, name: JointName): JointObservation | null {
  if (obs.status !== 'observed' || !obs.joints) return null;
  const row = obs.joints.find((j) => j.name === name);
  if (!row || !row.visible) return null;
  return row;
}

function angleDeg(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-3 || n2 < 1e-3) return Number.NaN;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function samplePoseFeatures(obs: PoseObservation): PoseFeatureSample {
  const base = {
    videoId: obs.videoId,
    subjectId: obs.subjectId,
    tSec: obs.tSec,
    analysisVersion: POSE_ANALYSIS_VERSION,
    kneeFlexL: null as number | null,
    kneeFlexR: null as number | null,
    torsoTilt: null as number | null,
    hipWristY: null as number | null,
    filtered: false,
    filterDelayFrames: 0,
    reason: '',
  };
  if (obs.status !== 'observed' || !obs.joints) {
    return { ...base, reason: '관절 관측이 없어 자세 특징을 만들지 않습니다.' };
  }

  const lHip = joint(obs, 'l_hip');
  const lKnee = joint(obs, 'l_knee');
  const lAnkle = joint(obs, 'l_ankle');
  const rHip = joint(obs, 'r_hip');
  const rKnee = joint(obs, 'r_knee');
  const rAnkle = joint(obs, 'r_ankle');
  const lSh = joint(obs, 'l_shoulder');
  const rSh = joint(obs, 'r_shoulder');
  const lWr = joint(obs, 'l_wrist');
  const rWr = joint(obs, 'r_wrist');

  const kneeL = lHip && lKnee && lAnkle ? angleDeg(lHip, lKnee, lAnkle) : Number.NaN;
  const kneeR = rHip && rKnee && rAnkle ? angleDeg(rHip, rKnee, rAnkle) : Number.NaN;
  let tilt = Number.NaN;
  if (lSh && rSh && lHip && rHip) {
    const midS = { x: (lSh.x + rSh.x) / 2, y: (lSh.y + rSh.y) / 2 };
    const midH = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 };
    const dx = midH.x - midS.x;
    const dy = midH.y - midS.y;
    tilt = (Math.atan2(dx, dy) * 180) / Math.PI;
  }
  let hipWristY: number | null = null;
  if (lHip && rHip && lWr && rWr) {
    const midH = (lHip.y + rHip.y) / 2;
    const midW = (lWr.y + rWr.y) / 2;
    hipWristY = midW - midH;
  }

  return {
    ...base,
    kneeFlexL: Number.isFinite(kneeL) ? 180 - kneeL : null,
    kneeFlexR: Number.isFinite(kneeR) ? 180 - kneeR : null,
    torsoTilt: Number.isFinite(tilt) ? tilt : null,
    hipWristY,
    reason: '2D 화면 각도입니다. 3D 관절각·착지·득점이 아닙니다.',
  };
}

export function sequencePoseFeatures(rows: readonly PoseObservation[]): PoseFeatureSample[] {
  const sorted = [...rows].sort((a, b) => a.tSec - b.tSec);
  const out: PoseFeatureSample[] = [];
  let last: PoseObservation | null = null;
  for (const row of sorted) {
    if (row.status !== 'observed') {
      last = null;
      out.push(samplePoseFeatures(row));
      continue;
    }
    if (last && (row.tSec - last.tSec > POSE_FEATURE_GAP_SEC || row.subjectId !== last.subjectId || row.videoId !== last.videoId)) {
      last = null;
    }
    out.push(samplePoseFeatures(row));
    last = row;
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** 3프레임 중앙값. 한 프레임 지연. 긴 가림은 채우지 않는다. */
export function filterPoseFeatures(samples: readonly PoseFeatureSample[]): PoseFeatureSample[] {
  return samples.map((row, i) => {
    if (row.kneeFlexL == null && row.kneeFlexR == null && row.torsoTilt == null) return row;
    const win = samples.slice(Math.max(0, i - (POSE_FILTER_WINDOW - 1)), i + 1)
      .filter((s) => s.videoId === row.videoId && s.subjectId === row.subjectId && row.tSec - s.tSec <= POSE_FEATURE_GAP_SEC);
    const take = (key: 'kneeFlexL' | 'kneeFlexR' | 'torsoTilt') => {
      const vals = win.map((s) => s[key]).filter((v): v is number => v != null && Number.isFinite(v));
      return vals.length ? median(vals) : row[key];
    };
    return {
      ...row,
      kneeFlexL: take('kneeFlexL'),
      kneeFlexR: take('kneeFlexR'),
      torsoTilt: take('torsoTilt'),
      filtered: true,
      filterDelayFrames: Math.min(i, POSE_FILTER_WINDOW - 1),
      reason: `${row.reason} 필터는 최대 ${POSE_FILTER_WINDOW - 1}프레임 늦습니다.`,
    };
  });
}

export function bodyLowerSpans(samples: readonly PoseFeatureSample[]): Array<{
  startSec: number;
  endSec: number;
  subjectId: string;
  videoId: string;
  evidence: 'knee_flex_2d';
  peakFlex: number;
}> {
  const spans: Array<{
    startSec: number;
    endSec: number;
    subjectId: string;
    videoId: string;
    evidence: 'knee_flex_2d';
    peakFlex: number;
  }> = [];
  let open: typeof spans[number] | null = null;
  for (const row of samples) {
    const flex = Math.max(row.kneeFlexL ?? -1, row.kneeFlexR ?? -1);
    if (flex >= 25) {
      if (!open || open.subjectId !== row.subjectId || row.tSec - open.endSec > POSE_FEATURE_GAP_SEC) {
        open = {
          startSec: row.tSec,
          endSec: row.tSec,
          subjectId: row.subjectId,
          videoId: row.videoId,
          evidence: 'knee_flex_2d',
          peakFlex: flex,
        };
        spans.push(open);
      } else {
        open.endSec = row.tSec;
        open.peakFlex = Math.max(open.peakFlex, flex);
      }
    }
  }
  return spans;
}
