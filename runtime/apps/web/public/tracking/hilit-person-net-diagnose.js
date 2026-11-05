/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·bff11c9c @license @preserve */
/* 브라우저 진단 패킷. 정본은 packages/hilit-vision/src/hilit-person-net-runtime.ts.

브라우저에 HilitPersonNet 가중치를 실지 않는다. 후보는 비우고
diagnose-only 계약만 남긴다. Tracking 상자를 바꾸지 않는다.
*/
export const PERSONNET_MODEL_ID = 'hilit-personnet';
export const PERSONNET_MODEL_VERSION = '0.0.0';
export const PERSONNET_PRODUCT_MODE = 'diagnose';

export function buildPersonNetDiagnoseResult(input = {}) {
  const mode = input.mode || PERSONNET_PRODUCT_MODE;
  const boxes = mode === 'off' ? [] : (input.boxes || []);
  const weightsPresent = input.weightsPresent === true;
  let candidateState = 'diagnose';
  if (!weightsPresent) candidateState = 'detector_absent';
  else if (!boxes.length) candidateState = 'no_candidate';
  else if (boxes.length > 1) candidateState = 'ambiguous';
  else candidateState = 'ask_user';
  return {
    boxes,
    scores: boxes.map((b) => b.score || 0),
    modelId: PERSONNET_MODEL_ID,
    modelVersion: PERSONNET_MODEL_VERSION,
    frameTimestamp: input.frameTimestamp || 0,
    inferenceMs: input.inferenceMs || 0,
    inputSize: input.inputSize || { width: 96, height: 160 },
    detectorMode: mode,
    rightsManifestHash: input.rightsManifestHash || null,
    identityConfirmed: false,
    eligibleForAutoReacquire: false,
    reason: input.reason || (weightsPresent ? candidateState : 'personnet-weights-not-shipped-in-browser'),
    candidateState,
    appliedToTracker: false,
    appearanceUpdateAllowed: false,
  };
}
