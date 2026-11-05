/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·666c337d @license @preserve */
/* HILIT Template — 어디에 있는지 정확히 짚는다.
 *
 * ## 왜 색 히스토그램만으로는 안 되나 — 실측으로 드러났다
 *
 * 히스토그램은 **화소를 세는** 것이라 순서를 모른다. 사람을 조금 옮겨
 * 잘라도 세어지는 색은 거의 같다. 그래서 "이 사람이 맞나" 에는 강하고
 * "정확히 어디 있나" 에는 약하다.
 *
 * 시뮬레이션이 그 약점을 그대로 보여줬다. 예측 자리 둘레를 훑었는데
 * 유사도가 0.906 / 0.905 / 0.929 처럼 평평했다. 어느 자리가 맞는지
 * 고를 수 없으니 **탐색 중심(=예측 자리)에 가까운 것이 뽑히고**, 그
 * 관측이 다시 예측을 밀어 준다. 예측이 스스로를 확인하는 고리가 생겨
 * 몇 프레임 만에 대상을 앞질러 달아났다.
 *
 *   프레임 5   정답 0.492   추적 0.489
 *   프레임 9   정답 0.510   추적 0.523
 *   프레임 11  정답 0.521   추적 0.725   ← 다른 곳
 *
 * ## 그래서 짝을 이룬다
 *
 *   히스토그램   "이 사람이 맞나"     — 옮겨져도 안 변한다(강점)
 *   템플릿 대조   "정확히 어디 있나"   — 옮기면 확 변한다(강점)
 *
 * 둘은 서로의 약점을 메운다. NanoTrack 이 학습된 특징으로 상관을 재던
 * 자리이고, 우리는 밝기 값으로 잰다.
 *
 * ## 왜 정규화 상호상관(NCC)인가
 *
 * 그냥 차이(SSD)를 재면 밝기가 조금만 변해도 값이 망가진다. 구름이
 * 지나가거나 조명이 흔들리면 같은 사람인데 점수가 떨어진다.
 *
 * NCC 는 두 조각에서 각자의 평균을 빼고 각자의 표준편차로 나눈 뒤
 * 곱해서 더한다. 그래서 **전체 밝기와 대비가 달라져도 모양이 같으면
 * 1에 가깝다.** 고전 영상처리의 기본 도구다.
 *
 * ## 왜 회색인가
 *
 * 색은 이미 히스토그램이 맡는다. 여기서 필요한 것은 **모양**이고,
 * 모양은 밝기 변화에 담긴다. 세 채널을 다 재면 계산이 세 배인데
 * 얻는 것이 거의 없다.
 */

/** 템플릿 크기. 작아도 모양은 남는다 — 그리고 후보마다 도는 계산이다. */
export const TPL_W = 24;
export const TPL_H = 48;

export interface Template {
  /** 평균을 뺀 값. 미리 빼 두면 대조할 때마다 다시 안 빼도 된다. */
  values: Float32Array;
  /** 표준편차. 0 이면 밋밋한 조각이라 대조가 무의미하다. */
  deviation: number;
}

/** 빈 템플릿 — 아직 못 만들었거나 밋밋한 조각. */
const EMPTY: Template = { values: new Float32Array(TPL_W * TPL_H), deviation: 0 };

/**
 * 가운데를 무겁게, 가장자리를 가볍게 보는 창(window).
 *
 * ## 왜 필요한가
 *
 * 사람을 감싼 상자에는 사람만 있지 않다. 네 귀퉁이는 거의 배경이다 —
 * 테니스 코트, 빙판, 관중석. 그 배경을 사람과 똑같은 무게로 대조하면
 * **상자를 옆으로 옮겨도 배경이 여전히 잘 맞아서** 점수가 잘 안
 * 떨어진다. 어디가 맞는 자리인지 봉우리가 서지 않는다.
 *
 * 가장자리를 눌러 두면 대조에 실제로 기여하는 것은 가운데의 사람이고,
 * 그러면 조금만 어긋나도 점수가 뚝 떨어진다. 그게 우리가 원하는 것이다.
 *
 * 상관 필터(MOSSE·KCF 계열)가 오래전부터 쓰던 방법이고, 코사인 창은
 * 고전 신호처리의 기본 도구라 라이선스 문제가 없다.
 *
 * 세로를 가로보다 덜 누른다. 사람은 세로로 길어서 위아래 끝까지가
 * 대체로 사람이지만, 좌우 끝은 대체로 배경이다.
 */
const WINDOW = (() => {
  const w = new Float32Array(TPL_W * TPL_H);
  for (let y = 0; y < TPL_H; y += 1) {
    /* 해닝 창: 0 → 1 → 0. 세로는 0.35 만큼만 눌러 바닥을 남긴다. */
    const wy = 0.65 + 0.35 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / TPL_H));
    for (let x = 0; x < TPL_W; x += 1) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / TPL_W);
      w[y * TPL_W + x] = wx * wy;
    }
  }
  return w;
})();

/**
 * 회색조 조각에서 템플릿을 만든다.
 *
 * @param gray  TPL_W × TPL_H 로 줄여 둔 밝기 값 (0~255)
 */
export function makeTemplate(gray: Uint8Array | Uint8ClampedArray): Template {
  const n = TPL_W * TPL_H;
  if (gray.length < n) return EMPTY;

  /* 평균도 창으로 잰다. 가장자리 배경이 평균을 끌고 가면 가운데
   * 사람이 통째로 밝거나 어두운 쪽으로 치우친다. */
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < n; i += 1) {
    sum += gray[i] * WINDOW[i];
    weight += WINDOW[i];
  }
  const mean = sum / weight;

  const values = new Float32Array(n);
  let sq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = (gray[i] - mean) * WINDOW[i];
    values[i] = v;
    sq += v * v;
  }
  const deviation = Math.sqrt(sq / n);

  /* 밋밋한 조각(하늘·빙판·벽)은 템플릿이 될 수 없다. 어디에 대도
   * 비슷하게 맞아서 위치를 못 짚는다. */
  /* 창으로 누른 만큼 값 자체가 작아진다(평균 무게 약 0.4). 문턱도
   * 그만큼 내린다 — 안 내리면 멀쩡한 조각까지 밋밋하다고 버린다. */
  return deviation < 1.8 ? EMPTY : { values, deviation };
}

/**
 * 두 조각이 얼마나 닮았나 — −1 ~ 1.
 *
 * 1 이면 모양이 같다. 0 이면 무관하다. 음수는 밝고 어두움이 뒤집혔다는
 * 뜻이고, 그건 다른 것이다.
 *
 * 한쪽이라도 밋밋하면 0 을 준다 — "모르겠다" 다.
 */
export function correlate(a: Template, b: Template): number {
  if (a.deviation <= 0 || b.deviation <= 0) return 0;
  const n = TPL_W * TPL_H;
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a.values[i] * b.values[i];
  return Math.max(-1, Math.min(1, dot / (n * a.deviation * b.deviation)));
}

/**
 * 템플릿을 지금 모습으로 조금씩 옮긴다.
 *
 * ## 왜 조금씩인가
 *
 * 사람은 돌고 팔을 흔든다. 처음 모습만 들고 있으면 몇 초 뒤에는 안
 * 닮게 되고, 그때 추적이 끊긴다.
 *
 * 그렇다고 매번 통째로 갈아치우면 **틀린 것을 한 번 잡았을 때 그것이
 * 새 기준이 된다.** 그다음부터는 틀린 것을 정답이라고 믿으며 따라간다 —
 * 되돌릴 방법이 없다(identity poisoning).
 *
 * 그래서 천천히 섞는다. 한 번 잘못 잡아도 다음 프레임들이 되돌린다.
 *
 * ## 그리고 확신할 때만
 *
 * 부르는 쪽이 "히스토그램도 같은 사람이라고 한다" 를 확인한 뒤에만
 * 부른다. 위치만 맞고 사람이 다르면 갱신하면 안 된다.
 */
export function blendTemplate(base: Template, now: Template, rate = 0.08): Template {
  if (base.deviation <= 0) return now;
  if (now.deviation <= 0) return base;

  const n = TPL_W * TPL_H;
  const values = new Float32Array(n);
  let sq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = base.values[i] * (1 - rate) + now.values[i] * rate;
    values[i] = v;
    sq += v * v;
  }
  return { values, deviation: Math.sqrt(sq / n) };
}
