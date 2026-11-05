/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·ab2d765d @license @preserve */
/* 시간 구간 동작 분석.

한 프레임으로 확정하지 않는다. 규칙이지 학습 모델이 아니다.
가림·추적 상실·신원 전환을 보간하지 않는다.
*/

import {
  ACTION_ANALYSIS_VERSION,
  ACTION_THRESHOLDS,
  type SupportedActionKind,
} from './action-catalog';
import { SUBJECT_JITTER_PX, SUBJECT_MIN_DT_SEC, type SubjectMotionStep } from './subject-motion';

export interface ActionSpan {
  spanId: string;
  videoId: string;
  subjectId: string;
  kind: SupportedActionKind;
  startSec: number;
  endSec: number;
  trackIds: string[];
  evidence: string[];
  identityStatus: 'ok' | 'uncertain';
  quality: 'ok' | 'approx' | 'hold';
  analyzerVersion: string;
  observation: {
    stepCount: number;
    meanSpeed: number | null;
    cameraUsable: boolean;
  };
  interpretation: string;
}

export type StepLabel = SupportedActionKind | 'break';

export function labelMotionStep(step: SubjectMotionStep): StepLabel {
  if (!step.identityOk || step.status === 'identity_hold') return 'identity_uncertain';
  if (step.status === 'gap_too_long' || step.status === 'invalid_dt' || step.status === 'box_unusable') {
    return 'break';
  }
  if (step.status === 'camera_unusable') {
    const raw = Math.hypot(step.rawDxPx ?? 0, step.rawDyPx ?? 0);
    return raw > SUBJECT_JITTER_PX ? 'hard_to_separate' : 'break';
  }
  const dt = Math.max(step.rawDtSec, SUBJECT_MIN_DT_SEC);
  if (step.cameraCompensatedDxPx != null && step.cameraCompensatedDyPx != null) {
    const speed = Math.hypot(step.cameraCompensatedDxPx, step.cameraCompensatedDyPx) / dt;
    if (speed >= ACTION_THRESHOLDS.moveSpeedPxPerSec) return 'subject_moving';
    if (speed <= ACTION_THRESHOLDS.stillSpeedPxPerSec) return 'subject_still_screen';
    return 'break';
  }
  if (step.status === 'jitter') return 'subject_still_screen';
  if (step.status === 'ok' && (step.screenSpeedPerSec ?? 0) >= ACTION_THRESHOLDS.moveSpeedPxPerSec) {
    return 'subject_moving';
  }
  return 'break';
}

function qualityOf(kind: SupportedActionKind): ActionSpan['quality'] {
  if (kind === 'hard_to_separate') return 'approx';
  if (kind === 'identity_uncertain') return 'hold';
  return 'ok';
}

function talk(kind: SupportedActionKind): string {
  if (kind === 'subject_moving') return '카메라 보정 뒤에도 박스가 움직인 구간입니다. 점프가 아닙니다.';
  if (kind === 'subject_still_screen') return '화면에서 박스가 거의 안 움직입니다. 휴식이 아닙니다.';
  if (kind === 'hard_to_separate') return '카메라 보정을 못 해 대상 이동과 가르지 못합니다.';
  return '신원이 불확실해 동작으로 확정하지 않습니다.';
}

export function buildActionSpans(steps: readonly SubjectMotionStep[]): ActionSpan[] {
  const sorted = [...steps].sort((a, b) => a.t0Sec - b.t0Sec || a.t1Sec - b.t1Sec);
  const out: ActionSpan[] = [];
  let open: {
    kind: SupportedActionKind;
    start: number;
    end: number;
    videoId: string;
    subjectId: string;
    n: number;
    speedSum: number;
    speedN: number;
    cameraUsable: boolean;
  } | null = null;
  let pendingKind: StepLabel | null = null;
  let pendingRun = 0;
  let pendingStart = 0;

  const close = () => {
    if (!open) return;
    if (open.end - open.start >= ACTION_THRESHOLDS.minSpanSec && open.n >= ACTION_THRESHOLDS.enterRun) {
      out.push({
        spanId: `span-${open.subjectId}-${open.start.toFixed(3)}-${open.kind}`,
        videoId: open.videoId,
        subjectId: open.subjectId,
        kind: open.kind,
        startSec: open.start,
        endSec: open.end,
        trackIds: [],
        evidence: [open.kind, ACTION_ANALYSIS_VERSION],
        identityStatus: open.kind === 'identity_uncertain' ? 'uncertain' : 'ok',
        quality: qualityOf(open.kind),
        analyzerVersion: ACTION_ANALYSIS_VERSION,
        observation: {
          stepCount: open.n,
          meanSpeed: open.speedN ? open.speedSum / open.speedN : null,
          cameraUsable: open.cameraUsable,
        },
        interpretation: talk(open.kind),
      });
    }
    open = null;
  };

  for (const step of sorted) {
    const label = labelMotionStep(step);
    if (open && (step.subjectId !== open.subjectId || step.videoId !== open.videoId)) close();
    if (open && step.t0Sec - open.end > ACTION_THRESHOLDS.mergeGapSec + 1e-6) close();

    if (label === 'break') {
      pendingKind = null;
      pendingRun = 0;
      close();
      continue;
    }

    if (open && label === open.kind) {
      open.end = step.t1Sec;
      open.n += 1;
      if (step.screenSpeedPerSec != null) {
        open.speedSum += step.screenSpeedPerSec;
        open.speedN += 1;
      }
      pendingKind = label;
      pendingRun = 0;
      continue;
    }

    if (open && label !== open.kind) {
      if (pendingKind === label) pendingRun += 1;
      else {
        pendingKind = label;
        pendingRun = 1;
        pendingStart = step.t0Sec;
      }
      if (pendingRun >= ACTION_THRESHOLDS.exitRun) {
        close();
        open = {
          kind: label,
          start: pendingStart,
          end: step.t1Sec,
          videoId: step.videoId,
          subjectId: step.subjectId,
          n: pendingRun,
          speedSum: step.screenSpeedPerSec ?? 0,
          speedN: step.screenSpeedPerSec != null ? 1 : 0,
          cameraUsable: step.cameraCompensatedDxPx != null,
        };
        pendingKind = null;
        pendingRun = 0;
      }
      continue;
    }

    if (!open) {
      if (pendingKind === label) pendingRun += 1;
      else {
        pendingKind = label;
        pendingRun = 1;
        pendingStart = step.t0Sec;
      }
      if (pendingRun >= ACTION_THRESHOLDS.enterRun) {
        open = {
          kind: label,
          start: pendingStart,
          end: step.t1Sec,
          videoId: step.videoId,
          subjectId: step.subjectId,
          n: pendingRun,
          speedSum: step.screenSpeedPerSec ?? 0,
          speedN: step.screenSpeedPerSec != null ? 1 : 0,
          cameraUsable: step.cameraCompensatedDxPx != null,
        };
        pendingKind = null;
        pendingRun = 0;
      }
    }
  }
  close();
  return out;
}
