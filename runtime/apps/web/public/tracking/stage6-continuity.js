/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·347064d4 @license @preserve */
/**
 * 6단계 격리 실험. 제품 기본값은 꺼져 있다.
 *
 * 검출을 실제로 돌렸는데 상자 안에 사람이 없고, 상관필터는 여전히 확신하며,
 * 상자 이동이 카메라 이동으로 설명되면 배경 고착으로 센다.
 * 세 번이면 사용자에게 묻고, 그 사이 템플릿을 갱신하지 않는다.
 * 검출을 호출하지 않은 프레임은 사람 없음이 아니다.
 * 외형 점수만으로 다른 사람에게 붙이지 않는다.
 * 사용자가 고른 앵커만 확정한다. 잠정 관측은 앵커가 되지 않는다.
 * 다른 영상의 외형 상태는 쓰지 않는다.
 */

export const CONTINUITY_EXPERIMENT_DEFAULT = false;

export const CONTINUITY = Object.freeze({
  askAfter: 3,
  overlapMin: 0.3,
  scoreMin: 0.2,
  /** 상관필터가 아직 괜찮다고 하는 하한. 신원 확률이 아니다. */
  confidentMin: 0.55,
  /** 카메라 이동을 뺀 남은 이동이 몸 너비의 이 비율 이하면 배경과 같이 움직인 것이다. */
  residualMax: 0.15,
});

function overlap(a, b) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const area = Math.max(0, a.width) * Math.max(0, a.height) + Math.max(0, b.width) * Math.max(0, b.height) - inter;
  return area > 0 ? inter / area : 0;
}

/** 카메라 이동으로 설명이 되면 true, 모르면 null, 사람이 따로 움직이면 false. */
export function motionMatchesCamera(prev, next, camera, residualMax = CONTINUITY.residualMax) {
  if (!prev || !next || !camera || !(camera.confidence > 0)) return null;
  const dx = (next.x + next.width / 2) - (prev.x + prev.width / 2);
  const dy = (next.y + next.height / 2) - (prev.y + prev.height / 2);
  const rx = dx - (camera.dx || 0);
  const ry = dy - (camera.dy || 0);
  const body = Math.max(8, next.width);
  return Math.hypot(rx, ry) / body <= residualMax;
}

export function backgroundStickStep(state, input, options = {}) {
  const o = { ...CONTINUITY, ...options };
  const prev = state && Number.isFinite(state.run) ? state.run : 0;
  const keep = (reason, extra = {}) => ({
    run: prev, ask: false, learn: true, claimOk: true, reason, ...extra,
  });
  if (input?.experiment !== true) return keep('experiment-off');
  if (input.hits == null) return keep('detector-not-run');
  const box = input.box;
  const personInBox = box && input.hits.some((hit) => (hit.score ?? 0) >= o.scoreMin && overlap(box, hit) >= o.overlapMin);
  if (personInBox) return { run: 0, ask: false, learn: true, claimOk: true, reason: 'person-in-box' };
  const camera = motionMatchesCamera(input.prevBox, box, input.camera, o.residualMax);
  if (camera == null) return keep('gmc-unknown');
  if (camera !== true) return keep('subject-motion');
  if (!(input.trackerConfidence >= o.confidentMin)) return keep('tracker-not-confident');
  const run = prev + 1;
  const ask = run >= o.askAfter;
  return { run, ask, learn: false, claimOk: false, reason: 'background-stick' };
}

/** 단서가 둘 이상일 때만 상자를 옮긴다. 외형 하나만으로는 옮기지 않는다. */
export function reattachAllowed(cues) {
  if (cues?.experiment !== true) return { allow: true, reason: 'experiment-off' };
  const votes = [
    cues.personOverlap === true,
    cues.motionAgrees === true,
    cues.appearanceAgrees === true,
  ].filter(Boolean).length;
  if (cues.appearanceAgrees === true && votes === 1) return { allow: false, reason: 'appearance-alone' };
  if (votes >= 2) return { allow: true, reason: 'two-cues' };
  return { allow: false, reason: 'single-cue' };
}

/** 가림·배경 고착·잠정 관측에서는 템플릿을 갱신하지 않는다. */
export function templateUpdateAllowed(input) {
  if (input?.experiment !== true) return true;
  if (input.occluded === true || input.backgroundStick === true || input.provisional === true) return false;
  return true;
}

/** 사용자가 고른 앵커만 확정한다. */
export function promoteAnchor(sample) {
  if (sample?.userSelected === true) return { promote: true, reason: 'user-anchor' };
  return { promote: false, reason: 'not-user-anchor' };
}

/** 같은 영상·같은 대상이 끝나기 전에만 세션 기억을 쓴다. */
export function sessionMemoryAllows(record, current) {
  if (!record || !current) return false;
  if (current.ended === true) return false;
  if (record.videoId !== current.videoId) return false;
  if (record.subjectId !== current.subjectId) return false;
  return true;
}

/** 사용자가 그 영상에서 타인이라고 확인한 표본만 남긴다. */
export function canStoreNegative(sample) {
  return sample?.userConfirmedOther === true && sample.videoId === sample.boundVideoId && sample.ended !== true;
}
