/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·6d864fd2 @license @preserve */
/* 브라우저 런타임. 정본은 packages/hilit-vision 의 identity-judge.ts.
 * 한 후보 점수만으로 동일인을 정하지 않는다.
 * 제품 경로는 상자를 자동으로 바꾸지 않는다.
 */

export const IDENTITY_ACCEPT = 0.62;
export const IDENTITY_MARGIN = 0.08;
export const MOTION_DECAY_GAP_SEC = 8;

export function fillProposalOthers(proposals) {
  return proposals.map((row, i) => {
    let other = null;
    proposals.forEach((peer, j) => {
      if (i === j || peer.appearanceSelf == null) return;
      if (other == null || peer.appearanceSelf > other) other = peer.appearanceSelf;
    });
    return { ...row, appearanceOther: other };
  });
}

export function pickBestByAppearance(proposals) {
  let best = null;
  let score = -1;
  for (const row of proposals) {
    const self = row.appearanceSelf;
    if (self == null) continue;
    if (self > score) {
      score = self;
      best = row;
    }
  }
  return best;
}

export function assignDetectionsUnique(rows) {
  const used = new Set();
  const out = [];
  const sorted = rows.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  for (const row of sorted) {
    if (row.decision !== 'accept' || !row.detectionId) {
      out.push({ ...row, detectionId: null, decision: row.decision === 'accept' ? 'hold' : row.decision });
      continue;
    }
    if (used.has(row.detectionId)) {
      out.push({ ...row, detectionId: null, decision: 'hold', reason: 'duplicate-subject-claim' });
      continue;
    }
    used.add(row.detectionId);
    out.push(row);
  }
  return out;
}
