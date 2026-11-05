// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 추적 결과 채점. 합성 장면과 실제 영상 평가가 같은 정의를 쓴다.

export function iou(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

const LOST = new Set(['TARGET_LOST', 'lost', 'LOST', 'OCCLUDED', 'USER_CONFIRMATION']);

/**
 * rows: [{ t, box, state }]. truth(t) → { target: {box, visible}, others: [box] }.
 * 대상이 보인다 = visible ≥ 0.5, 가려졌다 = visible < 0.1.
 *   hit: 보이는 구간에서 정상 표시 상자가 정답과 IoU 0.5 이상
 *   wrong: 정상 표시인데 다른 사람에게 가 있음
 *   lostVisible: 보이는데 놓침으로 표시 (틀리지는 않았음)
 *   hiddenClaim: 대상이 가려졌는데 정상 표시
 *   switches: 대상에서 다른 사람으로 넘어간 횟수
 *   recoverySec: 가림이 끝난 뒤 다시 정답을 잡기까지 걸린 평균 시간
 */
export function scoreTrack(rows, truth) {
  let visible = 0, hit = 0, wrong = 0, lostVisible = 0, hidden = 0, hiddenClaim = 0, switches = 0;
  let last = 'none';
  let hiddenEnd = null;
  let wasHidden = false;
  const recoveries = [];
  for (const row of rows) {
    const gt = truth(row.t);
    const ok = !LOST.has(row.state) && row.box && row.box.width > 1;
    const v = gt.target.visible;
    const onTarget = ok && iou(row.box, gt.target.box) >= 0.5;
    const onOther = ok && !onTarget && gt.others.some((b) => iou(row.box, b) >= 0.5);
    if (v >= 0.5) {
      visible += 1;
      if (onTarget) hit += 1;
      if (!ok) lostVisible += 1;
      if (onOther) wrong += 1;
      if (wasHidden) { hiddenEnd = row.t; wasHidden = false; }
      if (hiddenEnd !== null && onTarget) { recoveries.push(row.t - hiddenEnd); hiddenEnd = null; }
    } else if (v < 0.1) {
      hidden += 1;
      wasHidden = true;
      if (ok) hiddenClaim += 1;
    }
    const now = onTarget ? 'target' : onOther ? 'other' : last;
    if (last === 'target' && now === 'other') switches += 1;
    last = now;
  }
  const rate = (a, b) => (b ? a / b : null);
  return {
    frames: rows.length,
    visibleFrames: visible,
    hiddenFrames: hidden,
    hitRate: rate(hit, visible),
    wrongRate: rate(wrong, visible),
    lostVisibleRate: rate(lostVisible, visible),
    hiddenClaimRate: rate(hiddenClaim, hidden),
    switches,
    recoverySec: recoveries.length ? recoveries.reduce((s, x) => s + x, 0) / recoveries.length : null,
    unrecovered: hiddenEnd !== null ? 1 : 0,
  };
}
