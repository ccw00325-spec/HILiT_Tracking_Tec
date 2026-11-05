/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·081685ec @license @preserve */
/* 검출 연결 추적(linked-v1) — 계산 부분. 화면·영상·검출기를 모른다(시험에서 그대로 부른다).
 *
 * 2026-10-20 사용자 지시로 만든 기본 추적 경로다.
 *   「놓쳐서 묻는 곳이 너무 많다. 정말 놓칠 수밖에 없는 곳만 묻고, 그 밖에는 놓치지 마라.」
 *   「화면 밖으로 나갔다고 화면에 이미 있던 사람을 바로 잡으면 안 된다. 나간 뒤 새로 들어오는 사람만 비교하고,
 *    영상 뒤까지 본 다음 가장 닮은 사람을 골라 그 사람으로 이어 붙여라.」
 *
 * 예전 경로(trackLegacy)는 상관필터 하나가 매 프레임 상자를 밀고, 0.5초마다 사람 검출로 보정했다. 실사에서
 * 실패의 대부분은 상자가 배경·옆 사람에 붙은 채 「정상」으로 남는 것이었다(2026-09-24 감사, 10-09 수율 기록).
 *
 * 이 경로는 반대로 간다.
 *   1. 영상을 0.2초 간격으로 읽어 화면의 **모든 사람**을 검출한다(편집 2단계와 같은 MediaPipe 검출기, 조각 확대 포함).
 *   2. 검출 상자를 시간으로 이어 사람마다 줄(tracklet)을 만든다 — 위치 예측 + 카메라 이동 보정 + 겉모습.
 *   3. 사용자가 고른 상자가 속한 줄을 따라간다. 상자는 늘 실제로 검출된 사람 위에 있다(배경에 붙을 수 없다).
 *   4. 그 줄이 끝나면(화면 밖으로 나감·가림) **그 뒤에 새로 생긴 줄만** 후보로 본다. 대상과 같은 시각에 화면에
 *      함께 보였던 사람은 대상일 수 없다(한 사람이 두 자리에 있을 수 없다) — 그 사람들은 「확실한 타인」이 된다.
 *   5. 후보를 영상 끝까지 모두 본 뒤 겉모습이 가장 닮은 사람을 고른다. 확실한 타인과 더 닮았으면 고르지 않는다.
 *      고른 사람의 줄은 그가 화면에 들어온 시각부터 이미 이어져 있다 — 그 시각으로 거슬러 붙인다.
 *   6. 둘 이상이 똑같이 그럴듯할 때만 묻는다. 그때도 「이 사람이 맞나요?」로 가장 닮은 사람을 먼저 보여 준다.
 *
 * 🔴 겉모습 점수는 신원 확률이 아니다. 같은 영상 안에서 사용자가 고른 사람이 맞는지 가르는 보조 근거다.
 *    확실한 타인 기억은 이 영상 한 편 안에서만 산다(AGENTS.md 기술 정의).
 */
import { appearanceSimilarity } from './hilit-appearance.js';
import { adjustSimilarity, chooseCueWeights, CUE_DEFAULT } from './linked-cues.js';

export const LINKED_ENGINE = 'linked-v1';

export const LINKED_POLICY = Object.freeze({
  /** 검출 간격(초당 표본 수). */
  sampleHz: 5,
  /** 편집기에 넘기는 궤적의 초당 점 수. 표본 사이는 직선으로 잇는다. */
  outFps: 10,
  /** 새 줄을 시작할 수 있는 검출 점수. */
  scoreNew: 0.3,
  /** 이미 있는 줄을 이을 수 있는 낮은 점수(ByteTrack 의 둘째 연결). */
  scoreKeep: 0.15,
  /** 이보다 작은 상자는 버린다(분석 화면 화소). */
  minHeightPx: 14,
  /** 같은 사람을 두 번 잡은 상자 합치기. */
  nmsIou: 0.5,
  /** 예측 자리에서 검출까지 허용 거리(상자 키 배수) — 못 본 시간만큼 넓힌다. */
  gateBase: 0.9,
  gatePerSec: 1.6,
  gateMax: 3,
  /** 키 비율 허용 폭. */
  sizeRatioMax: 1.7,
  /** 키 비교 기준 — 직전 상자 하나가 아니라 최근 이 시간(초) 관측 키의 중앙값. 0 이면 직전 상자.
   *  직전 상자와만 비교하면 가려지며 반쪽만 잡힌 상자(135→90→69)를 따라 키가 조금씩 줄며 옆 사람에게 넘어간다
   *  (2026-10-21 SAM 2 채점, fb12). */
  sizeRefSec: 0,
  /** 넘겨받기 — 대상 줄이 끊긴 뒤 이 시간(초) 안에, 다른 줄이 자기 직전 자리·키에서 튀어 대상의 마지막 자리·키에
   *  딱 이어지는 상자를 잡았으면 검출 줄이 사람을 바꿔 단 것이다(2026-10-21 SAM 2 채점, fb17). 0 이면 끈다. */
  handoverMaxGapSec: 0,
  /** 넘겨받기 비용 상한(대상 마지막 상자와의 이음 비용)과, 그 줄 자기 이음보다 이만큼 더 자연스러워야 하는 차. */
  handoverMaxCost: 0.6,
  handoverMargin: 0.3,
  /** 줄 잇기 비용 가중치(겹침·중심 거리·키 비율·겉모습). 2026-10-20 dev 격자에서 값 차이가 거의 없어 처음 값을 둔다. */
  wIou: 1,
  wDist: 0.6,
  wSize: 0.5,
  wApp: 0.35,
  /** 두 줄 이상이 같은 검출을 두고 다툴 때(엇갈리는 순간)만 쓰는 겉모습 가중치. 0 이면 wApp 그대로.
   *  평소엔 자리로 잇고, 헷갈리는 순간에만 옷 색을 크게 본다(2026-10-21 SAM 2 채점, fb02 빨강↔흰 맞바뀜). */
  wAppConflict: 0,
  /** 속도 갱신 비율(새 관측 쪽). */
  velAlpha: 0.5,
  /** 이만큼 못 보면 줄을 닫는다. */
  trackDeathSec: 1.0,
  /** 화면 가장자리로 보는 폭(화면 짧은 변 비율). */
  edgeMargin: 0.04,
  /** 줄 안의 빈틈이 이보다 길면 「주의」로 둔다(그보다 짧으면 정상으로 잇는다). */
  warnGapSec: 0.45,
  /** 겉모습 기억 크기. */
  galleryMax: 24,
  /** 줄마다 남기는 겉모습 표본 수. */
  trackDescMax: 10,
  /** 재등장 후보 판정. sim = 대상 기억과의 닮음, neg = 확실한 타인과의 닮음. */
  reentrySimMin: 0.5,
  reentryMarginMin: 0.0,
  /** 대상 자신의 닮음(gallerySelf)에서 이만큼 넘게 떨어진 후보는 받지 않는다. */
  reentrySelfDrop: 0.1,
  /** 가장 닮은 후보와 이만큼 안이면 더 일찍 들어온 사람을 고른다. */
  reentryEarlierWithin: 0.03,
  /** 같은 시각에 함께 보이는 두 후보가 이만큼 안이면 가를 수 없다 → 묻는다. */
  reentryAmbiguous: 0.025,
  /** 잠깐 가려졌다 나온 경우: 잃은 자리 근처(키 배수, 초당 넓힘). */
  occludedNearBase: 1.6,
  occludedNearPerSec: 1.6,
  /** 끊긴 줄 잇기: 끊긴 뒤 이 시간 안에 생긴 줄, 예측 자리에서 (키 배수) 거리. 0 이면 끈다 —
   *  2026-10-20 dev(미식축구·빙상장 36명)에서 정답은 그대로, 다른 사람을 따라간 지점만 19→25 로 늘어 꺼 두었다. */
  stitchMaxGapSec: 0,
  stitchNearBase: 0.9,
  stitchNearPerSec: 1.0,
  /** 대상 자신의 닮음에서 이만큼 넘게 떨어지면(전혀 다른 옷) 잇지 않는다. */
  stitchSelfDrop: 0.25,
  /** 두 후보의 비용 차가 이보다 작으면 가를 수 없다. */
  stitchAmbiguous: 0.15,
  /** 겹쳤다 갈라진 두 사람을 가를 수 없을 때 묻는가. 꺼 두면 움직임이 이어진 쪽(지금 줄)을 그대로 따라간다.
   *  2026-10-20 dev 36명: 켜면 17번 묻고도 정답 수가 같았다(98/199) — 묻는 값이 없어 끈다. */
  crossingAsk: false,
  /** 사용자가 고른 직후 이 시간(초) 안에는 묻지 않는다 — 고르자마자 같은 장면을 다시 묻지 않게. */
  askRearmSec: 1.5,
  /** 교차 뒤 바뀜 판정. */
  contactIou: 0.2,
  /** 겹치지 않고 스치기만 해도(중심 거리 < 키 × 이 값) 겹침으로 본다. 0 이면 IoU 만. 맞닿은 채 한 장이 비면
   *  두 줄이 사람을 맞바꾸는데 IoU 로는 겹침이 잡히지 않았다(2026-10-21 SAM 2 채점, fb02 빨강 15번↔흰 89번). */
  contactDistH: 0,
  /** 겹쳤다 갈라진 뒤 옮겨 타는 점수 문턱(judgeExchange score). 이보다 크면 옮겨 타고, -값보다 작으면 그대로. */
  swapScoreMin: 0.6,
  /** 옮겨 탈 때 겉모습 근거(judgeExchange app)가 적어도 이만큼은 있어야 한다. 같은 유니폼끼리 스칠 때 움직임 잡음만으로
   *  옮겨 타는 것을 막는다. 0 이면 점수만 본다. */
  swapAppMin: 0,
  /** 스침 겹침(contactDistH)으로만 잡힌 엇갈림은 두 사람이 겹치기 전 서로 이만큼보다 덜 닮았을 때만(빨강↔흰처럼)
   *  옮겨 탄다. 같은 유니폼끼리는 움직임 잡음만으로 옮겨 타던 것을 막는다. 1 이면 거르지 않는다. */
  contactDistinctMax: 1,
  /** 엇갈림 짝 — 대상이 남과 맞닿거나 곁에서 가려진 순간의 그 사람을 기억해, 대상을 놓쳤을 때 확실한 타인이어도
   *  재등장 후보로 다시 본다(위험한 순간 전의 겉모습으로 비교). 한 번 넘어간 뒤 진짜 대상이 확실한 타인으로 굳는
   *  연쇄(2026-10-21 SAM 2 채점: 남은 놓침의 65%)를 겨냥. false 면 예전 그대로.
   *  2026-10-22 사용자 승인으로 켬(아래 reentryNearFirstSec 0.5 와 함께 dev 75.5→79.8%, 실사 22편 110→113). */
  riskPartners: true,
  /** 재등장 고르기 — 놓친 자리 근처(nearLoss)에 이 초 안에 나타난 통과 후보가 있으면 그들 중에서만 고른다.
   *  0 이면 예전 그대로(통과 후보 전체에서 가장 닮은 사람, 거의 같으면 먼저 들어온 사람). */
  reentryNearFirstSec: 0.5,
  /** 급변 감지 — 대상 줄이 직전 0.8초 움직임으로 내다본 자리에서 (키 배수) 이만큼 넘게 벗어났는데, 다른 줄의 검출이
   *  그 자리에 훨씬 가깝게(jumpRatio 배 안) 있으면 겹침으로 잡히지 않은 바뀜으로 보고 judgeExchange 로 가른다.
   *  가려졌던 곁 사람이 다시 잡히거나 빠르게 지나치며 줄 번호가 바뀌는 장면(2026-10-23 SAM 2 채점, fb02 심판·fb06).
   *  0 이면 끈다. 0.3: dev IoU0.5 79.8→80.1%, 다른 사람 172→135, 놓침 155→191, 봉인·실사 22편 변화 없음 — 승인 전 꺼 둔다. */
  jumpDevMin: 0,
  jumpRatio: 0.6,
  /** 다시 들어온 사람을 잇기 전에 묻기(2026-10-24) — 고른 후보와 겉모습이 이만큼 안인 다른 후보가 같은 무렵(askUnclearWindowSec)
   *  있으면 자동으로 잇지 않고 「이 사람이 맞나요?」로 묻는다. 같은 유니폼끼리 다른 사람으로 잇는 것을 사용자 한 번 확인으로 막는다.
   *  묻지 못하는 때(건너뛰기·상한)는 예전처럼 고른다. 0 이면 끈다.
   *  0.06 + jumpDevMin 0.3, 정답으로 답하는 사용자 흉내(dev 96명): 다른 사람 150→106, 없는데 우김 25→16, IoU0.5 78.2→79.1%,
   *  놓침 153→187, 묻기 분당 0.25→0.99. 봉인 같음(우김 26→19), 실사 22편 113 그대로 — 승인 전 꺼 둔다. */
  askUnclearMargin: 0,
  askUnclearWindowSec: 3,
  /** 장면별 단서 무게(2026-10-27 제안 2번) — 고른 직후 대상과 둘레 배경·다른 사람을 단서(색조·밝기·윤곽)마다 비교해,
   *  배경·남과 갈리는 단서에 무게를 더 준다(linked-cues.js). 줄 만들기는 그대로, 대상 잇기의 닮음만 고친다. */
  cueAdapt: true,
  /** 고친 닮음을 얼마나 반영하나(linked-cues.js adjustSimilarity). 0 이면 예전 점수 그대로.
   *  2026-10-27 dev 96명: 0.5 → 79.8%, 1 → 80.2%(놓침 155→141, 없는데 우김 32→27), 1.5 → 79.9%, 2 → 78.4%(다른 사람 172→214). */
  cueGain: 1,
  /** 무게를 고를 때 보는 고른 뒤 구간(초). */
  cueLearnSec: 2,
  /** 사람 화소만 센 단서(2026-10-27 제안 1번, person-mask) — 두 상자 모두 있을 때만 쓴다. */
  useFgCues: true,
  /** 전광판·LED 화면 속 사람 거르기(2026-10-27 제안 4번) — 무대 위 사람들보다 훨씬 크고(screenGiant 배),
   *  다른 사람들 머리 위에 떠 있거나 상반신만 잡힌(키/너비 < screenAspect, 화면 아래에 닿지 않음) 검출. 그런 줄은
   *  카메라 이동 추정과 재등장·잇기 후보에서 뺀다. 사용자가 그 사람을 직접 고르면 거르지 않는다. */
  screenFilter: true,
  screenGiant: 2.2,
  screenAspect: 1.45,
  /** 줄 관측 중 이 비율 이상이 화면 속 검출이면 그 줄을 화면 속 사람으로 본다. */
  screenTrackShare: 0.6,
  /** 확대 재검출 상자(det.zoom)는 새 줄을 만들지 않고 이미 있는 줄만 잇는다(2026-10-27 제안 5번). */
  zoomExtendOnly: true,
});

/* ── 상자 계산 ─────────────────────────────────────────────────── */

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
const cx = (b) => b.x + b.width / 2;
const cy = (b) => b.y + b.height / 2;
function centerDist(a, b) { return Math.hypot(cx(a) - cx(b), cy(a) - cy(b)); }
function shiftBox(b, dx, dy) { return { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }; }
function lerpBox(a, b, f) {
  return {
    x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
    width: a.width + (b.width - a.width) * f, height: a.height + (b.height - a.height) * f,
  };
}

/** 상자가 화면 가장자리에 닿아 있나(들어오는 중·나가는 중). */
export function nearEdge(box, frame, margin = LINKED_POLICY.edgeMargin) {
  const m = margin * Math.min(frame.width, frame.height);
  return box.x <= m || box.y <= m
    || box.x + box.width >= frame.width - m
    || box.y + box.height >= frame.height - m;
}

/** 겹친 검출 합치기 — 점수 높은 것부터 남긴다. 한 상자가 다른 상자 안에 거의 다 들어가면(상반신만 잡힘) 하나로 본다. */
export function mergeDetections(dets, nmsIou = LINKED_POLICY.nmsIou) {
  const sorted = dets.filter((d) => d.width > 0 && d.height > 0).sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of sorted) {
    let dup = false;
    for (const k of kept) {
      if (iou(d, k) >= nmsIou) { dup = true; break; }
      const ix = Math.max(0, Math.min(d.x + d.width, k.x + k.width) - Math.max(d.x, k.x));
      const iy = Math.max(0, Math.min(d.y + d.height, k.y + k.height) - Math.max(d.y, k.y));
      const small = Math.min(d.width * d.height, k.width * k.height);
      if (small > 0 && (ix * iy) / small >= 0.85) { dup = true; break; }
    }
    if (!dup) kept.push(d);
  }
  return kept;
}

/* ── 카메라 이동 ──────────────────────────────────────────────────
 * 화면 안 사람들이 한꺼번에 같은 쪽으로 밀리면 카메라가 움직인 것이다. 앞 표본의 상자들을 어떤 이동량으로
 * 밀었을 때 지금 검출과 가장 많이 겹치는지 투표로 고른다. 사람이 둘 미만이면 재지 않는다(0). */
export function estimateShift(prevBoxes, dets, frame) {
  if (prevBoxes.length < 2 || dets.length < 2) return { dx: 0, dy: 0, support: 0 };
  const limit = 0.35 * Math.max(frame.width, frame.height);
  const hyps = [{ dx: 0, dy: 0 }];
  for (const p of prevBoxes) {
    for (const d of dets) {
      const r = d.height / p.height;
      if (r < 0.75 || r > 1.33) continue;
      const dx = cx(d) - cx(p), dy = cy(d) - cy(p);
      if (Math.hypot(dx, dy) > limit) continue;
      hyps.push({ dx, dy });
      if (hyps.length > 360) break;
    }
    if (hyps.length > 360) break;
  }
  const support = (h) => {
    let s = 0;
    for (const p of prevBoxes) {
      const moved = shiftBox(p, h.dx, h.dy);
      let best = 0;
      for (const d of dets) { const v = iou(moved, d); if (v > best) best = v; }
      if (best >= 0.3) s += 1;
    }
    return s;
  };
  let best = hyps[0], bestS = support(hyps[0]);
  const zeroS = bestS;
  for (let i = 1; i < hyps.length; i += 1) {
    const s = support(hyps[i]);
    if (s > bestS || (s === bestS && Math.hypot(hyps[i].dx, hyps[i].dy) < Math.hypot(best.dx, best.dy))) { best = hyps[i]; bestS = s; }
  }
  if (bestS < 2 || bestS <= zeroS) return { dx: 0, dy: 0, support: zeroS };
  /* 고른 이동으로 맞은 짝들의 평균으로 다듬는다. */
  let sx = 0, sy = 0, n = 0;
  for (const p of prevBoxes) {
    const moved = shiftBox(p, best.dx, best.dy);
    let bd = null, bv = 0;
    for (const d of dets) { const v = iou(moved, d); if (v > bv) { bv = v; bd = d; } }
    if (bd && bv >= 0.3) { sx += cx(bd) - cx(p); sy += cy(bd) - cy(p); n += 1; }
  }
  return n ? { dx: sx / n, dy: sy / n, support: bestS } : { dx: best.dx, dy: best.dy, support: bestS };
}

/* ── 줄 만들기(사람마다 시간으로 잇기) ──────────────────────────── */

/** 최근 sec 초 관측 키의 중앙값(마지막 관측 기준). */
function refHeight(obs, t, sec) {
  const last = obs[obs.length - 1];
  const hs = [];
  for (let i = obs.length - 1; i >= 0 && obs[i].t >= last.t - sec - 1e-6; i -= 1) hs.push(obs[i].box.height);
  hs.sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)];
}

/* 대상 잇기(linkTarget) 동안만 쓰는 단서 문맥 — 그 영상 그 대상의 무게. 잇기가 끝나면 비운다(줄 만들기는 늘 기본 점수). */
let cueCtx = null;

function similarity(a, b) {
  if (!a || !b) return null;
  const base = appearanceSimilarity(a, b);
  return cueCtx ? adjustSimilarity(base, a, b, cueCtx) : base;
}

/**
 * 전광판·LED 화면 속 사람인가 — 한 장의 검출마다 true/false. 다른 사람이 둘 이상 함께 보일 때만 판정한다
 * (비교할 무대 위 사람이 없으면 모른다 → false). 크기 하나만으로는 거르지 않는다 — 카메라 가까이 선 사람도 크다.
 */
export function screenDetections(dets, frame, policy = LINKED_POLICY) {
  const out = new Array(dets.length).fill(false);
  if (!policy.screenFilter || dets.length < 3) return out;
  for (let i = 0; i < dets.length; i += 1) {
    const d = dets[i];
    const others = dets.filter((o, j) => j !== i && o.score >= policy.scoreNew);
    if (others.length < 2) continue;
    const hs = others.map((o) => o.height).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)];
    if (!(d.height >= policy.screenGiant * medH)) continue;
    const tops = others.map((o) => o.y).sort((a, b) => a - b);
    const floating = d.y + d.height <= tops[Math.floor(tops.length / 2)] + 0.1 * medH;
    const atBottom = d.y + d.height >= frame.height - policy.edgeMargin * Math.min(frame.width, frame.height);
    const upper = d.height / Math.max(1, d.width) < policy.screenAspect && !atBottom;
    out[i] = floating || upper;
  }
  return out;
}

/**
 * samples: [{ t, dets:[{x,y,width,height,score,desc?}] }] 시간순. frame: {width,height}.
 * 돌려주는 것: { tracks:[{ id, obs:[{t, si, box, score, desc}] }], perSample:[[{trackId, det}]], shifts:[{dx,dy}] }
 */
export function buildTracklets(samples, frame, policy = LINKED_POLICY) {
  const tracks = [];
  const active = [];
  const perSample = [];
  const shifts = [];
  let prevObserved = [];
  for (let si = 0; si < samples.length; si += 1) {
    const { t } = samples[si];
    const dets = (samples[si].dets || []).filter((d) => d.height >= policy.minHeightPx && d.score >= policy.scoreKeep);
    const onScreen = screenDetections(dets, frame, policy);
    /* 화면 속 사람은 카메라와 따로 움직인다(화면 전환·확대) — 카메라 이동 투표에서 뺀다. */
    const shift = si === 0 ? { dx: 0, dy: 0, support: 0 }
      : estimateShift(prevObserved, dets.filter((d, di) => d.score >= policy.scoreNew && !onScreen[di]), frame);
    shifts.push(shift);
    /* 닫을 줄. */
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (t - active[i].lastT > policy.trackDeathSec + 1e-6) active.splice(i, 1);
    }
    /* 예측. 카메라 이동은 줄이 못 본 동안에도 쌓는다. */
    for (const tr of active) {
      tr.refH = policy.sizeRefSec > 0 ? refHeight(tr.obs, t, policy.sizeRefSec) : null;
      tr.camX += shift.dx; tr.camY += shift.dy;
      const dt = t - tr.lastT;
      tr.pred = shiftBox(tr.lastBox, tr.camX + tr.vx * dt, tr.camY + tr.vy * dt);
      tr.missSec = dt;
    }
    const assigned = new Map();
    const used = new Set();
    const pairs = (minScore, strict) => {
      const list = [];
      /* 검출마다 문턱 안에 든 줄 수 — 둘 이상이면 다툼(엇갈림). */
      const contenders = new Map();
      for (const tr of active) {
        if ([...assigned.keys()].includes(tr.id)) continue;
        for (let di = 0; di < dets.length; di += 1) {
          if (used.has(di)) continue;
          const d = dets[di];
          if (d.score < minScore) continue;
          const h = Math.max(tr.pred.height, 1);
          const dist = centerDist(tr.pred, d) / h;
          const gate = Math.min(policy.gateMax, policy.gateBase + policy.gatePerSec * Math.max(0, tr.missSec - 1 / policy.sampleHz)) * (strict ? 0.7 : 1);
          if (dist > gate) continue;
          const ratio = d.height / Math.max(1, tr.refH ?? h);
          if (ratio > policy.sizeRatioMax || ratio < 1 / policy.sizeRatioMax) continue;
          const ov = iou(tr.pred, d);
          if (strict && ov < 0.2) continue;
          const sim = similarity(tr.desc, d.desc);
          const base = policy.wIou * (1 - ov) + policy.wDist * Math.min(2, dist) + policy.wSize * Math.abs(Math.log(ratio));
          list.push({ tr, di, base, app: sim === null ? 0.5 : 1 - sim });
          contenders.set(di, (contenders.get(di) || 0) + 1);
        }
      }
      for (const p of list) {
        const w = policy.wAppConflict > 0 && contenders.get(p.di) > 1 ? policy.wAppConflict : policy.wApp;
        p.cost = p.base + w * p.app;
      }
      list.sort((a, b) => a.cost - b.cost);
      for (const p of list) {
        if (assigned.has(p.tr.id) || used.has(p.di)) continue;
        assigned.set(p.tr.id, p.di); used.add(p.di);
      }
    };
    pairs(policy.scoreNew, false);
    pairs(policy.scoreKeep, true);
    const row = [];
    for (const tr of active) {
      if (!assigned.has(tr.id)) continue;
      const d = dets[assigned.get(tr.id)];
      const box = { x: d.x, y: d.y, width: d.width, height: d.height };
      const dt = t - tr.lastT;
      if (dt > 0) {
        const vx = (cx(box) - (cx(tr.lastBox) + tr.camX)) / dt;
        const vy = (cy(box) - (cy(tr.lastBox) + tr.camY)) / dt;
        const capV = 3 * box.height; /* 1초에 키 세 배 넘게 움직이는 값은 잡음이다 */
        const al = policy.velAlpha;
        tr.vx = (1 - al) * tr.vx + al * Math.max(-capV, Math.min(capV, vx));
        tr.vy = (1 - al) * tr.vy + al * Math.max(-capV, Math.min(capV, vy));
      }
      tr.lastBox = box; tr.lastT = t; tr.camX = 0; tr.camY = 0;
      if (d.desc && d.desc.samples >= 60) tr.desc = d.desc;
      const ob = { t, si, box, score: d.score, desc: d.desc || null, ...(onScreen[assigned.get(tr.id)] ? { screen: true } : {}) };
      tr.obs.push(ob);
      row.push({ trackId: tr.id, det: d, obs: ob });
    }
    for (let di = 0; di < dets.length; di += 1) {
      if (used.has(di)) continue;
      const d = dets[di];
      if (d.score < policy.scoreNew) continue;
      /* 놓친 자리 확대 재검출(linked-tracker.js)로 찾은 상자는 이미 있는 줄을 잇는 데만 쓴다 — 새 줄을 만들면 그 줄이
       * 재등장 후보가 되어 곁 사람으로 잇는다(2026-10-27 dev: 다른 사람 172→185, 놓침 155→179). */
      if (d.zoom && policy.zoomExtendOnly) continue;
      const box = { x: d.x, y: d.y, width: d.width, height: d.height };
      const ob = { t, si, box, score: d.score, desc: d.desc || null, ...(onScreen[di] ? { screen: true } : {}) };
      const tr = { id: tracks.length, obs: [ob], lastBox: box, lastT: t, vx: 0, vy: 0, camX: 0, camY: 0, desc: d.desc && d.desc.samples >= 60 ? d.desc : null, pred: box, missSec: 0 };
      tracks.push(tr); active.push(tr);
      row.push({ trackId: tr.id, det: d, obs: ob });
    }
    perSample.push(row);
    prevObserved = row.filter((r) => !r.obs.screen).map((r) => r.obs.box);
  }
  const screenTrack = (tr) => {
    const n = tr.obs.filter((o) => o.screen).length;
    return n >= 2 && n >= policy.screenTrackShare * tr.obs.length;
  };
  return {
    tracks: tracks.map((tr) => ({ id: tr.id, obs: tr.obs, ...(screenTrack(tr) ? { screen: true } : {}) })),
    perSample,
    shifts,
  };
}

/* ── 겉모습 기억 ────────────────────────────────────────────────── */

/** 대상 기억(또는 확실한 타인)에 대한 닮음 — 표본마다 기억 중 가장 닮은 두 장의 평균, 그 중앙값. */
export function galleryScore(gallery, descs) {
  const usable = descs.filter((d) => d && d.samples >= 60);
  if (!gallery.length || !usable.length) return null;
  const per = usable.map((d) => {
    const sims = gallery.map((g) => similarity(g, d) ?? 0).sort((a, b) => b - a);
    return sims.length > 1 ? (sims[0] + sims[1]) / 2 : sims[0];
  }).sort((a, b) => a - b);
  return per[Math.floor(per.length / 2)];
}

/** 기억끼리의 닮음 중앙값(같은 사람이 자세·조명에 따라 얼마나 달라 보이는가). 둘 미만이면 null. */
export function gallerySelf(gallery) {
  const sims = [];
  for (let i = 0; i < gallery.length; i += 1) for (let j = i + 1; j < gallery.length; j += 1) {
    const v = similarity(gallery[i], gallery[j]);
    if (v !== null) sims.push(v);
  }
  if (sims.length < 3) return null;
  sims.sort((a, b) => a - b);
  return sims[Math.floor(sims.length / 2)];
}

function isolated(box, others) {
  return others.every((o) => iou(box, o) < 0.05 && centerDist(box, o) > 0.6 * Math.max(box.height, o.height));
}

/* ── 대상 잇기 ──────────────────────────────────────────────────── */

/**
 * 사용자가 고른 상자에서 출발해 대상의 줄들을 잇는다.
 *
 * input = { samples, built(buildTracklets 결과), frame, seed:{t, box}, rejected:[{t, box}], seedDescs:[desc],
 *           stopOnAsk, askNotBefore, followThrough }
 * 돌려주는 것: { ok, reason?, segments:[{trackId, from, to}], perSampleState, ask?, decisions, others }
 */
export function linkTarget(input, policy = LINKED_POLICY) {
  try {
    return linkTargetInner(input, policy);
  } finally {
    cueCtx = null;
  }
}

/** 고른 직후 대상·둘레 배경·다른 사람의 단서로 이 대상의 무게를 고른다(linked-cues.js). */
function pickCueContext({ input, policy, samples, perSample, seedTrack, seedTr, s0, screenIds }) {
  if (!(policy.cueGain > 0) || !(policy.cueAdapt || policy.useFgCues)) return null;
  const pick = (d) => (d ? (policy.useFgCues && d.cuesFg) || d.cues || null : null);
  const self = [], ring = [], others = [];
  for (const d of input.seedDescs || []) {
    const c = pick(d);
    if (c) self.push(c);
    if (d?.ring) ring.push(d.ring);
  }
  const t0 = samples[s0].t;
  for (const ob of seedTr.obs) {
    if (ob.si < s0) continue;
    if (ob.t > t0 + policy.cueLearnSec + 1e-6) break;
    const oth = (perSample[ob.si] || []).filter((r) => r.trackId !== seedTrack);
    if (!isolated(ob.box, oth.map((r) => r.obs.box))) continue;
    const c = pick(ob.desc);
    if (c) self.push(c);
    if (ob.desc?.ring) ring.push(ob.desc.ring);
    for (const r of oth) {
      if (screenIds.has(r.trackId)) continue;
      const oc = pick(r.obs.desc);
      if (oc) others.push(oc);
    }
  }
  const choice = policy.cueAdapt
    ? chooseCueWeights({ self: self.slice(0, 8), ring: ring.slice(0, 8), others })
    : { w: CUE_DEFAULT.slice(), disc: null, adapted: false };
  return { w: choice.w, gain: policy.cueGain, useFg: policy.useFgCues === true, adapted: choice.adapted, disc: choice.disc,
    selfN: self.length, ringN: ring.length, othersN: others.length };
}

function linkTargetInner(input, policy) {
  const { samples, built, frame, seed } = input;
  const { tracks, perSample } = built;
  if (!samples.length) return { ok: false, reason: 'no-samples' };
  /* 1. 고른 상자가 속한 줄. 고른 시각의 검출 중 가장 많이 겹치는 것. */
  let s0 = 0;
  for (let i = 1; i < samples.length; i += 1) if (Math.abs(samples[i].t - seed.t) < Math.abs(samples[s0].t - seed.t)) s0 = i;
  let seedTrack = null, seedOv = 0;
  const seedPick = (si) => {
    for (const r of perSample[si] || []) {
      const ov = iou(seed.box, r.obs.box);
      const inside = cx(r.obs.box) >= seed.box.x && cx(r.obs.box) <= seed.box.x + seed.box.width
        && cy(r.obs.box) >= seed.box.y && cy(r.obs.box) <= seed.box.y + seed.box.height;
      const ratio = r.obs.box.height / Math.max(1, seed.box.height);
      const score = ov + (inside && ratio > 0.5 && ratio < 2 ? 0.15 : 0);
      if (score > seedOv) { seedOv = score; seedTrack = r.trackId; }
    }
  };
  seedPick(s0);
  /* 고른 그 장에서 검출이 못 잡았으면(작거나 반쯤 가려짐) 바로 다음 두 장에서 찾는다. */
  for (let k = 1; seedOv < 0.3 && k <= 2 && s0 + k < samples.length; k += 1) seedPick(s0 + k);
  if (seedTrack === null || seedOv < 0.3) return { ok: false, reason: 'seed-not-detected', seedOverlap: seedOv };

  const trackById = new Map(tracks.map((tr) => [tr.id, tr]));
  /* 사용자가 아니라고 한 상자 → 그 줄은 대상이 될 수 없다. */
  const forbidden = new Set();
  for (const rej of input.rejected || []) {
    let best = null, bv = 0;
    for (let si = 0; si < samples.length; si += 1) {
      if (Math.abs(samples[si].t - rej.t) > 0.11) continue;
      for (const r of perSample[si]) { const v = iou(rej.box, r.obs.box); if (v > bv) { bv = v; best = r.trackId; } }
    }
    if (best !== null && bv >= 0.3 && best !== seedTrack) forbidden.add(best);
  }
  /* 전광판·LED 화면 속 사람의 줄 — 대상이 될 수 없다(사용자가 그 사람을 고른 경우는 빼고). 확실한 타인 기억에도
   * 넣지 않는다: 화면에 대상의 확대 모습이 나오면 그 모습이 「타인」으로 남아 진짜 대상의 재등장을 막는다. */
  const seedTr = trackById.get(seedTrack);
  const screenIds = new Set(seedTr.screen ? [] : tracks.filter((tr) => tr.screen && tr.id !== seedTrack).map((tr) => tr.id));
  for (const id of screenIds) forbidden.add(id);
  cueCtx = pickCueContext({ input, policy, samples, perSample, seedTrack, seedTr, s0, screenIds });

  const gallery = [...(input.seedDescs || []).filter((d) => d && d.samples >= 60)];
  const otherDescs = [];
  const otherDescOwner = [];
  /* 엇갈림 짝(riskPartners) — trackId → 처음 맞닿은 표본, 그리고 처음 위험했던 순간의 대상 겉모습 기억. */
  const partners = new Map();
  let galleryAtRisk = null;
  const markRisk = (trackId, si) => {
    if (!policy.riskPartners || partners.has(trackId)) return;
    partners.set(trackId, si);
    if (!galleryAtRisk) galleryAtRisk = gallery.slice();
  };
  const otherTracks = new Set();
  const decisions = [];
  const segments = [];
  /* sample 별 대상 상태: { kind:'obs'|'absent', trackId, box } */
  const state = new Array(samples.length).fill(null);
  const targetObsTimes = new Set();
  const remember = (list, desc, max) => {
    if (!desc || desc.samples < 60) return;
    list.push(desc);
    if (list.length > max) list.splice(input.seedDescs?.length ? 1 : 0, 1); /* 처음 고른 모습은 남긴다 */
  };
  let ask = null;
  const mayAsk = (t) => input.stopOnAsk === true && input.followThrough !== true
    && !(Number.isFinite(input.askNotBefore) && t < input.askNotBefore)
    && t >= seed.t + policy.askRearmSec;

  let current = seedTrack;
  let fromSi = s0;
  let selfFloor = null;
  for (let guard = 0; guard < 400; guard += 1) {
    const tr = trackById.get(current);
    /* 이 줄을 따라간다. 표본마다 대상 칸을 채우고, 같은 장의 다른 사람을 확실한 타인으로 기억한다. */
    let lastSi = fromSi;
    let switchTo = null;
    const obsBySi = new Map(tr.obs.map((o) => [o.si, o]));
    /* 대상 곁에 있던 사람(키 1.5배 안) — 그 사람이 대상과 한 상자로 겹쳐 사라졌다가 다시 갈라지는 순간을 잡는다. */
    const neighbors = new Map();
    /* 둘 다 보이는 채로 겹친 사람 → 겹치기 시작한 시각. 떨어지는 순간에 한 번만 가른다. */
    const contacts = new Map();
    for (let si = fromSi; si < samples.length; si += 1) {
      const ob = obsBySi.get(si);
      if (!ob) {
        /* 곁에 사람이 있는 채로 대상 검출이 비었다 — 그 사람과 한 덩어리로 잡혔을 수 있다. */
        if (policy.riskPartners) for (const [nid, nb] of neighbors) if (samples[si].t - nb.t < 0.45) markRisk(nid, si);
        if (samples[si].t - (samples[lastSi]?.t ?? samples[si].t) > policy.trackDeathSec) break;
        continue;
      }
      lastSi = si;
      state[si] = { kind: 'obs', trackId: current, box: ob.box, score: ob.score };
      targetObsTimes.add(si);
      const others = perSample[si].filter((r) => r.trackId !== current);
      for (const r of others) {
        if (!otherTracks.has(r.trackId)) otherTracks.add(r.trackId);
        if (r.obs.desc && otherDescs.length < 400 && !screenIds.has(r.trackId) && isolated(r.obs.box, [ob.box])) { otherDescs.push(r.obs.desc); otherDescOwner.push(r.trackId); }
      }
      if (isolated(ob.box, others.map((r) => r.obs.box))) remember(gallery, ob.desc, policy.galleryMax);
      const t = samples[si].t;
      /* 교차 ①: 곁에 있던 사람이 대상 상자에 묻혀 사라졌다가(한 상자로 합쳐짐) 대상 곁에서 새 줄로 갈라져 나왔다.
       * 검출이 한 덩어리로 잡는 동안 줄 번호가 엉뚱한 사람에게 남을 수 있다 — 겹치기 전 움직임·겉모습으로 다시 가른다. */
      const exchanges = [];
      for (const r of others) {
        const born = trackById.get(r.trackId).obs[0].si === si;
        const h = ob.box.height;
        const sizeOk = r.obs.box.height / h > 0.6 && r.obs.box.height / h < 1.67;
        if (born && sizeOk && !nearEdge(r.obs.box, frame, policy.edgeMargin) && centerDist(r.obs.box, ob.box) < 1.3 * h) {
          let vanished = null;
          for (const [nid, nb] of neighbors) {
            if (nb.h / h < 0.6 || nb.h / h > 1.67) continue;
            if (nid === r.trackId || nid === current || perSample[si].some((x) => x.trackId === nid)) continue;
            if (t - nb.t < 0.3 || t - nb.t > 3) continue;
            if (!vanished || nb.t > vanished.t) vanished = { id: nid, t: nb.t };
          }
          if (vanished) exchanges.push({ b: r.trackId, n: vanished.id, tMerge: vanished.t });
        }
        /* 교차 ②: 둘 다 보이는 채로 겹쳤다가 떨어졌다. */
        const dH = centerDist(ob.box, r.obs.box) / h;
        const iouHit = iou(ob.box, r.obs.box) >= policy.contactIou;
        if (sizeOk && (iouHit || dH < 0.8)) markRisk(r.trackId, si);
        const touching = sizeOk && (iouHit || (policy.contactDistH > 0 && dH < policy.contactDistH));
        if (touching && !contacts.has(r.trackId)) contacts.set(r.trackId, { t, minD: dH, minSi: si, iouHit });
        else if (touching) { const c = contacts.get(r.trackId); c.iouHit ||= iouHit; if (dH < c.minD) { c.minD = dH; c.minSi = si; } }
        else if (!touching && contacts.has(r.trackId)) {
          const c = contacts.get(r.trackId);
          exchanges.push({ b: r.trackId, n: r.trackId, tMerge: c.t, fromSi: policy.contactDistH > 0 ? c.minSi : null, distOnly: !c.iouHit });
          contacts.delete(r.trackId);
        }
      }
      /* 급변: 직전 움직임으로 내다본 자리에서 대상 줄이 크게 벗어났고, 다른 줄이 그 자리에 있다.
       * (벗어난 순간 견줄 사람이 없을 때 직전 움직임을 기억해 두고 다음 장에서 견주는 판은 dev 1851→1848 로 뺐다.) */
      if (policy.jumpDevMin > 0) {
        const hist = obsIn(tr, t - 0.85, t - 0.05).filter((o) => o.si >= fromSi);
        const v = velocity(hist);
        if (v && hist.length >= 3) {
          const last = hist.at(-1);
          /* 화면 좌표 속도라 카메라 이동이 이미 들어 있다. */
          const pred = shiftBox(last.box, v.x * (t - last.t), v.y * (t - last.t));
          const h = Math.max(1, last.box.height);
          const devA = centerDist(pred, ob.box) / h;
          if (devA > policy.jumpDevMin) {
            let best = null;
            for (const r of others) {
              if (forbidden.has(r.trackId)) continue;
              const ratio = r.obs.box.height / h;
              if (ratio < 0.6 || ratio > 1.67) continue;
              const devB = centerDist(pred, r.obs.box) / h;
              if (devB < devA * policy.jumpRatio && (!best || devB < best.devB)) best = { r, devB };
            }
            if (best && !exchanges.some((x) => x.b === best.r.trackId)) {
              exchanges.push({ b: best.r.trackId, n: best.r.trackId, tMerge: t, tSplit: t - 0.05 });
            }
          }
        }
      }
      for (const r of others) if (centerDist(r.obs.box, ob.box) < 1.5 * ob.box.height) neighbors.set(r.trackId, { t, h: r.obs.box.height });
      for (const ex of exchanges) {
        const verdict = judgeExchange({
          a: trackById.get(current), b: trackById.get(ex.b), n: trackById.get(ex.n),
          tMerge: ex.tMerge, tSplit: ex.tSplit ?? t, gallery, policy, distOnly: ex.distOnly === true,
        });
        const r = { trackId: ex.b };
        if (verdict && verdict.swap && !forbidden.has(r.trackId)) {
          /* 가장 가까웠던 순간부터 옮겨 탄다 — 그 뒤 갈라질 때까지 지금 줄은 이미 다른 사람 위였다. */
          const back = Number.isInteger(ex.fromSi) && ex.fromSi > fromSi && ex.fromSi < si ? ex.fromSi : si;
          for (let k = back; k < si; k += 1) { state[k] = null; targetObsTimes.delete(k); }
          switchTo = { trackId: r.trackId, si: back, verdict };
          break;
        }
        if (verdict && verdict.ambiguous && policy.crossingAsk && !forbidden.has(r.trackId) && mayAsk(samples[si].t) && !ask) {
          ask = { si, t: samples[si].t, reason: 'crossing-ambiguous', proposal: { trackId: verdict.pick, }, verdict };
        }
      }
      if (switchTo || ask) break;
    }
    segments.push({ trackId: current, fromSi, toSi: switchTo ? switchTo.si - 1 : lastSi });
    if (ask) break;
    if (switchTo) {
      decisions.push({ kind: 'swap', at: samples[switchTo.si].t, from: current, to: switchTo.trackId, ...switchTo.verdict });
      otherTracks.add(current);
      current = switchTo.trackId;
      fromSi = switchTo.si;
      continue;
    }
    /* 줄이 끝났다. 남은 구간이 없으면 끝. */
    if (lastSi >= samples.length - 1) break;
    const lostT = samples[lastSi].t;
    const lostBox = state[lastSi]?.box;
    const lostH = lostBox ? lostBox.height : 1;
    const exited = lostBox ? nearEdge(lostBox, frame, policy.edgeMargin * 2) : false;
    /* 2-0. 넘겨받기 — 곁의 다른 줄이 대상 상자를 가져갔다(검출 줄이 사람을 바꿔 닮). */
    const hand = policy.handoverMaxGapSec > 0 ? handoverAfterLoss({ tracks, current, lastSi, samples, shifts: built.shifts, forbidden, gallery, policy, lastObs: tr.obs.find((o) => o.si === lastSi) }) : null;
    if (hand) {
      decisions.push({ kind: 'handover', at: samples[hand.si].t, from: current, trackId: hand.trackId, cost: hand.cost, selfCost: hand.selfCost });
      for (let si = lastSi + 1; si < hand.si; si += 1) state[si] = null;
      current = hand.trackId;
      fromSi = hand.si;
      continue;
    }
    /* 2-가. 잠깐 끊긴 같은 사람 잇기 — 검출이 몇 장 비거나 여럿이 한 덩어리로 잡혀 줄이 끊긴 뒤, 움직임으로 내다본
     * 자리에 곧바로 새 줄이 생겼으면 그 사람이다. 같은 유니폼이 많은 경기는 겉모습으로 가를 수 없어, 여기서는
     * 자리·시간이 주 근거다(겉모습은 아주 다르지만 않으면 된다). */
    const stitch = policy.stitchMaxGapSec <= 0 ? null : stitchAfterLoss({ tracks, trackById, current, lastSi, samples, shifts: built.shifts, state, targetObsTimes,
      forbidden, gallery, policy, frame });
    if (stitch) {
      decisions.push({ kind: 'stitch', at: samples[stitch.firstSi].t, trackId: stitch.trackId, dist: stitch.dist, sim: stitch.sim, rival: stitch.rival });
      if (stitch.rival !== null && mayAsk(samples[stitch.firstSi].t)) {
        ask = { si: stitch.firstSi, t: samples[stitch.firstSi].t, reason: 'reentry-ambiguous', proposal: { trackId: stitch.trackId }, rival: stitch.rival };
        break;
      }
      for (let si = lastSi + 1; si < stitch.firstSi; si += 1) state[si] = null;
      current = stitch.trackId;
      fromSi = stitch.firstSi;
      continue;
    }
    /* 2-나. 다시 들어오는 사람 찾기 — 잃은 뒤에 새로 생긴 줄만, 끝까지 모두 본다. */
    const cands = [];
    for (const cand of tracks) {
      const partner = policy.riskPartners && partners.has(cand.id);
      if (cand.id === current || forbidden.has(cand.id) || (otherTracks.has(cand.id) && !partner)) continue;
      const born = cand.obs[0];
      const old = born.t <= lostT + 1e-6;
      if (old && !partner) continue;
      /* 짝은 놓친 뒤 부분만 본다. */
      const first = old ? cand.obs.find((o) => o.t > lostT + 1e-6) : born;
      if (!first) continue;
      if (cand.obs.some((o) => o.t >= first.t - 1e-6 && targetObsTimes.has(o.si))) continue;
      const gap = first.t - lostT;
      /* 들어온 자리: 화면 가장자리이거나(밖에서 들어옴), 잃은 자리 근처(가려졌다 나옴). */
      const camAcc = accumulatedShift(built.shifts, lastSi, first.si);
      const fromLost = lostBox ? centerDist(shiftBox(lostBox, camAcc.dx, camAcc.dy), first.box) / Math.max(lostH, first.box.height) : Infinity;
      const nearLimit = policy.occludedNearBase + policy.occludedNearPerSec * gap;
      const entering = nearEdge(first.box, frame, policy.edgeMargin * 2);
      const nearLoss = fromLost <= nearLimit;
      if (!entering && !nearLoss && !partner) continue;
      /* 그 사람의 처음 3초 겉모습. */
      const descs = cand.obs.filter((o) => o.t >= first.t - 1e-6 && o.t - first.t <= 3).map((o) => o.desc).filter(Boolean).slice(0, policy.trackDescMax);
      /* 짝은 위험한 순간 전의 대상 기억과 비교하고, 확실한 타인 기억에서 그 짝 자신의 모습은 뺀다. */
      const sim = galleryScore(partner && galleryAtRisk?.length ? galleryAtRisk : gallery, descs);
      const neg = galleryScore(partner ? otherDescs.filter((_, i) => otherDescOwner[i] !== cand.id) : otherDescs, descs);
      if (sim === null) continue;
      cands.push({ trackId: cand.id, firstSi: first.si, t: first.t, sim, neg: neg ?? 0, margin: sim - (neg ?? 0), entering, nearLoss, gap, fromLost, lastT: cand.obs.at(-1).t });
    }
    /* 대상 자신이 시간에 따라 얼마나 닮게 보였나(기억끼리의 닮음 중앙값). 후보는 이만큼에서 크게 떨어지면 안 된다 —
     * 확실한 타인이 하나도 없는 영상(혼자 찍힌 영상)에서 아무나 0.7 대로 닮아 보이는 것을 막는다. */
    /* 처음 잃었을 때의 값을 기준으로 붙든다 — 나중 기억에는 잘못 이은 구간이 섞일 수 있어 값이 내려간다. */
    const selfNow = gallerySelf(gallery);
    if (selfNow !== null) selfFloor = Math.max(selfFloor ?? 0, selfNow);
    const selfRef = selfFloor;
    const isQuick = (c) => policy.reentryNearFirstSec > 0 && c.nearLoss && c.gap <= policy.reentryNearFirstSec + 1e-6;
    const passing = cands.filter((c) => c.sim >= policy.reentrySimMin && c.margin >= policy.reentryMarginMin
      && (selfRef === null || c.sim >= selfRef - policy.reentrySelfDrop));
    decisions.push({ kind: 'lost', at: lostT, exited, candidates: cands.length, passing: passing.length, selfRef,
      cands: cands.map((c) => ({ id: c.trackId, t: c.t, sim: +c.sim.toFixed(3), neg: +c.neg.toFixed(3) })) });
    if (!passing.length) break;
    /* 놓친 자리 근처에 곧바로 나타난 통과 후보가 있으면 그들 중에서만 고른다 — 몇 초 뒤 다른 자리의 사람이 겉모습
     * 점수가 조금 높다고 바로 다음 순간 그 자리의 사람을 건너뛰지 않게. */
    const quick = passing.filter(isQuick);
    const pool = quick.length ? quick : passing;
    const best = pool.reduce((a, b) => (b.sim > a.sim ? b : a));
    /* 가장 닮은 사람과 거의 같으면 더 먼저 들어온 사람(진짜 재등장을 건너뛰지 않게). */
    const chosen = pool
      .filter((c) => c.sim >= best.sim - policy.reentryEarlierWithin)
      .reduce((a, b) => (b.t < a.t ? b : a));
    /* 같은 시각에 함께 보이는 다른 후보가 똑같이 닮았으면 가를 수 없다. */
    const rival = passing.find((c) => c.trackId !== chosen.trackId
      && c.t <= chosen.lastT && c.lastT >= chosen.t
      && Math.abs(c.sim - chosen.sim) < policy.reentryAmbiguous);
    decisions.push({ kind: 'reentry', at: chosen.t, trackId: chosen.trackId, sim: chosen.sim, neg: chosen.neg, rival: rival ? rival.trackId : null });
    /* 고른 사람이 뚜렷이 앞서지 않으면(같은 유니폼) 잇기 전에 묻는다. */
    const unsure = policy.askUnclearMargin > 0 && cands.some((c) => c.trackId !== chosen.trackId
      && Math.abs(c.t - chosen.t) <= policy.askUnclearWindowSec && c.sim > chosen.sim - policy.askUnclearMargin);
    if ((rival || unsure) && mayAsk(chosen.t)) {
      ask = { si: chosen.firstSi, t: chosen.t, reason: 'reentry-ambiguous', proposal: { trackId: chosen.trackId }, rival: rival ? rival.trackId : null };
      /* 없는 구간은 채워 둔다 — 묻는 시각까지. */
      for (let si = lastSi + 1; si < chosen.firstSi; si += 1) state[si] = { kind: 'absent', exited };
      break;
    }
    for (let si = lastSi + 1; si < chosen.firstSi; si += 1) state[si] = { kind: 'absent', exited, reentryAt: chosen.t };
    current = chosen.trackId;
    fromSi = chosen.firstSi;
  }
  /* 끝까지 못 찾은 나머지는 「없음」. */
  const endSi = ask ? ask.si : samples.length;
  let lastObsSi = -1;
  for (let si = s0; si < endSi; si += 1) {
    if (state[si]?.kind === 'obs') lastObsSi = si;
    else if (!state[si]) {
      /* 줄 안의 짧은 빈틈 — 앞뒤 같은 줄이면 잇는다. */
      state[si] = { kind: 'absent', exited: false };
    }
  }
  /* 앞뒤가 같은 줄인 빈틈은 가림(occluded)으로 바꿔 잇는다. */
  for (let si = s0; si < endSi; si += 1) {
    if (state[si]?.kind !== 'absent') continue;
    let a = si - 1; while (a >= s0 && state[a]?.kind !== 'obs') a -= 1;
    let b = si + 1; while (b < endSi && state[b]?.kind !== 'obs') b += 1;
    if (a >= s0 && b < endSi && state[a].trackId === state[b].trackId && samples[b].t - samples[a].t <= policy.trackDeathSec + 0.25) {
      for (let k = a + 1; k < b; k += 1) {
        const f = (samples[k].t - samples[a].t) / (samples[b].t - samples[a].t);
        state[k] = { kind: 'gap', trackId: state[a].trackId, box: lerpBox(state[a].box, state[b].box, f), long: samples[b].t - samples[a].t > policy.warnGapSec };
      }
    }
  }
  if (ask) {
    const tr = trackById.get(ask.proposal.trackId);
    const ob = tr?.obs.find((o) => o.si >= ask.si) ?? tr?.obs[0];
    ask.proposal.box = ob ? ob.box : null;
    ask.proposal.t = ob ? ob.t : ask.t;
    let lb = null;
    for (let si = Math.min(ask.si, samples.length - 1); si >= s0; si -= 1) if (state[si]?.kind === 'obs') { lb = state[si].box; break; }
    ask.lastBox = lb;
  }
  return {
    ok: true, seedTrack, seedOverlap: seedOv, s0, segments, state, ask, decisions,
    lastObsSi, galleryN: gallery.length, othersN: otherDescs.length,
    cues: cueCtx ? { adapted: cueCtx.adapted, useFg: cueCtx.useFg, w: cueCtx.w.map((x) => +x.toFixed(3)), disc: cueCtx.disc,
      selfN: cueCtx.selfN, ringN: cueCtx.ringN, othersN: cueCtx.othersN } : null,
    screenTracks: screenIds.size,
  };
}

/** 끊긴 대상 줄을 바로 이어 줄 새 줄. 없으면 null. rival = 거의 같은 자리에 함께 생겨 가를 수 없는 다른 줄. */
export function stitchAfterLoss({ tracks, trackById, current, lastSi, samples, shifts, targetObsTimes, forbidden, gallery, policy }) {
  const tr = trackById.get(current);
  const last = tr.obs.filter((o) => o.si <= lastSi).at(-1);
  if (!last) return null;
  const recent = tr.obs.filter((o) => o.t >= last.t - 1 && o.si <= lastSi);
  const v = velocity(recent) ?? { x: 0, y: 0 };
  const h = last.box.height;
  const selfRef = gallerySelf(gallery);
  const list = [];
  for (const cand of tracks) {
    if (cand.id === current || forbidden.has(cand.id)) continue;
    const first = cand.obs[0];
    const gap = first.t - last.t;
    if (gap <= 1e-6 || gap > policy.stitchMaxGapSec) continue;
    if (cand.obs.some((o) => targetObsTimes.has(o.si))) continue;
    const ratio = first.box.height / h;
    if (ratio < 0.6 || ratio > 1.67) continue;
    const cam = accumulatedShift(shifts, last.si, first.si);
    const pred = shiftBox(last.box, cam.dx + v.x * gap, cam.dy + v.y * gap);
    const dist = centerDist(pred, first.box) / Math.max(h, first.box.height);
    if (dist > policy.stitchNearBase + policy.stitchNearPerSec * gap) continue;
    const descs = cand.obs.filter((o) => o.t - first.t <= 2).map((o) => o.desc).filter(Boolean);
    const sim = galleryScore(gallery, descs);
    if (sim !== null && selfRef !== null && sim < selfRef - policy.stitchSelfDrop) continue;
    list.push({ trackId: cand.id, firstSi: first.si, dist, sim, cost: dist + 0.4 * gap + (sim === null ? 0.3 : 2 * Math.max(0, (selfRef ?? sim) - sim)) });
  }
  if (!list.length) return null;
  list.sort((a, b) => a.cost - b.cost);
  const best = list[0];
  const second = list.find((c) => c.trackId !== best.trackId && Math.abs(samples[c.firstSi].t - samples[best.firstSi].t) < 0.6);
  const rival = second && second.cost - best.cost < policy.stitchAmbiguous ? second.trackId : null;
  return { ...best, sim: best.sim === null ? null : +best.sim.toFixed(3), dist: +best.dist.toFixed(2), rival };
}

/** 상자 a(시각 ta) → b(시각 tb) 이음 비용 — 카메라 이동을 빼고, 못 본 시간만큼 거리를 너그럽게 본 위치 + 키 차. */
function joinCost(a, b, shifts, policy) {
  const cam = accumulatedShift(shifts, a.si, b.si);
  const dt = Math.max(0, b.t - a.t);
  const d = centerDist(shiftBox(a.box, cam.dx, cam.dy), b.box) / Math.max(1, a.box.height) / (1 + 2 * dt);
  return d + Math.abs(Math.log(b.box.height / Math.max(1, a.box.height)));
}

/**
 * 대상 줄이 lastSi 에서 끊긴 뒤, 이미 있던 다른 줄이 대상 자리를 넘겨받았나. 그 줄의 끊긴 뒤 첫 관측이
 * 대상 마지막 관측과는 잘 이어지고(cost) 그 줄 자기 직전 관측과는 덜 이어질 때(selfCost)만 — 다른 사람이 제 길을
 * 매끄럽게 가는 경우는 넘겨받지 않는다. 같은 유니폼이면 겉모습으로 가를 수 없어 자리·키가 주 근거다.
 */
export function handoverAfterLoss({ tracks, current, lastSi, samples, shifts, forbidden, gallery, policy, lastObs }) {
  if (!lastObs) return null;
  const selfRef = gallerySelf(gallery);
  let best = null;
  for (const cand of tracks) {
    if (cand.id === current || forbidden.has(cand.id)) continue;
    const k0 = cand.obs.findIndex((o) => o.si > lastSi);
    if (k0 <= 0) continue; /* 새로 생긴 줄은 재등장·잇기가 맡는다 */
    if (cand.obs[k0 - 1].t < lastObs.t - 0.5) continue; /* 오래 끊겼다 다시 나온 줄 */
    /* 끊긴 뒤 창 안의 관측마다 — 두 사람이 한 상자로 잡힌 장 다음에 넘겨받는 경우가 많다. */
    for (let k = k0; k < cand.obs.length && cand.obs[k].t - lastObs.t <= policy.handoverMaxGapSec + 1e-6; k += 1) {
      const ob = cand.obs[k], prev = cand.obs[k - 1];
      const cost = joinCost(lastObs, ob, shifts, policy);
      const selfCost = joinCost(prev, ob, shifts, policy);
      if (cost > policy.handoverMaxCost || cost + policy.handoverMargin > selfCost) continue;
      const descs = cand.obs.slice(k).filter((o) => o.t - ob.t <= 2).map((o) => o.desc).filter(Boolean);
      const sim = galleryScore(gallery, descs);
      if (sim !== null && selfRef !== null && sim < selfRef - policy.stitchSelfDrop) continue;
      if (!best || cost < best.cost) best = { trackId: cand.id, si: ob.si, cost: +cost.toFixed(3), selfCost: +selfCost.toFixed(3) };
      break;
    }
  }
  return best;
}

export function accumulatedShift(shifts, fromSi, toSi) {
  let dx = 0, dy = 0;
  for (let i = fromSi + 1; i <= toSi && i < shifts.length; i += 1) { dx += shifts[i].dx; dy += shifts[i].dy; }
  return { dx, dy };
}

/** 줄의 [from, to] 구간 관측. */
function obsIn(tr, from, to) { return tr ? tr.obs.filter((o) => o.t >= from - 1e-6 && o.t <= to + 1e-6) : []; }
/** 구간 처음·끝 관측으로 잰 속도(화소/초). 두 장 미만이면 null. */
function velocity(list) {
  if (list.length < 2) return null;
  const a = list[0], b = list[list.length - 1];
  const dt = b.t - a.t;
  if (dt < 0.3) return null;
  return { x: (cx(b.box) - cx(a.box)) / dt, y: (cy(b.box) - cy(a.box)) / dt };
}
const vdist = (p, q) => (p && q ? Math.hypot(p.x - q.x, p.y - q.y) : null);
function meanSim(listA, listB) {
  const a = listA.map((o) => o.desc).filter((d) => d && d.samples >= 60);
  const b = listB.map((o) => o.desc).filter((d) => d && d.samples >= 60);
  if (!a.length || !b.length) return null;
  let s = 0, n = 0;
  for (const x of a) for (const y of b) { s += similarity(x, y) ?? 0; n += 1; }
  return s / n;
}

/**
 * 두 사람이 겹쳤다 갈라진 뒤 누가 대상인가 — a(지금 대상 줄)·b(갈라져 나온/겹친 줄)·n(겹치기 전 곁에 있던 사람).
 * 겹치기 전 대상(a)·곁 사람(n)의 움직임·겉모습을, 갈라진 뒤 a·b 와 짝지어 어느 짝이 더 그럴듯한지 본다.
 *   swap      b 쪽이 대상(옮겨 탄다)
 *   ambiguous 움직임도 겉모습도 가르지 못한다(묻는다 — 바로 묻기를 켠 경우만)
 */
export function judgeExchange({ a, b, n, tMerge, tSplit, gallery, policy = LINKED_POLICY, distOnly = false }) {
  if (!a || !b || !n) return null;
  if (distOnly && policy.contactDistinctMax < 1) {
    const pair = meanSim(obsIn(a, tMerge - 1.5, tMerge - 0.05), obsIn(n, tMerge - 1.5, tMerge - 0.05));
    if (pair === null || pair > policy.contactDistinctMax) return null;
  }
  const preA = obsIn(a, tMerge - 1.5, tMerge - 0.05);
  const preN = obsIn(n, tMerge - 1.5, tMerge);
  const postA = obsIn(a, tSplit + 0.05, tSplit + 1.6);
  const postB = obsIn(b, tSplit, tSplit + 1.6);
  if (postA.length < 2 || postB.length < 2) return null;
  const h = Math.max(1, (preA.at(-1) ?? postA[0]).box.height);
  /* 움직임: 겹치기 전 방향을 갈라진 뒤에도 이어 가는 짝. */
  const vT = velocity(preA), vN = n === b ? velocity(obsIn(b, tMerge - 1.5, tMerge - 0.05)) : velocity(preN);
  const vA = velocity(postA), vB = velocity(postB);
  let motion = 0;
  const kA = vdist(vA, vT), kB = vdist(vB, vN), sA = vdist(vB, vT), sB = vdist(vA, vN);
  if (kA !== null && sA !== null) {
    const keep = kA + (kB ?? 0), swap = sA + (sB ?? 0);
    motion = Math.max(-3, Math.min(3, (keep - swap) / h));
  }
  /* 겉모습: 겹치기 전 대상 모습(없으면 기억)·곁 사람 모습과의 짝. */
  const preAref = preA.length ? preA : [];
  const preNref = n === b ? obsIn(b, tMerge - 1.5, tMerge - 0.05) : preN;
  let app = 0;
  const gA = galleryScore(gallery, postA.map((o) => o.desc).filter(Boolean));
  const gB = galleryScore(gallery, postB.map((o) => o.desc).filter(Boolean));
  const tA = meanSim(preAref, postA), tB = meanSim(preAref, postB);
  const nA = meanSim(preNref, postA), nB = meanSim(preNref, postB);
  if (tA !== null && tB !== null && nA !== null && nB !== null) app = (tB + nA) - (tA + nB);
  else if (gA !== null && gB !== null) app = gB - gA;
  const score = 8 * app + 0.6 * motion;
  const swap = score > policy.swapScoreMin && app >= policy.swapAppMin;
  const keep = score < -0.6;
  return { swap, ambiguous: !swap && !keep, pick: score > 0 ? b.id : a.id, score: +score.toFixed(3), app: +app.toFixed(3), motion: +motion.toFixed(3) };
}

/**
 * 표본 상태 → 편집기 궤적(초당 outFps 점). 상자는 분석 화면 화소.
 * 상태: 검출 위 = TRACKING_OK, 줄 안의 긴 빈틈 = TRACKING_WARNING, 짧은 빈틈 = TRACKING_OK,
 *       대상이 화면에 없음 = TARGET_LOST + engineAbsent(묻지 않는다 — 없다는 근거가 있다).
 */
export function renderTrajectory(samples, link, opts) {
  const { startT, endT } = opts;
  const fps = opts.outFps ?? LINKED_POLICY.outFps;
  const out = [];
  const { state, s0 } = link;
  const lastSi = link.ask ? link.ask.si : samples.length - 1;
  let lastBox = null;
  const n = Math.max(1, Math.floor((Math.min(endT, samples[lastSi]?.t ?? endT) - startT) * fps + 1e-6));
  let si = s0;
  for (let i = 0; i <= n; i += 1) {
    const t = Math.min(startT + i / fps, endT);
    while (si + 1 <= lastSi && samples[si + 1].t <= t + 1e-6) si += 1;
    const a = state[si];
    const b = si + 1 <= lastSi ? state[si + 1] : null;
    const ta = samples[si].t, tb = b ? samples[si + 1].t : ta;
    const live = (s) => s && (s.kind === 'obs' || s.kind === 'gap');
    let row;
    if (live(a) && live(b) && a.trackId === b.trackId && tb > ta) {
      const f = Math.max(0, Math.min(1, (t - ta) / (tb - ta)));
      const box = lerpBox(a.box, b.box, f);
      const warn = (a.kind === 'gap' && a.long) || (b.kind === 'gap' && b.long);
      row = { t, box, state: warn ? 'TRACKING_WARNING' : 'TRACKING_OK', confidence: warn ? 0.55 : 0.9, health: warn ? 0.55 : 0.9, reid: 0.9 };
    } else if (live(a) && t - ta < 0.5 / LINKED_POLICY.sampleHz + 1e-6) {
      const warn = a.kind === 'gap' && a.long;
      row = { t, box: { ...a.box }, state: warn ? 'TRACKING_WARNING' : 'TRACKING_OK', confidence: warn ? 0.55 : 0.9, health: warn ? 0.55 : 0.9, reid: 0.9 };
    } else if (live(b) && tb - t < 0.5 / LINKED_POLICY.sampleHz + 1e-6) {
      row = { t, box: { ...b.box }, state: 'TRACKING_OK', confidence: 0.85, health: 0.85, reid: 0.9 };
    } else {
      row = { t, box: lastBox ? { ...lastBox } : { x: 0, y: 0, width: 0, height: 0 }, state: 'TARGET_LOST', confidence: 0, health: 0, reid: 0, engineAbsent: true };
    }
    if (row.state !== 'TARGET_LOST') lastBox = row.box;
    row.frame = i;
    out.push(row);
  }
  return out;
}
