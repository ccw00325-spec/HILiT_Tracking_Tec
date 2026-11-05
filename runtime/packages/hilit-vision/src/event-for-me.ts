/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·5d4bf96f @license @preserve */
/* EventForMe — 내 선수의 사건만 하이라이트 후보로 올린다.

전역 화면 흔들림은 점수가 아니다. 대상 속도가 없으면 0이다.
겹침이 크거나 신원이 불확실하면 깎는다. 등번호가 읽힌 순간은
조금만 보탠다. 동일인 확정이 아니다.
*/

export interface EventForMeInput {
  subjectSpeed?: number | null;
  subjectAccel?: number | null;
  directionChange?: number | null;
  sizeChange?: number | null;
  trackingHealth?: number | null;
  overlapOthers?: number | null;
  jerseyReadable?: boolean | null;
  cameraShake?: number | null;
  identityHold?: boolean | null;
}

export function scoreEventForMe(input: EventForMeInput): {
  score: number;
  reason: string[];
  usedGlobalShake: false;
} {
  const speed = clamp01(input.subjectSpeed);
  if (speed == null && input.subjectAccel == null) {
    return { score: 0, reason: ['no-subject-motion'], usedGlobalShake: false };
  }
  const accel = clamp01(input.subjectAccel) ?? 0;
  const dir = clamp01(input.directionChange) ?? 0;
  const size = clamp01(input.sizeChange) ?? 0;
  const health = clamp01(input.trackingHealth) ?? 0.4;
  let raw = (speed ?? 0) * 0.36 + accel * 0.28 + dir * 0.18 + size * 0.10;
  if (input.jerseyReadable) raw += 0.08;
  const overlap = clamp01(input.overlapOthers) ?? 0;
  raw *= 1 - 0.45 * overlap;
  if (input.identityHold) raw *= 0.35;
  raw *= 0.55 + 0.45 * health;
  if ((input.cameraShake ?? 0) > 0.55 && (speed ?? 0) < 0.12) raw *= 0.25;
  const score = Math.max(0, Math.min(1, raw));
  const reason: string[] = [];
  if ((speed ?? 0) > 0.45) reason.push('subject-fast');
  if (accel > 0.45) reason.push('subject-accel');
  if (dir > 0.45) reason.push('subject-turn');
  if (input.jerseyReadable) reason.push('jersey-readable');
  if (overlap > OCCLUSION_MARK) reason.push('overlap-penalized');
  if (!reason.length) reason.push('subject-motion');
  return { score, reason: reason.slice(0, 3), usedGlobalShake: false };
}

const OCCLUSION_MARK = 0.22;

function clamp01(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}
