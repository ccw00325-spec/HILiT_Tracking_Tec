/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·46da3431 @license @preserve */
/* 전역 Tracklet 연결.

같이 보인 궤적은 다른 사람이다. 다만 이 규칙을 현재 추적 상자에
바로 적용하면 수율이 무너진 적이 있다(패치노트 0.30). 검출이 드물면
번호가 한 번 잘못 매이고, 진짜 대상이 "남"이 된다.

그래서 이 층은 **옆 사람으로 점프하는 것만** 막는다.
- 지금 자리를 유지하는 연속 추적은 막지 않는다
- 궤적 히트가 부족한 번호는 증거로 쓰지 않는다
- 검출이 한 명뿐이면 전역 연결을 갱신하지 않는다
- 동일인을 확정하거나 자동 재획득을 켜지 않는다
*/

import { applyAffineToBox, type Affine2D, IDENTITY_AFFINE } from './affine-gmc';
import { TrackletStore, type TrackletBox } from './tracklets';

export const TRACKLET_MIN_HITS = 3;
export const TRACKLET_SWITCH_BODIES = 0.8;
export const TRACKLET_BIND_IOU = 0.35;

export type TrackletSwitchAction = 'continue' | 'hold' | 'block-switch';

export interface TrackletSwitchDecision {
  action: TrackletSwitchAction;
  reason: string;
  subjectTrackletId: number | null;
  candidateTrackletId: number | null;
  identityConfirmed: false;
  eligibleForAutoReacquire: false;
}

export class TrackletGraph {
  readonly store = new TrackletStore();
  subjectId: number | null = null;

  clear(): void {
    this.subjectId = null;
  }

  /**
   * 검출이 두 개 이상일 때만 궤적을 잇는다.
   * 한 개면 번호를 맬 경쟁 증거가 없어 과거 실패가 재현된다.
   */
  update(input: {
    t: number;
    detections: ReadonlyArray<TrackletBox>;
    affine?: Affine2D | null;
    subject?: TrackletBox | null;
  }): number[] {
    const dets = input.detections.filter((b) => b.width > 4 && b.height > 4);
    if (dets.length < 2) return [];
    const A = input.affine && Number.isFinite(input.affine.a) ? input.affine : null;
    const assigned = this.store.update({
      t: input.t,
      detections: dets,
      cameraWarp: A,
    });
    if (input.subject) this.bindSubject(input.subject);
    return assigned;
  }

  bindSubject(box: TrackletBox): number | null {
    const hit = this.store.bind(box, TRACKLET_BIND_IOU);
    if (!hit || hit.hits < 2) return this.subjectId;
    this.subjectId = hit.id;
    return hit.id;
  }

  decideSwitch(candidate: TrackletBox): TrackletSwitchDecision {
    const none = (reason: string): TrackletSwitchDecision => ({
      action: 'continue',
      reason,
      subjectTrackletId: this.subjectId,
      candidateTrackletId: null,
      identityConfirmed: false,
      eligibleForAutoReacquire: false,
    });
    const mine = this.store.find(this.subjectId);
    if (!mine || mine.hits < TRACKLET_MIN_HITS) return none('subject-tracklet-unready');
    const other = this.store.bind(candidate, TRACKLET_BIND_IOU);
    if (!other) return none('candidate-unbound');
    if (other.id === mine.id) return none('same-tracklet');
    if (other.hits < TRACKLET_MIN_HITS) return none('candidate-tracklet-unready');
    const body = Math.max(8, mine.box.width);
    const dx = (candidate.x + candidate.width / 2) - (mine.box.x + mine.box.width / 2);
    const dy = (candidate.y + candidate.height / 2) - (mine.box.y + mine.box.height / 2);
    if (Math.hypot(dx, dy) < TRACKLET_SWITCH_BODIES * body) {
      return none('near-current-box');
    }
    if (!this.store.coVisible(other.id, mine.id, 1.5)) {
      return {
        action: 'hold',
        reason: 'different-tracklet-not-covisible',
        subjectTrackletId: mine.id,
        candidateTrackletId: other.id,
        identityConfirmed: false,
        eligibleForAutoReacquire: false,
      };
    }
    return {
      action: 'block-switch',
      reason: 'co-visible-other-person',
      subjectTrackletId: mine.id,
      candidateTrackletId: other.id,
      identityConfirmed: false,
      eligibleForAutoReacquire: false,
    };
  }
}

export function compensateDetections(
  boxes: readonly TrackletBox[],
  affine: Affine2D | null,
): TrackletBox[] {
  if (!affine) return boxes.map((b) => ({ ...b }));
  if (affine.a === 1 && affine.b === 0 && affine.c === 0 && affine.d === 1
      && affine.tx === 0 && affine.ty === 0) {
    return boxes.map((b) => ({ ...b }));
  }
  return boxes.map((b) => applyAffineToBox(b, affine));
}

export { IDENTITY_AFFINE };
