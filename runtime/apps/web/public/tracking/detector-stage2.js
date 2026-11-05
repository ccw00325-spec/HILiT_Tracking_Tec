/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·67966140 @license @preserve */
/* 브라우저 런타임. 정본은 packages/hilit-vision 의
 * detector-schedule.ts · reacquire-evidence.ts · track-identity-report.ts.
 * 검출 후보와 동일인 확정을 한 칸에 넣지 않는다.
 * 이 단계 제품 경로는 상자를 자동으로 바꾸지 않는다.
 */

export const DETECTOR_INTERVAL_FRAMES = 8;
export const NEAR_PAD = 0.15;
export const REGION_PAD = 0.35;

export function padSearchRegion(box, frameW, frameH, pad = REGION_PAD) {
  const w = Math.min(frameW, Math.max(8, box.width * (1 + pad)));
  const h = Math.min(frameH, Math.max(8, box.height * (1 + pad)));
  return {
    x: Math.max(0, Math.min(frameW - w, box.x - box.width * pad / 2)),
    y: Math.max(0, Math.min(frameH - h, box.y - box.height * pad / 2)),
    width: w,
    height: h,
  };
}

export function planDetectorSearch(input) {
  const interval = input.intervalFrames ?? DETECTOR_INTERVAL_FRAMES;
  const widen = input.roiWiden ?? 1;
  const covPad = input.stdX != null && input.lastBox
    ? Math.max(NEAR_PAD, (2.2 * input.stdX * widen) / Math.max(8, input.lastBox.width))
    : NEAR_PAD * widen;
  const expandPad = input.stdY != null && input.lastBox
    ? Math.max(REGION_PAD, (3.2 * input.stdY * widen) / Math.max(8, input.lastBox.height))
    : REGION_PAD * widen;
  const small = input.subjectHeightPx != null && input.subjectHeightPx < 32;
  if (input.trigger === 'lost') {
    if (input.lastBox && input.frameW > 0 && input.frameH > 0) {
      return {
        run: true,
        scope: 'near-then-expand-then-full',
        near: padSearchRegion(input.lastBox, input.frameW, input.frameH, covPad),
        region: padSearchRegion(input.lastBox, input.frameW, input.frameH, expandPad),
        reason: small ? 'lost-near-expand-full-small' : 'lost-near-expand-full',
      };
    }
    return { run: true, scope: 'full', region: null, near: null, reason: 'lost-full' };
  }
  const need = input.trigger === 'degraded' ? Math.max(2, Math.floor(interval / 2)) : interval;
  if (input.framesSinceDetector < need) {
    return { run: false, scope: 'skip', region: null, near: null, reason: 'interval-wait' };
  }
  if (input.lastBox && (input.trigger === 'degraded' || small)) {
    return {
      run: true,
      scope: 'region-then-full',
      near: padSearchRegion(input.lastBox, input.frameW, input.frameH, covPad),
      region: padSearchRegion(input.lastBox, input.frameW, input.frameH, expandPad),
      reason: small ? 'interval-region-small' : `interval-${input.trigger}-region`,
    };
  }
  return { run: true, scope: 'full', region: null, near: null, reason: `interval-${input.trigger}` };
}

export function classifySearchState(input) {
  if (input.outcome === 'error' || input.outcome === 'unavailable' || input.outcome === 'cancelled') {
    return 'detect_failed';
  }
  if (input.outcome === 'empty' || input.proposalCount === 0) return 'detect_failed';
  if (input.decision.action === 'confirm') return 'identity_confirmed';
  if (input.decision.reason === 'not-unique' || String(input.decision.reason).startsWith('appearance-')) {
    return input.decision.reason === 'not-unique' ? 'target_candidate' : 'hold';
  }
  if (input.proposalCount >= 1) return 'person_detected';
  return 'detect_failed';
}

export function productMayApplyIdentity() {
  return false;
}

export function mayUpdateAppearanceMemory(input) {
  if (input.doubtOpen) return false;
  if (input.trackState !== 'ok') return false;
  if (
    input.identityState === 'needs_reselect'
    || input.identityState === 'identity_hold'
    || input.identityState === 'target_candidate'
    || input.identityState === 'detect_failed'
  ) return false;
  return true;
}

export function composeTrackReport(input) {
  const uncertain =
    input.identityState === 'identity_confirmed' && input.trackState === 'ok' ? 'low'
      : input.identityState === 'needs_reselect' || input.trackState === 'lost' ? 'high'
        : 'medium';
  return {
    videoId: input.videoId || null,
    subjectId: input.subjectId || null,
    timestampSec: input.timestampSec,
    box: input.box || null,
    coordSpace: 'source-pixels',
    trackState: input.trackState,
    identityState: input.identityState,
    failureCause: input.failureCause || 'unclassified',
    evidence: input.evidence || [],
    uncertainty: uncertain,
    mayConfirmHighlight: input.identityState === 'identity_confirmed' && input.trackState === 'ok',
  };
}

export function buildReacquireEvidence(input) {
  const identityState = classifySearchState({
    outcome: input.outcome,
    proposalCount: input.proposalCount,
    decision: input.decision,
  });
  return {
    proposalCount: input.proposalCount,
    searchScope: input.searchScope,
    gapSeconds: input.gapSeconds,
    motionErrorBodies: input.motionErrorBodies,
    appearanceSelf: input.appearanceSelf,
    appearanceDecision: input.appearanceDecision,
    uniqueMargin: input.uniqueMargin,
    detectorDecision: input.decision.action,
    detectorReason: input.decision.reason,
    identityState,
    appliedToTracker: false,
  };
}
