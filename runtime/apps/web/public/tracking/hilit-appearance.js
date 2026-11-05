/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·84de039c @license @preserve */
/* HILIT Appearance — 사람의 겉모습을 숫자로. 가중치가 없다.
 *
 * 🔴 정본은 `packages/hilit-vision/src/appearance.ts` 다. 거기에 검사가
 *    붙어 있다(21개). 이 파일은 추적 엔진이 쓰는 **런타임 사본**이다 —
 *    엔진은 번들 밖의 ESM 이라 패키지를 import 할 수 없다.
 *    한쪽을 고치면 반드시 다른 쪽도 고친다.
 *
 * ## 무엇을 대신하나
 *
 * OSNet(연구용 MSMT17 가중치, 8.7MB)이 있던 자리다. 그런데 그 모델은
 * **웹에서 애초에 안 돌고 있었다** — ONNX Runtime Web 이
 * InstanceNormalization 을 지원하지 않아 세션이 안 열린다(models.js 의
 * 벤치마크 표에 "실패" 로 적혀 있다). 그래서 Health 의 Re-ID 신호에
 * 상수 1이 들어가 있었고, 가중 0.40 짜리 항목과 reid_veto 가 죽어 있었다.
 *
 * 즉 이건 **없던 기능을 새로 켜는 것**이다. 8.7MB 를 내려받지 않게 되고,
 * 연구용 라이선스 의존이 사라지고, 외형 신호가 처음으로 실제로 돈다.
 *
 * ## 어떻게
 *
 * 사람을 세로 세 띠(머리 25% · 상의 45% · 하의 30%)로 나누고 각 띠에서
 * HSV 색조 히스토그램을 만든다. 채도가 낮은 화소는 색조 대신 밝기 칸에
 * 센다 — 흰 옷과 검은 옷을 가르는 것이 그 칸이다.
 *
 * 왜 HSV 인가: 같은 흰 티셔츠가 그늘에 들어가면 RGB 세 값이 모두
 * 내려가 다른 색이 된다. HSV 는 색조를 밝기와 분리하므로 그늘에서도
 * 색조가 유지된다. 경기장 조명이 고르지 않은 우리 영상에서 중요하다.
 */

const HUE_BINS = 12;
const GRAY_BINS = 4;
const GRAY_SAT = 0.18;
const BAND_BINS = HUE_BINS + GRAY_BINS;
const BANDS = [0.25, 0.45, 0.30];
const BAND_WEIGHT = [0.8, 2.0, 1.0];
export const DESCRIPTOR_SIZE = BANDS.length * BAND_BINS + BANDS.length * 2;

/** 서술자를 만들 crop 크기. 작아도 색 분포는 살아남는다. */
export const CROP_W = 48;
export const CROP_H = 96;

function toHsv(r, g, b) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
    else if (max === gg) h = ((bb - rr) / d + 2) / 6;
    else h = ((rr - gg) / d + 4) / 6;
  }
  return [h, max > 1e-6 ? d / max : 0, max];
}

/**
 * rgba 화소 배열(ImageData.data)에서 서술자를 만든다.
 *
 * @param background  상자 **바깥**에서 같은 방식으로 만든 서술자.
 *                    주면 배경에 흔한 색을 억눌러 준다.
 *
 * ## 왜 커널 가중인가
 *
 * 처음에는 좌우 15% 만 잘라내고 나머지를 똑같이 셌다. 그랬더니 피겨
 * 영상에서 **같은 사람의 유사도가 0.24** 로 나왔다 — 다른 자리(0.22)와
 * 구분이 안 됐다.
 *
 * 원인은 크기다. 그 영상의 대상 상자는 640×360 기준 **32×78 픽셀**이고,
 * 그 안에서 사람이 차지하는 면적은 절반이 안 된다. 나머지는 배경인데,
 * 사람이 어두운 무대 앞에서 밝은 빙판으로 이동하는 동안 그 배경이 통째로
 * 바뀐다. 배경이 서술자를 지배한 것이다.
 *
 * 사람은 상자의 **가운데**에 있다. 그래서 가운데 화소에 무게를 더 준다.
 * 가장자리로 갈수록 0에 가까워지는 종 모양 가중이고, Comaniciu·Ramesh·
 * Meer 의 커널 기반 추적(2003)이 같은 이유로 같은 것을 쓴다.
 *
 * ## 왜 배경 억제인가
 *
 * 가중만으로는 부족하다. 가장자리를 눌러도 배경색이 조금은 들어온다.
 *
 * 그래서 상자 **바깥**의 색 분포를 함께 받아, 바깥에 흔한 색의 칸을
 * 눌러 준다. 빙판의 흰색이 상자 안에도 있고 밖에도 있으면 그 칸은
 * "이 사람의 특징" 이 아니다 — 같은 논문의 background-weighted histogram
 * 이 그 판단이다.
 *
 * 반대로 바깥에 없는 색(그 사람의 옷)은 그대로 남아 판별력을 갖는다.
 */
export function describeRgba(data, w, h, background) {
  const values = new Float32Array(DESCRIPTOR_SIZE);
  if (w < 4 || h < 8) return { values, samples: 0 };

  /* 좌우 12% 만 자른다. 나머지는 커널 가중이 맡는다 — 딱 잘라 버리면
   * 팔을 벌린 자세에서 팔이 통째로 사라진다. */
  const x0 = Math.floor(w * 0.12), x1 = Math.ceil(w * 0.88);
  const cx = (x0 + x1) / 2;
  const halfW = Math.max(1, (x1 - x0) / 2);
  const cy = h / 2;
  const halfH = Math.max(1, h / 2);
  let samples = 0, y0 = 0;

  for (let band = 0; band < BANDS.length; band += 1) {
    const y1 = band === BANDS.length - 1
      ? h : Math.min(h, y0 + Math.round(h * BANDS[band]));
    const base = band * BAND_BINS;
    let sum = 0, sumSq = 0, n = 0;

    for (let y = y0; y < y1; y += 1) {
      /* 세로는 완만하게. 머리와 발도 그 사람의 일부다. */
      const dy = (y - cy) / halfH;
      for (let x = x0; x < x1; x += 1) {
        const p = (y * w + x) * 4;
        /* 완전 투명은 세지 않는다 — 상자가 화면 밖으로 나가 빈 자리다. */
        if (data[p + 3] < 8) continue;

        /* 가운데일수록 무겁다. 가장자리에서 0 이 되는 종 모양. */
        const dx = (x - cx) / halfW;
        const r2 = dx * dx * 1.0 + dy * dy * 0.35;
        const k = r2 >= 1 ? 0 : 1 - r2;
        if (k <= 0) continue;

        const [hue, sat, val] = toHsv(data[p], data[p + 1], data[p + 2]);
        if (sat < GRAY_SAT) {
          values[base + HUE_BINS + Math.min(GRAY_BINS - 1, Math.floor(val * GRAY_BINS))] += k;
        } else {
          values[base + Math.min(HUE_BINS - 1, Math.floor(hue * HUE_BINS))] += sat * k;
        }
        sum += val * k; sumSq += val * val * k; n += k;
      }
    }
    if (n > 0) {
      const mean = sum / n;
      const stat = BANDS.length * BAND_BINS + band * 2;
      values[stat] = mean;
      values[stat + 1] = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      samples += n;
    }
    y0 = y1;
  }

  /* 배경에 흔한 색을 누른다. 눌러도 0 으로 만들지는 않는다 — 사람이
   * 배경과 같은 색 옷을 입었을 수도 있고, 그때 그 칸을 지우면 남는
   * 정보가 없다. */
  if (background && background.samples > 0) {
    for (let band = 0; band < BANDS.length; band += 1) {
      const base = band * BAND_BINS;
      for (let k = 0; k < BAND_BINS; k += 1) {
        const bg = background.values[base + k];
        if (bg > 0) values[base + k] *= 1 / (1 + 3 * bg);
      }
    }
  }

  /* 띠마다 따로 정규화한다. 통째로 하면 화소가 많은 띠가 나머지를 누른다. */
  for (let band = 0; band < BANDS.length; band += 1) {
    const base = band * BAND_BINS;
    let sum = 0;
    for (let k = 0; k < BAND_BINS; k += 1) sum += values[base + k];
    if (sum > 0) for (let k = 0; k < BAND_BINS; k += 1) values[base + k] /= sum;
  }
  /* 이 서술자를 얼마나 믿어도 되는가.
   *
   * 상자 안이 바깥과 비슷하면, 그 안에 "이 사람만의 것" 이 거의 없다는
   * 뜻이다. 실측에서 드러난 문제가 정확히 이것이었다.
   *
   *   테니스  대상이 화면의 4%, 상자가 몸에 맞는다        분리도 +0.141
   *   피겨    대상이 화면의 1%, 상자 안 대부분이 빙판이고
   *           다른 사람까지 들어온다                       분리도 -0.131
   *
   * 두 번째 경우에 색 신호를 그대로 믿으면 엉뚱한 사람을 고른다. 그래서
   * 서술자가 **자기를 얼마나 믿어도 되는지** 함께 낸다. 판정하는 쪽이
   * 그 값만큼 무게를 줄인다.
   *
   * 안 재고 늘 믿는 것보다, 못 믿겠다고 말하는 편이 낫다. */
  let trust = 1;
  if (background && background.samples > 0) {
    let overlap = 0, weight = 0;
    for (let band = 0; band < BANDS.length; band += 1) {
      const base = band * BAND_BINS;
      let inter = 0;
      for (let k = 0; k < BAND_BINS; k += 1) {
        inter += Math.min(values[base + k], background.values[base + k]);
      }
      overlap += inter * BAND_WEIGHT[band];
      weight += BAND_WEIGHT[band];
    }
    /* 겹침이 클수록 못 믿는다. 완전히 같으면 0, 전혀 안 겹치면 1. */
    trust = Math.max(0, Math.min(1, 1 - (weight > 0 ? overlap / weight : 0)));
  }

  return { values, samples: Math.round(samples), trust };
}

/**
 * 두 서술자가 같은 사람인가 (0~1).
 *
 * 표본이 너무 적으면 0.5 — "모르겠다" 다. 0 을 주면 "다른 사람" 이라고
 * 말하는 것이 되고, 그러면 작게 찍힌 사람이 늘 거절당한다.
 */
export function appearanceSimilarity(a, b) {
  if (!a || !b) return null;
  if (a.samples < 60 || b.samples < 60) return 0.5;

  let total = 0, weight = 0;
  for (let band = 0; band < BANDS.length; band += 1) {
    const base = band * BAND_BINS;
    let inter = 0;
    for (let k = 0; k < BAND_BINS; k += 1) {
      inter += Math.min(a.values[base + k], b.values[base + k]);
    }
    total += inter * BAND_WEIGHT[band];
    weight += BAND_WEIGHT[band];
  }
  const colour = weight > 0 ? total / weight : 0;

  const statBase = BANDS.length * BAND_BINS;
  let statDiff = 0;
  for (let k = 0; k < BANDS.length * 2; k += 1) {
    statDiff += Math.abs(a.values[statBase + k] - b.values[statBase + k]);
  }
  const stat = Math.max(0, 1 - statDiff / (BANDS.length * 2));

  return Math.max(0, Math.min(1, colour * 0.9 + stat * 0.1));
}

/**
 * 앵커를 지금 모습에 **조금씩** 맞춘다.
 *
 * ## 왜 필요한가 — 실측이 이미 이 문제를 적어 놓았다
 *
 * pipeline.js 의 주석에 이렇게 남아 있다.
 *
 *   앵커 ±0.35초에서 같은 사람끼리 0.898
 *   17초가 지나면 같은 사람이 0.48 까지 내려간다
 *   낯선 사람 최고값 0.715 와 완전히 겹친다
 *
 * 사람이 변한 것이 아니다. 조명이 바뀌고 몸이 돌아간 것이다. 앵커를
 * 처음 한 장에 고정해 두면 시간이 갈수록 진짜 대상과 멀어진다 —
 * "처음엔 잘 잡는데 뒤로 갈수록 놓치는" 증상의 원인이 이것이다.
 *
 * ## 왜 위험한가 — Identity Poisoning
 *
 * 갱신을 무턱대고 하면 **틀린 순간에 갱신한다.** 옆 사람을 잡고 있는
 * 프레임에서 앵커를 그쪽으로 옮기면 그 다음부터 추적기는 옆 사람을
 * "나" 라고 확신하고, 돌아올 방법이 없다.
 *
 * 그래서 부르는 쪽이 **근거를 확인한 뒤에만** 부른다(tracking.js 의
 * IdentityMemory.adapt). 이 함수는 섞는 일만 한다. 한 번에 옮기는
 * 양에 상한이 있어서 한 프레임이 앵커를 뒤집지는 못한다.
 *
 * 🔴 사용자가 직접 확인한 앵커는 이 함수로 건드리지 않는다. 그건
 *    사람이 준 사실이고, 우리 계산으로 흐리게 만들 이유가 없다.
 */
export const ADAPT_MAX_RATE = 0.12;

export function adaptAnchor(anchor, fresh, rate = ADAPT_MAX_RATE) {
  if (!anchor || !fresh) return anchor;
  if (fresh.samples < 60 || anchor.samples < 60) return anchor;
  const k = Math.min(ADAPT_MAX_RATE, Math.max(0, rate));
  if (k <= 1e-4) return anchor;

  const values = new Float32Array(DESCRIPTOR_SIZE);
  for (let i = 0; i < DESCRIPTOR_SIZE; i += 1) {
    values[i] = anchor.values[i] * (1 - k) + fresh.values[i] * k;
  }
  return { values, samples: Math.max(anchor.samples, fresh.samples) };
}

export const ANCHOR_DRIFT_GRACE_SEC = 1;
export const ANCHOR_DRIFT_RUN = 3;

export function decideAppearanceMatch(input) {
  const threshold = input.threshold ?? 0.62;
  const margin = input.distractorMargin ?? 0.08;
  if (input.samples < 60 || input.trust < 0.2) return 'hold';
  if (input.self === null || input.self === undefined) return 'hold';
  if (input.other != null && input.other > input.self + margin) return 'reject';
  if (input.self >= threshold && (input.other == null || input.self >= input.other)) return 'accept';
  return 'hold';
}

export function nextAnchorDrift(input) {
  const grace = input.graceSec ?? ANCHOR_DRIFT_GRACE_SEC;
  const need = input.runNeeded ?? ANCHOR_DRIFT_RUN;
  const match = decideAppearanceMatch({
    self: input.self,
    other: null,
    samples: input.samples,
    trust: input.trust,
  });
  if (match === 'accept') return { run: 0, action: 'continue', match };
  if (input.elapsedSec <= grace) return { run: input.run, action: 'continue', match };
  const run = input.run + 1;
  if (run >= need) return { run: 0, action: 'ask_user', match };
  return { run, action: 'continue', match };
}

