/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·382abab8 @license @preserve */
/**
 * 3단계 격리 실험. 제품 기본값은 꺼져 있다.
 *
 * 상자가 화면 가장자리에 걸치고, 그 프레임에서 사람 검출을 실제로 돌렸는데
 * 아무도 없으면 ‘정상 추적’으로 두지 말고 사용자에게 묻는다.
 * 검출을 호출하지 않은 프레임(hits == null)은 대상 없음이 아니다.
 * 화면 한가운데에서 검출이 빈 것은 검출 누락일 수 있어 세지 않는다.
 * 겹치는 사람이 있으면 다른 사람에게 붙이지 않고 카운트만 끊는다.
 * 자동 재획득은 하지 않는다.
 */

export const EDGE_ABSENCE_EXPERIMENT_DEFAULT = false;

export const EDGE_ABSENCE = Object.freeze({
  visibleMax: 0.35,
  askAfter: 3,
  overlapMin: 0.3,
  scoreMin: 0.2,
});

function overlap(a, b) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const area = Math.max(0, a.width) * Math.max(0, a.height) + Math.max(0, b.width) * Math.max(0, b.height) - inter;
  return area > 0 ? inter / area : 0;
}

export function visibleFraction(box, frame) {
  if (!box || !frame || !(frame.width > 0) || !(frame.height > 0)) return 0;
  const x1 = Math.max(0, box.x);
  const y1 = Math.max(0, box.y);
  const x2 = Math.min(frame.width, box.x + box.width);
  const y2 = Math.min(frame.height, box.y + box.height);
  const area = Math.max(0, box.width) * Math.max(0, box.height);
  if (!(area > 0)) return 0;
  return (Math.max(0, x2 - x1) * Math.max(0, y2 - y1)) / area;
}

export function edgeAbsenceStep(state, input, options = {}) {
  const o = { ...EDGE_ABSENCE, ...options };
  const prev = state && Number.isFinite(state.run) ? state.run : 0;
  if (input?.experiment !== true) return { run: prev, ask: false, reason: 'experiment-off' };
  if (input.hits == null) return { run: prev, ask: false, reason: 'detector-not-run' };
  const box = input.box;
  const personInBox = box && input.hits.some((hit) => (hit.score ?? 1) >= o.scoreMin && overlap(box, hit) >= o.overlapMin);
  if (personInBox) return { run: 0, ask: false, reason: 'person-in-box' };
  const empty = input.hits.length === 0;
  const visible = visibleFraction(box, input.frame);
  if (empty && visible < o.visibleMax) {
    const run = prev + 1;
    return { run, ask: run >= o.askAfter, reason: 'edge-empty' };
  }
  return { run: prev, ask: false, reason: empty ? 'detector-miss-inside' : 'others-present' };
}

/** 미리보기와 내보내기 구도가 같은지. 길이가 다르면 불일치. */
export function compositionMatches(preview, exported, eps = 0.02) {
  if (!Array.isArray(preview) || !Array.isArray(exported) || preview.length !== exported.length) return false;
  return preview.every((row, index) => {
    const other = exported[index];
    return other
      && Math.abs(row.x - other.x) <= eps
      && Math.abs(row.y - other.y) <= eps
      && Math.abs(row.width - other.width) <= eps
      && Math.abs(row.height - other.height) <= eps;
  });
}
