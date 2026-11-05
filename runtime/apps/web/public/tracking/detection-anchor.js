/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e44f64df @license @preserve */
/* 추적 중 사람 검출로 상자를 바로잡는다 — 2026-09-28 추적 이탈 연구.
 *
 * ## 왜
 *
 * 실사 22편 + 빙상장 1편(정답 173곳)에서 추적 상자와 정답의 IoU 가 0.3 미만인 곳이 53곳이었다.
 * 그중 20곳은 상태가 TRACKING_OK 였다(틀린 정상). 대부분 사람에게서 배경으로 **천천히 미끄러진** 경우다 —
 * 처음 몇 초는 IoU 0.8 → 0.5 → 0.2 로 내려가고, 그 뒤로는 배경에 붙어 끝까지 간다.
 * 상관필터가 매 프레임 조금씩 배우므로, 조금 밀린 자리를 배우고 그 자리에서 또 조금 밀린다.
 *
 * ## 무엇을
 *
 * 0.5초(영상 시간)마다 사람 검출기(부르는 쪽이 넣어 준다 — 제품은 MediaPipe 작업자)로 그 프레임의 사람 상자를 얻고,
 * 추적 상자와 **이미 겹치는** 사람이 하나로 분명하면 상자를 그 사람 쪽으로 당기고 추적기를 그 자리에서 다시 배우게 한다.
 *
 * ## 이것이 아닌 것
 *
 * - 재획득이 아니다. 추적 상자와 겹치지 않는 사람으로는 절대 옮기지 않는다(자동 재획득은 사용자 결정 전까지 끈다).
 * - 동일인 판정이 아니다. 겹치는 사람이 둘 이상 비슷하면 손대지 않는다. 검출 점수는 "사람처럼 보이는 정도" 다.
 */

export const DETECTION_ANCHOR = Object.freeze({
  /** 영상 시간 기준 간격(초). 벽시계를 쓰지 않는다 — 같은 영상이면 같은 프레임에서 부른다. */
  intervalSec: 0.5,
  /* 0.3 이면 실사 001752650 에서 그 사람이 탐침 39번 중 21번 빠졌다(점수 0.23~0.28). 0.2 로 받고, 대신 모호·크기·안에 든 한 사람 규칙이 거른다. */
  scoreMin: 0.2,
  /** 추적 상자와 이만큼 겹쳐야 "지금 따라가는 그 사람" 으로 본다. */
  iouMin: 0.3,
  /** 가장 잘 겹치는 사람이 두 번째보다 이만큼 더 겹쳐야 받는다. */
  ambiguity: 0.15,
  /** 검출 상자 높이 / 추적 상자 높이 허용 범위. 몸 일부·여러 사람 묶음을 거른다. */
  heightRatioMin: 0.6,
  heightRatioMax: 1.7,
  /** 받은 상자 쪽으로 얼마나 당길지. */
  blend: 0.7,
  /** 이미 이만큼 맞으면 건드리지 않는다(검출 상자의 흔들림을 추적에 넣지 않는다). */
  iouGood: 0.85,
  /* 상자 안에 든 사람 — 사람이 멀어져 작아졌는데 상자는 처음 크기로 남은 경우(실사 001752650: 몸 높이 474→176px,
   * 상자 510px 고정). IoU 로는 0.1 도 안 나와 위 규칙이 잡지 못한다. 사람 상자의 이만큼이 추적 상자 안이고, */
  containMin: 0.8,
  /* 그 사람 높이가 추적 상자 높이의 이 비율 이상이며, 상자 안에 든 사람이 딱 한 명일 때만 받는다. */
  containHeightMin: 0.25,
  /* 「다른 자리에 사람이 있다」로 셀 검출 점수 하한. 헛검출로 묻지 않게 받는 문턱(0.2)보다 높다. */
  elsewhereScoreMin: 0.35,
  /* 그런 탐침이 이만큼 이어지면(0.5초 × 3) 사용자에게 묻는다. 검출을 못 한 탐침은 세지도 끊지도 않는다. */
  askAfterMisses: 3,
  /* 그 전에 검출기가 추적 상자의 사람을 이만큼 확인했어야 한다(검출기가 못 보는 대상에게는 묻지 않는다). */
  seenBeforeAsk: 3,
  /* 가로지름 확인(2026-09-29, 사용자 영상 rink-10s 10초) — 앞선 두 탐침에서 받은 사람의 움직임으로 지금 자리를 내다본다.
   * 받으려는 사람이 그 자리에서 몸 너비의 crossFarBodies 배 넘게 떨어져 있고, */
  crossFarBodies: 0.6,
  /* 다른 분명한 사람이 그 자리 crossNearBodies 배 안에(그리고 받으려는 사람보다 절반 이하 거리에) 있으면 옮기지 않고 묻는다. */
  crossNearBodies: 0.35,
  crossOtherScoreMin: 0.3,
  /* 내다보기에 쓰는 두 탐침 사이 · 마지막 탐침에서 지금까지 허용 간격(초). 길면 움직임을 모른다고 보고 재지 않는다. */
  crossMinGapSec: 0.3,
  crossMaxGapSec: 1.1,
});

function containment(outer, inner) {
  const w = Math.max(0, Math.min(outer.x + outer.width, inner.x + inner.width) - Math.max(outer.x, inner.x));
  const h = Math.max(0, Math.min(outer.y + outer.height, inner.y + inner.height) - Math.max(outer.y, inner.y));
  const a = inner.width * inner.height;
  return a > 0 ? (w * h) / a : 0;
}

function pull(trackBox, target, k) {
  const cx = (trackBox.x + trackBox.width / 2) * (1 - k) + (target.x + target.width / 2) * k;
  const cy = (trackBox.y + trackBox.height / 2) * (1 - k) + (target.y + target.height / 2) * k;
  const w = trackBox.width * (1 - k) + target.width * k;
  const h = trackBox.height * (1 - k) + target.height * k;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

function insideDecision(trackBox, people, bestIou, o) {
  const inside = people.filter((p) => containment(trackBox, p) >= o.containMin
    && p.height >= o.containHeightMin * trackBox.height);
  if (inside.length > 1) return { action: 'keep', reason: 'ambiguous', iou: bestIou };
  if (inside.length !== 1) return null;
  const one = inside[0];
  /* 상자에 걸친 다른 사람이 있으면 어느 쪽인지 모른다. */
  if (people.some((p) => p !== one && boxIou(trackBox, p) >= 0.15)) return { action: 'keep', reason: 'ambiguous', iou: bestIou };
  return { action: 'correct', box: pull(trackBox, one, o.blend), iou: bestIou, score: one.score, via: 'inside', hit: one };
}

export function boxIou(a, b) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 한 프레임의 판단. 좌표는 모두 같은 캔버스 화소.
 * @returns {{ action: 'correct', box, iou, score } | { action: 'keep', reason: string, iou?: number }}
 */
export function anchorDecision(trackBox, hits, options = {}) {
  const o = { ...DETECTION_ANCHOR, ...options };
  if (!trackBox || !(trackBox.width > 2 && trackBox.height > 2)) return { action: 'keep', reason: 'no-box' };
  const people = (hits || []).filter((h) => h && h.score >= o.scoreMin && h.width > 2 && h.height > 2);
  if (!people.length) return { action: 'keep', reason: 'no-person' };
  const scored = people.map((p) => ({ p, iou: boxIou(trackBox, p) })).sort((a, b) => b.iou - a.iou);
  const best = scored[0];
  if (best.iou < o.iouMin) {
    return insideDecision(trackBox, people, best.iou, o) ?? { action: 'keep', reason: 'no-overlap', iou: best.iou };
  }
  if (scored[1] && best.iou - scored[1].iou < o.ambiguity) return { action: 'keep', reason: 'ambiguous', iou: best.iou };
  const ratio = best.p.height / trackBox.height;
  if (ratio > o.heightRatioMax) return { action: 'keep', reason: 'size', iou: best.iou };
  if (ratio < o.heightRatioMin) {
    /* 작아진 사람이 상자 안에 들어 있으면 아래 「안에 든 한 사람」 규칙으로 본다. */
    return insideDecision(trackBox, people, best.iou, o) ?? { action: 'keep', reason: 'size', iou: best.iou };
  }
  if (best.iou >= o.iouGood) return { action: 'keep', reason: 'already-good', iou: best.iou, hit: best.p };
  return { action: 'correct', box: pull(trackBox, best.p, o.blend), iou: best.iou, score: best.p.score, via: 'overlap', hit: best.p };
}

/**
 * 받아들인 사람 자리를 기억한다(가로지름 확인용). 최근 세 개만 둔다. 영상 한 편 · 추적 한 번 안에서만 산다.
 * @param {Array<{t:number,cx:number,cy:number}>} trail
 */
export function rememberAnchorMatch(trail, t, hit) {
  if (!hit || !Number.isFinite(t)) return trail;
  trail.push({ t, cx: hit.x + hit.width / 2, cy: hit.y + hit.height / 2 });
  while (trail.length > 3) trail.shift();
  return trail;
}

/** 앞선 두 탐침의 움직임으로 t 의 사람 중심을 내다본다. 간격이 맞지 않으면 null(모른다). */
export function predictAnchorCentre(trail, t, options = {}) {
  const o = { ...DETECTION_ANCHOR, ...options };
  if (!trail || trail.length < 2) return null;
  const a = trail[trail.length - 2], b = trail[trail.length - 1];
  const gap = b.t - a.t, ahead = t - b.t;
  if (!(gap >= o.crossMinGapSec && gap <= o.crossMaxGapSec) || !(ahead > 0 && ahead <= o.crossMaxGapSec)) return null;
  return { x: b.cx + (b.cx - a.cx) / gap * ahead, y: b.cy + (b.cy - a.cy) / gap * ahead };
}

/**
 * 가로지름 확인 — 두 사람이 겹쳐 지나갈 때 상자가 **가만히 있던 옆 사람**에 남는 것을 잡는다(2026-09-29).
 *
 * 사용자 영상(빙상장, 10초): 대상이 왼쪽으로 달리며 서 있던 사람 앞을 지나갔다. 상관필터는 서 있는 사람에 남았고,
 * 0.5초 탐침은 상자와 가장 많이 겹치는 그 사람을 「지금 따라가는 사람」으로 받아 상자를 당기고 다시 배웠다. 대상은
 * 앞선 탐침의 움직임으로 내다본 자리에 그대로 보였다(몸 너비 0.07배). 겹침(IoU)만 보면 틀린 사람을 고르게 된다.
 *
 * 받으려는 사람이 내다본 자리에서 멀고(crossFarBodies), 다른 분명한 사람이 그 자리에 있으면(crossNearBodies)
 * 둘 중 누가 대상인지 이 신호로는 가를 수 없다 — 옮기지도, 그 사람으로 다시 배우지도 않고 묻는다(kind 'conflict').
 * 멀기만 하고 내다본 자리에 다른 사람이 안 보이면(두 사람이 겹쳐 한 상자로 잡힌 순간 등) 판단을 한 번 미룬다(kind 'far'):
 * 그 자리를 움직임 기록에 넣지 않고, 다음 탐침에서 **예전 움직임**으로 다시 본다. 두 번 이어 멀면 대상이 멈췄다고 보고 받아들인다.
 * 내다본 자리의 사람으로 옮기지 않는다(재획득이 아니다). 검출 점수는 동일인 확률이 아니다.
 *
 * @returns {null | { kind: 'conflict' | 'far', predicted: {x:number,y:number}, chosenBodies: number, otherBodies: number | null }}
 */
export function crossingConflict(trail, t, decision, hits, trackBox, options = {}) {
  const o = { ...DETECTION_ANCHOR, ...options };
  const chosen = decision && (decision.action === 'correct' || decision.reason === 'already-good') ? decision.hit : null;
  if (!chosen || !trackBox) return null;
  const pred = predictAnchorCentre(trail, t, o);
  if (!pred) return null;
  const body = Math.max(8, trackBox.width);
  const dist = (h) => Math.hypot(h.x + h.width / 2 - pred.x, h.y + h.height / 2 - pred.y);
  const chosenErr = dist(chosen);
  if (chosenErr < o.crossFarBodies * body) return null;
  let other = null, otherErr = Infinity;
  for (const h of hits || []) {
    if (!h || h === chosen || !(h.score >= o.crossOtherScoreMin) || !(h.width > 2 && h.height > 2)) continue;
    const ratio = h.height / trackBox.height;
    if (ratio < o.heightRatioMin || ratio > o.heightRatioMax) continue;
    /* 받으려는 사람과 거의 같은 상자(중복 검출)는 다른 사람이 아니다. */
    if (boxIou(h, chosen) >= 0.5) continue;
    const d = dist(h);
    if (d < otherErr) { otherErr = d; other = h; }
  }
  if (!other || otherErr > o.crossNearBodies * body || otherErr > 0.5 * chosenErr) {
    return { kind: 'far', predicted: pred, chosenBodies: chosenErr / body, otherBodies: other ? otherErr / body : null };
  }
  return { kind: 'conflict', predicted: pred, chosenBodies: chosenErr / body, otherBodies: otherErr / body };
}

/**
 * 탐침 한 번의 가로지름 판단과 움직임 기록 갱신. trail 은 rememberAnchorMatch 가 쓰는 배열이고 trail.held 에 미룬 여부를 둔다.
 * @returns {null | { kind: 'conflict' | 'far', predicted: {x:number,y:number}, chosenBodies: number, otherBodies: number | null }}
 *   'conflict' 면 부르는 쪽이 묻는다(기록은 비운다). 'far' 는 한 번 미룬 것이다. null 이면 받아들였다.
 */
export function crossingStep(trail, t, decision, hits, trackBox, options = {}) {
  const c = crossingConflict(trail, t, decision, hits, trackBox, options);
  if (c?.kind === 'conflict') { trail.length = 0; trail.held = false; return c; }
  if (c?.kind === 'far' && !trail.held) { trail.held = true; return c; }
  if (c?.kind === 'far') trail.length = 0;  // 두 번 이어 멀다 — 대상이 멈췄거나 방향을 바꿨다. 새로 잰다.
  trail.held = false;
  if (decision?.hit) rememberAnchorMatch(trail, t, decision.hit);
  return c?.kind === 'far' ? null : c;
}

/** 영상 시간으로 부를 때가 됐나. 첫 호출은 시작 뒤 intervalSec. */
export function anchorDue(lastT, t, intervalSec = DETECTION_ANCHOR.intervalSec) {
  if (!Number.isFinite(t)) return false;
  if (!Number.isFinite(lastT)) return true;
  return t - lastT >= intervalSec - 1e-6;
}

/**
 * 「상자가 사람에게서 떨어졌다」를 탐침마다 센다. 옮기지 않고, 이어지면 사용자에게 묻는다.
 *
 * - 분명한 사람(elsewhereScoreMin 이상, 상자 높이의 containHeightMin 이상)이 **딱 한 명** 보이는데 상자와 겹치지 않으면 한 번 센다.
 *   여럿이 보이면 누가 대상인지 검출기로 가를 수 없어 세지 않는다.
 * - 검출기가 아무도 못 본 탐침은 세지도 끊지도 않는다(검출기가 놓친 것일 수 있다).
 * - 🔴 검출기가 추적 상자의 사람을 seenBeforeAsk 번 이상 확인한 뒤에만 묻는다. 빙상장(사람 검수 정답)에서 대상이 작아
 *   검출기가 거의 못 보았는데 그때 묻자 잘 따라가던 60초가 통째로 확인 대기가 됐다.
 */
export function anchorMissStep(state, decision, hits, trackBox, options = {}) {
  const o = { ...DETECTION_ANCHOR, ...options };
  const seen = state.seen + (decision.action === 'correct' || decision.reason === 'already-good' ? 1 : 0);
  const clear = (hits || []).filter((h) => h.score >= o.elsewhereScoreMin
    && h.height >= o.containHeightMin * trackBox.height);
  const elsewhere = decision.reason === 'no-overlap' && clear.length === 1;
  const run = elsewhere ? state.run + 1 : (decision.reason === 'no-person' ? state.run : 0);
  return { seen, run, ask: run >= o.askAfterMisses && seen >= o.seenBeforeAsk };
}
