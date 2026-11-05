/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·3f70f3aa @license @preserve */
/* HILIT Tracklets — 화면의 **모든** 사람을 짧은 궤적으로 이어 붙인다.
 *
 * 가중치가 없다. 검출 상자와 시간만 쓴다. 그래서 어떤 검출기를 쓰든,
 * 상업적 권리 문제 없이 그대로 얹힌다.
 *
 * ## ⚠️ 아직 추적 파이프라인에 연결하지 않았다 — 왜인지 적어 둔다
 *
 * 이 모듈은 만들고, 검사를 붙이고, 실제 영상에 **연결해 봤고, 되돌렸다.**
 * 세 가지 방식으로 붙여 보고 전부 나빠졌다(겹침 영상, 정답 18개 기준).
 *
 *   연결하지 않음 (현재)                       16 / 18
 *   "같이 보였으면 거절" 규칙 적용               3 / 18
 *   "우리 궤적을 후보 맨 앞으로" (긍정만)        5 / 18
 *   위를 제자리 구간으로만 좁힘                  6 / 18
 *
 * 원인은 규칙이 아니라 **번호를 맬 수 있는 근거**였다. 지금 파이프라인의
 * 주 신호는 상관 추적기(template)와 칼만 필터이고, 검출은 세 프레임에 한
 * 번쯤 확인용으로 돈다. 그러면 궤적 번호를 다시 맬 기회가 드물고, 한 번
 * 잘못 매면 그 오류가 스스로를 강화한다 — 우리 번호가 옆 사람에게 붙는
 * 순간, 진짜 대상의 궤적은 "나와 같이 보인 남" 이 되어 영구히 거절된다.
 * 강한 규칙이 틀린 전제 위에 서면 틀림도 강해진다.
 *
 * 이 층이 값을 내려면 **검출이 매 프레임 도는 구조**(ByteTrack 처럼 검출을
 * 주 신호로 두는 구조)로 먼저 바꿔야 한다. 그건 파이프라인의 골격을 바꾸는
 * 일이라 따로 한다. 그래서 이 모듈은 **그 작업을 위한 기반**으로 남겨
 * 둔다 — 물리 상한(frame-guard)을 공유하고, 검사로 동작이 고정돼 있다.
 *
 * 기록: 패치노트 0.30 (트래킹 정교화 · 겹침과 닮은 사람).
 *
 * ## 왜 필요한가 — 우리 실패의 공통 원인
 *
 * 지금까지 우리는 "이 프레임의 검출들" 과 "우리 상자" 만 비교했다. 그러면
 * 프레임을 넘길 때마다 **누가 누구였는지를 잊는다.** 실측 셋이 같은 곳을
 * 가리킨다.
 *
 *   겹침 영상 2.3초   대상 검출이 한 프레임 빠졌다 -> 옆 사람(cx 0.864)을
 *                     "가장 가까운 후보" 로 받아들였다. 그 사람이 1초 전
 *                     부터 계속 거기 서 있던 **다른 사람**이라는 사실을
 *                     우리는 모른다
 *   이동 영상 12초    대상이 오른쪽으로 이동 중인데 제자리에 서 있던
 *                     사람을 받아들였다. 두 사람의 **과거**를 보면 헷갈릴
 *                     이유가 없었다
 *   턴 영상 26초      가림꾼이 지나간 뒤 옆 사람에게 정착. 역시 과거를
 *                     보면 그 사람은 줄곧 다른 자리에 있었다
 *
 * ## 핵심 규칙 — 같이 보였으면 다른 사람이다
 *
 * 사람은 동시에 두 곳에 있을 수 없다. 그러므로
 *
 *   **우리 대상과 같은 프레임에 함께 보인 궤적은 대상이 아니다.**
 *
 * 이 규칙은 옷이 똑같아도, 헬멧 색이 같아도, 체형이 같아도 성립한다.
 * 외형으로 가를 수 없는 장면(같은 유니폼 · 같은 헬멧)에서 우리가 쓸 수
 * 있는 가장 강한 신호다. 그리고 계산이 거의 들지 않는다 — 상자 몇 개의
 * 거리 계산뿐이다.
 *
 * ## 무엇을 하지 않는가
 *
 * 이건 완전한 다중 객체 추적기(MOT)가 아니다. 몇 초짜리 짧은 궤적만
 * 유지하고, 오래 가려진 사람을 다시 같은 번호로 잇는 일(장기 재식별)은
 * 하지 않는다. 우리에게 필요한 것은 "지금 화면에 있는 사람들이 조금 전
 * 어디 있었나" 뿐이다. 그 이상은 비용만 늘린다.
 *
 * 착상은 SORT(Bewley et al. 2016)와 ByteTrack(Zhang et al. 2022)의
 * 연관 단계다. 다만 칼만 필터 대신 등속 예측을 쓰고, 게이트는 우리
 * frame-guard 의 물리 상한(maxStep)을 그대로 재사용한다 — 두 곳에서
 * 다른 물리를 쓰면 언젠가 어긋난다.
 * https://arxiv.org/abs/1602.00763 · https://arxiv.org/abs/2110.06864
 */
import { maxStep, type GuardBox } from './frame-guard';

export interface TrackletBox extends GuardBox {}

export interface Tracklet {
  /** 궤적 번호. 한 번 준 번호는 그 궤적이 죽을 때까지 바뀌지 않는다. */
  id: number;
  box: TrackletBox;
  /** 화소/초. 등속 예측에만 쓴다. */
  vx: number;
  vy: number;
  /** 이 궤적을 마지막으로 본 시각(초). */
  lastT: number;
  /** 처음 본 시각(초). */
  startT: number;
  /** 검출이 붙은 횟수. 1~2 짜리 궤적은 잡음일 수 있다. */
  hits: number;
  /** 붙지 않고 지나간 검출 프레임 수. */
  misses: number;
}

export interface TrackletCameraWarp {
  a: number;
  b: number;
  tx: number;
  c: number;
  d: number;
  ty: number;
}

export interface TrackletOptions {
  /** 검출이 돌아간 시각(초). */
  t: number;
  /** 이 프레임의 사람 상자들. */
  detections: ReadonlyArray<TrackletBox>;
  /**
   * 궤적을 몇 번 놓치면 버리나.
   *
   * 3 은 검출 주기의 세 배다. 사람이 다른 사람 뒤로 완전히 들어가는
   * 시간(0.5~1초)을 덮으면서, 오래 전에 사라진 사람을 붙잡고 있지는
   * 않는 값이다.
   */
  maxMisses?: number;
  /**
   * 이전 프레임 상자를 현재 카메라로 옮기는 아핀.
   * 저장 좌표를 바꾸지 않고 **예측 상자만** 옮긴다.
   */
  cameraWarp?: TrackletCameraWarp | null;
}

export const DEFAULT_MAX_MISSES = 3;

/** 두 상자가 겹치는 비율(IoU). 0 이면 전혀 안 겹친다. */
export function iou(a: TrackletBox, b: TrackletBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

function centre(b: TrackletBox) {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * 짧은 궤적 저장소.
 *
 * 검출이 돌아간 프레임마다 `update` 를 부른다. 검출이 안 돌아간 프레임은
 * 부르지 않는다 — 이 저장소는 검출을 이어 붙이는 것이 일이고, 예측만으로
 * 궤적을 늘리면 우리가 만든 값으로 우리를 확신하게 된다.
 */
export class TrackletStore {
  private items: Tracklet[] = [];
  private nextId = 1;

  /** 지금 살아 있는 궤적들. 오래된 것 → 최신 순서는 보장하지 않는다. */
  get all(): ReadonlyArray<Tracklet> { return this.items; }

  /**
   * 이 프레임의 검출들을 기존 궤적에 이어 붙인다.
   *
   * @returns 검출 순서대로의 궤적 번호. 새로 생긴 궤적도 번호를 받는다.
   */
  update(options: TrackletOptions): number[] {
    const { t, detections } = options;
    const maxMisses = options.maxMisses ?? DEFAULT_MAX_MISSES;

    /* 1) 예측. 마지막으로 본 자리에서 등속으로 나아간 자리를 쓴다.
     *
     * 예측은 **연결에만** 쓰고 궤적의 위치로 저장하지 않는다. 저장까지
     * 하면 검출 없이도 궤적이 움직이고, 그러면 "같이 보였다" 는 사실이
     * 사실이 아니게 된다. */
    const predicted = this.items.map((item) => {
      const dt = Math.max(0, t - item.lastT);
      let box: TrackletBox = {
        x: item.box.x + item.vx * dt,
        y: item.box.y + item.vy * dt,
        width: item.box.width,
        height: item.box.height,
      };
      const W = options.cameraWarp;
      if (W && [W.a, W.b, W.tx, W.c, W.d, W.ty].every(Number.isFinite)) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const nx = W.a * cx + W.b * cy + W.tx;
        const ny = W.c * cx + W.d * cy + W.ty;
        const scale = Math.sqrt(Math.abs(W.a * W.d - W.b * W.c));
        const s = Number.isFinite(scale) && scale > 0.2 ? scale : 1;
        box = {
          x: nx - (box.width * s) / 2,
          y: ny - (box.height * s) / 2,
          width: box.width * s,
          height: box.height * s,
        };
      }
      return { item, box, dt };
    });

    /* 2) 모든 (궤적 × 검출) 짝의 비용을 재고 싼 것부터 고른다.
     *
     * 헝가리안 알고리즘이 최적이지만, 한 프레임에 사람 서른 명이면 짝이
     * 900개다. 탐욕법으로 충분하다 — 우리가 푸는 문제에서 애매한 짝은
     * 애초에 물리 상한에서 걸러진다. */
    const pairs: Array<{ ti: number; di: number; cost: number }> = [];
    for (let ti = 0; ti < predicted.length; ti += 1) {
      const { item, box, dt } = predicted[ti];
      for (let di = 0; di < detections.length; di += 1) {
        const det = detections[di];
        const pc = centre(box);
        const dc = centre(det);
        const moved = Math.hypot(dc.x - pc.x, dc.y - pc.y);
        /* 물리 상한은 frame-guard 와 같은 함수를 쓴다.
         * 사람마다 자기 몸 너비로 재므로 멀리 있는 사람에게도 맞는다. */
        const limit = maxStep({
          dt: Math.max(dt, 1e-3),
          bodyWidth: Math.max(8, item.box.width),
        });
        if (moved > limit) continue;             // 사람이 못 가는 거리다
        const overlap = iou(box, det);
        /* 비용은 거리(몸 너비 배수)에서 겹침을 빼서 만든다. 겹치면
         * 같은 사람일 가능성이 높으므로 비용이 내려간다. */
        const cost = moved / Math.max(8, item.box.width) - overlap;
        pairs.push({ ti, di, cost });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);

    const takenT = new Set<number>();
    const takenD = new Set<number>();
    const assigned: number[] = new Array(detections.length).fill(0);
    for (const pair of pairs) {
      if (takenT.has(pair.ti) || takenD.has(pair.di)) continue;
      takenT.add(pair.ti);
      takenD.add(pair.di);
      const { item } = predicted[pair.ti];
      const det = detections[pair.di];
      const dt = Math.max(1e-3, t - item.lastT);
      const from = centre(item.box);
      const to = centre(det);
      /* 속도는 조금씩만 갱신한다(0.5). 한 프레임의 검출 떨림이 그대로
       * 속도가 되면 예측이 사방으로 튄다. */
      item.vx = item.vx * 0.5 + ((to.x - from.x) / dt) * 0.5;
      item.vy = item.vy * 0.5 + ((to.y - from.y) / dt) * 0.5;
      item.box = { ...det };
      item.lastT = t;
      item.hits += 1;
      item.misses = 0;
      assigned[pair.di] = item.id;
    }

    /* 3) 짝을 못 찾은 검출은 새 사람이다. */
    for (let di = 0; di < detections.length; di += 1) {
      if (takenD.has(di)) continue;
      const det = detections[di];
      const item: Tracklet = {
        id: this.nextId, box: { ...det }, vx: 0, vy: 0,
        lastT: t, startT: t, hits: 1, misses: 0,
      };
      this.nextId += 1;
      this.items.push(item);
      assigned[di] = item.id;
    }

    /* 4) 짝을 못 찾은 궤적은 놓친 것으로 세고, 오래되면 버린다. */
    for (let ti = 0; ti < predicted.length; ti += 1) {
      if (takenT.has(ti)) continue;
      predicted[ti].item.misses += 1;
    }
    this.items = this.items.filter((item) => item.misses <= maxMisses);

    return assigned;
  }

  /** 번호로 찾는다. 없으면 null. */
  find(id: number | null): Tracklet | null {
    if (id === null) return null;
    return this.items.find((item) => item.id === id) ?? null;
  }

  /**
   * 이 상자와 가장 많이 겹치는 궤적. 겹치는 것이 없으면 null.
   *
   * 우리 대상을 궤적에 **묶는** 데 쓴다. 연관이 받아들여진 프레임에서만
   * 부른다 — 확실한 순간에만 번호를 바꿔 매야 한다.
   */
  bind(box: TrackletBox, minIou = 0.3): Tracklet | null {
    let best: Tracklet | null = null;
    let bestIou = minIou;
    for (const item of this.items) {
      const overlap = iou(item.box, box);
      if (overlap > bestIou) { bestIou = overlap; best = item; }
    }
    return best;
  }

  /**
   * 🔴 이 궤적이 우리 대상과 **같은 프레임에 함께 보였나**.
   *
   * 함께 보였다면 다른 사람이다. 사람은 동시에 두 곳에 있을 수 없다.
   * 이 한 줄이 "같은 옷을 입은 사람이 셋" 인 장면에서 외형보다 강하다.
   *
   * @param id      검사할 궤적 번호
   * @param mineId  우리 대상이 묶여 있는 궤적 번호
   * @param window  이만큼(초) 안에 함께 보인 것만 근거로 삼는다
   */
  coVisible(id: number, mineId: number | null, window = 1.5): boolean {
    if (mineId === null || id === mineId) return false;
    const mine = this.find(mineId);
    const other = this.find(id);
    if (!mine || !other) return false;
    /* 둘 다 최근에 살아 있었고, 살아 있던 구간이 겹치면 함께 보인 것이다. */
    const overlapStart = Math.max(mine.startT, other.startT);
    const overlapEnd = Math.min(mine.lastT, other.lastT);
    if (overlapEnd < overlapStart) return false;
    const recent = Math.max(mine.lastT, other.lastT) - overlapEnd <= window;
    return recent;
  }
}
