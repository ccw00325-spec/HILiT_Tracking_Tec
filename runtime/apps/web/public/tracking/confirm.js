/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·2d3a3a81 @license @preserve */
/* 사용자가 그린 상자와 사람 후보가 겹치는지 본다.
 *
 * 후보는 조언이다. 본인인지를 확정하지 않는다. 상자를 자동으로
 * 바꾸지 않는다(앵커 오염 방지).
 */
import { HilitPersonDetector, boxIou } from './hilit-person-detector.js';

export const CONFIRM_DISABLED_REASON = 'detector-removed';

function pixelBox(target, width, height) {
  return {
    x: target.x * width,
    y: target.y * height,
    width: (target.width ?? target.w) * width,
    height: (target.height ?? target.h) * height,
  };
}

/**
 * @returns {Promise<{verdict, message, detail, reason, others:number}>}
 */
export async function confirmTarget(video, target) {
  if (!video || !target) {
    return {
      verdict: 'unavailable',
      reason: 'no-frame',
      message: '지금은 확인을 건너뜁니다.',
      detail: '화면을 아직 읽지 못했습니다. 선택하신 그대로 추적합니다.',
      others: 0,
    };
  }
  let det;
  try {
    det = await HilitPersonDetector.load();
  } catch {
    return {
      verdict: 'unavailable',
      reason: CONFIRM_DISABLED_REASON,
      message: '지금은 확인을 건너뜁니다.',
      detail: '사람 후보를 만드는 기능이 열리지 않았습니다. 선택하신 그대로 추적합니다.',
      others: 0,
    };
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1;
    canvas.height = video.videoHeight || 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const run = det.proposeFromCanvas(canvas, { timestamp: video.currentTime || 0 });
    if (run.availability !== 'ready') {
      return {
        verdict: 'unavailable',
        reason: run.reason || CONFIRM_DISABLED_REASON,
        message: '지금은 확인을 건너뜁니다.',
        detail: '사람 후보를 만들지 못했습니다. 선택하신 그대로 추적하고, 놓치면 다시 지정해 달라고 알려 드립니다.',
        others: 0,
      };
    }
    const user = pixelBox(target, canvas.width, canvas.height);
    const hits = run.proposals || [];
    if (!hits.length) {
      return {
        verdict: 'none',
        reason: run.outcome,
        message: '이 장면에서 사람 후보를 찾지 못했습니다.',
        detail: '직접 그린 상자로 진행합니다. 후보가 없다고 해서 사람이 없는 것은 아닙니다. 점수는 본인 여부가 아닙니다.',
        others: 0,
      };
    }
    let best = 0, bestIou = 0;
    hits.forEach((p, i) => {
      const iou = boxIou(user, p);
      if (iou > bestIou) { bestIou = iou; best = i; }
    });
    if (bestIou >= 0.45) {
      return {
        verdict: 'confirmed',
        reason: 'geometry-overlap',
        message: '그린 상자가 사람 후보와 겹칩니다.',
        detail: '겹친다는 것은 상자 자리 이야기입니다. 그 후보가 본인인지는 직접 확인하세요. 점수는 동일인 확률이 아닙니다.',
        others: Math.max(0, hits.length - 1),
        iou: bestIou,
        candidateId: hits[best].candidateId,
      };
    }
    return {
      verdict: 'elsewhere',
      reason: 'proposal-elsewhere',
      message: '다른 자리에 사람 후보가 있습니다.',
      detail: '원하시면 직접 다시 감싸 주세요. 후보를 자동으로 본인으로 바꾸지 않습니다.',
      others: hits.length,
    };
  } catch (err) {
    return {
      verdict: 'unavailable',
      reason: 'detector-error',
      message: '지금은 확인을 건너뜁니다.',
      detail: err instanceof Error ? err.message : String(err),
      others: 0,
    };
  }
}
