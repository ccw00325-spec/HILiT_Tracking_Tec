/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e3224967 @license @preserve */
/* HilitPersonNet 런타임 패킷.

이번 단계는 diagnose-only다. 후보가 Tracking 상자를 바꾸지 않는다.
identityConfirmed와 eligibleForAutoReacquire는 항상 false다.
correct·reacquire를 제품 기본값으로 켜지 않는다.
*/

import {
  PERSONNET_IN_H,
  PERSONNET_IN_W,
  PERSONNET_MODEL_ID,
  PERSONNET_MODEL_VERSION,
  inferPersonNet,
  type PersonNetBox,
  type PersonNetWeights,
} from './hilit-person-net';
import {
  decideDetectorReacquire,
  productDetectorMode,
  type DetectorMode,
} from './detector-reacquire';
import { mayUpdateAppearanceMemory } from './track-identity-report';

export type PersonNetRuntimeMode = 'off' | 'diagnose' | 'assist';

export const PERSONNET_PRODUCT_MODE: PersonNetRuntimeMode = 'diagnose';
export const PERSONNET_AUTO_APPLY = false;

export interface PersonNetDetectResult {
  boxes: PersonNetBox[];
  scores: number[];
  modelId: string;
  modelVersion: string;
  frameTimestamp: number;
  inferenceMs: number;
  inputSize: { width: number; height: number };
  detectorMode: PersonNetRuntimeMode;
  rightsManifestHash: string | null;
  identityConfirmed: false;
  eligibleForAutoReacquire: false;
  reason: string;
  candidateState: 'detector_absent' | 'no_candidate' | 'ambiguous' | 'ask_user' | 'diagnose';
  appliedToTracker: false;
  appearanceUpdateAllowed: false;
}

export function productPersonNetMode(): PersonNetRuntimeMode {
  return PERSONNET_PRODUCT_MODE;
}

export function candidateStateFromBoxes(
  boxes: readonly PersonNetBox[],
  weightsPresent: boolean,
  mode: PersonNetRuntimeMode,
): PersonNetDetectResult['candidateState'] {
  if (mode === 'off') return 'diagnose';
  if (!weightsPresent) return 'detector_absent';
  if (boxes.length === 0) return 'no_candidate';
  if (boxes.length > 1) return 'ambiguous';
  return 'ask_user';
}

export function buildPersonNetDetectResult(input: {
  boxes?: PersonNetBox[];
  mode?: PersonNetRuntimeMode;
  frameTimestamp?: number;
  inferenceMs?: number;
  inputSize?: { width: number; height: number };
  rightsManifestHash?: string | null;
  weightsPresent?: boolean;
  reason?: string;
}): PersonNetDetectResult {
  const mode = input.mode ?? PERSONNET_PRODUCT_MODE;
  const boxes = mode === 'off' ? [] : (input.boxes ?? []);
  const weightsPresent = input.weightsPresent ?? false;
  const state = candidateStateFromBoxes(boxes, weightsPresent, mode);
  const reason = input.reason
    ?? (mode === 'off'
      ? 'mode-off'
      : state === 'detector_absent'
        ? 'personnet-weights-absent'
        : state === 'no_candidate'
          ? 'no_candidate'
          : state === 'ambiguous'
            ? 'ambiguous'
            : 'ask_user');
  return {
    boxes,
    scores: boxes.map((b) => b.score),
    modelId: PERSONNET_MODEL_ID,
    modelVersion: PERSONNET_MODEL_VERSION,
    frameTimestamp: input.frameTimestamp ?? 0,
    inferenceMs: input.inferenceMs ?? 0,
    inputSize: input.inputSize ?? { width: PERSONNET_IN_W, height: PERSONNET_IN_H },
    detectorMode: mode,
    rightsManifestHash: input.rightsManifestHash ?? null,
    identityConfirmed: false,
    eligibleForAutoReacquire: false,
    reason,
    candidateState: state,
    appliedToTracker: false,
    appearanceUpdateAllowed: false,
  };
}

export function runPersonNetDiagnose(input: {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  weights?: PersonNetWeights | null;
  mode?: PersonNetRuntimeMode;
  frameTimestamp?: number;
  rightsManifestHash?: string | null;
}): PersonNetDetectResult {
  const mode = input.mode ?? PERSONNET_PRODUCT_MODE;
  if (mode === 'off') {
    return buildPersonNetDetectResult({
      mode,
      frameTimestamp: input.frameTimestamp,
      rightsManifestHash: input.rightsManifestHash,
      weightsPresent: Boolean(input.weights),
    });
  }
  if (!input.weights) {
    return buildPersonNetDetectResult({
      mode,
      frameTimestamp: input.frameTimestamp,
      rightsManifestHash: input.rightsManifestHash,
      weightsPresent: false,
      inputSize: { width: input.width, height: input.height },
    });
  }
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const inferred = inferPersonNet(input.rgba, input.width, input.height, input.weights);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return buildPersonNetDetectResult({
    boxes: inferred.boxes,
    mode,
    frameTimestamp: input.frameTimestamp,
    inferenceMs: t1 - t0,
    inputSize: { width: input.weights.inW, height: input.weights.inH },
    rightsManifestHash: input.rightsManifestHash,
    weightsPresent: true,
  });
}

export function decidePersonNetTrackingLink(input: {
  result: PersonNetDetectResult;
  detectorMode?: DetectorMode;
  appearanceDecision?: 'accept' | 'reject' | 'hold';
}): {
  appliedToTracker: false;
  appearanceUpdateAllowed: false;
  action: 'diagnose_only' | 'ask_user';
  identityConfirmed: false;
  eligibleForAutoReacquire: false;
  reason: string;
} {
  const mode = input.detectorMode ?? productDetectorMode(false);
  const decision = decideDetectorReacquire({
    mode,
    proposals: input.result.boxes.map((box) => ({
      detectorScore: box.score,
      appearanceSelf: null,
      appearanceOther: null,
      motionErrorBodies: 99,
    })),
    appearanceDecision: input.appearanceDecision ?? 'hold',
    gapSeconds: 0,
    uniqueMargin: 0,
  });
  mayUpdateAppearanceMemory({
    trackState: 'searching',
    identityState: 'identity_hold',
    doubtOpen: true,
  });
  return {
    appliedToTracker: false,
    appearanceUpdateAllowed: false,
    action: decision.action === 'confirm' ? 'ask_user' : (decision.action === 'ask_user' ? 'ask_user' : 'diagnose_only'),
    identityConfirmed: false,
    eligibleForAutoReacquire: false,
    reason: `${decision.reason}|personnet-diagnose-only`,
  };
}
