/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e01db84b @license @preserve */
/* 대본이 있는 합성 영상 — 시간축으로 전체 사슬을 재기 위해.

## 왜 필요한가

지금까지의 합성 표본은 **한 장짜리**였다. 한 장으로는 검출·자세·색을
잴 수 있지만, 우리가 정작 알고 싶은 것은 시간축에서 일어난다.

  예측이 몇 픽셀 틀리나          한 장으로는 못 잰다
  가림 뒤에 다시 잡나            가림이 있어야 잰다
  화면 밖에 나갔다 오면          이탈·재진입이 있어야 잰다
  프레이밍이 튀나                연속 프레임이 있어야 잰다

그래서 **대본**을 만든다. 사람이 어디에 있는지 프레임마다 우리가 알고
있으므로, 정답과 대 볼 수 있다.

## 여전히 실사가 아니다

사진을 쓰지 않는다. 여기서 나온 숫자를 실사 성능이라고 적지 않는다.
대신 실사로는 지금 못 하는 것 — **정답을 아는 상태로 전체 사슬 재기** —
를 한다. 실사 표본이 생기면 같은 스크립트로 같은 지표를 다시 잰다.
*/

/* 그림 생성기는 **밖에서 받는다.**
 *
 * 평가용 모듈이라 브라우저 번들에 넣지 않는다. 그런데 학습용 그림
 * 생성기를 import 하면 그 파일도 같이 딸려 온다. 대신 함수로 받으면
 * 평가 스크립트만 그걸 넘기면 되고, 학습용과 평가용이 **같은 그림**을
 * 쓴다는 보장도 그대로 남는다. */
export interface SynthPerson {
  x: number; y: number; width: number; height: number;
}

export interface SynthSample {
  rgb: Float32Array;
  people: SynthPerson[];
}

export type SportsSampler = (
  rng: () => number,
  options?: { emptyProb?: number; maxPeople?: number },
) => SynthSample;

/* 대상 키. 화면(96)의 3분의 1쯤으로 둔다.
 *
 * 46 으로 뒀더니 자동 프레이밍 영역이 화면보다 커져 테두리에 눌렸고,
 * 그 상태에서는 프레이밍이 한 픽셀도 안 움직여 「흔들림 0」 이라는
 * 무의미한 값이 나왔다. 실제 영상에서 사람은 화면의 일부만 차지한다. */
const SUBJECT_H = 30;

export const CLIP_W = 64;
export const CLIP_H = 96;

export type ClipScenario =
  | 'straight'
  | 'turn'
  | 'occlusion'
  | 'exit-return'
  | 'crossing'
  | 'stop-and-go';

export interface ClipFrame {
  index: number;
  tSec: number;
  rgb: Float32Array;
  /** 대상의 진짜 자리. 화면 밖이면 null. */
  truth: SynthPerson | null;
  /** 대상이 가려졌나. 가려도 자리는 안다. */
  occluded: boolean;
  /** 화면 안에 있나. */
  onScreen: boolean;
  /** 대상이 아닌 사람들의 자리. 확정 타인 평가에 쓴다. */
  others: SynthPerson[];
}

export interface SyntheticClip {
  id: string;
  scenario: ClipScenario;
  fps: number;
  frames: ClipFrame[];
  rights: {
    owner: 'Hilit';
    aiTrainingConsent: true;
    privacyConsent: true;
    evidence: 'procedurally generated, no photographs, no real persons';
    realVideo: false;
  };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Waypoint {
  cx: number;
  cy: number;
  height: number;
}

/** 대본마다 대상의 자리를 시간의 함수로 정한다. */
function subjectAt(scenario: ClipScenario, k: number, SUBJECT_H: number): Waypoint & { hidden: boolean } {
  const ease = (v: number) => v * v * (3 - 2 * v);
  switch (scenario) {
    case 'straight':
      return { cx: 6 + k * (CLIP_W - 12), cy: CLIP_H * 0.55, height: SUBJECT_H, hidden: false };
    case 'turn': {
      /* 절반까지 오른쪽, 그 뒤 왼쪽으로 되돌아간다. 등속 예측이 가장
       * 크게 틀리는 지점이다. */
      const half = k < 0.5 ? k * 2 : (1 - k) * 2;
      return { cx: 8 + ease(half) * (CLIP_W - 16), cy: CLIP_H * 0.55, height: SUBJECT_H, hidden: false };
    }
    case 'occlusion': {
      /* 가운데에서 0.35~0.55 구간 동안 가려진다. 자리는 계속 안다. */
      const hidden = k >= 0.35 && k <= 0.55;
      return { cx: 8 + k * (CLIP_W - 16), cy: CLIP_H * 0.55, height: SUBJECT_H, hidden };
    }
    case 'exit-return': {
      /* 오른쪽으로 나갔다가 같은 쪽으로 되돌아온다. */
      const t = k < 0.5 ? k * 2 : (1 - k) * 2;
      return { cx: 10 + t * (CLIP_W + 20), cy: CLIP_H * 0.55, height: SUBJECT_H, hidden: false };
    }
    case 'crossing':
      return { cx: 6 + k * (CLIP_W - 12), cy: CLIP_H * 0.55, height: SUBJECT_H, hidden: false };
    case 'stop-and-go': {
      /* 0.3~0.6 구간은 멈춰 있다. 멈췄다 출발하는 순간이 예측의 약점이다. */
      const moved = k < 0.3 ? k / 0.3 * 0.4 : k < 0.6 ? 0.4 : 0.4 + (k - 0.6) / 0.4 * 0.6;
      return { cx: 8 + moved * (CLIP_W - 16), cy: CLIP_H * 0.55, height: SUBJECT_H, hidden: false };
    }
    default:
      return { cx: CLIP_W / 2, cy: CLIP_H * 0.55, height: SUBJECT_H, hidden: false };
  }
}

function boxOf(w: Waypoint): SynthPerson {
  const width = Math.max(6, Math.round(w.height * 0.34));
  return {
    x: Math.round(w.cx - width / 2),
    y: Math.round(w.cy - w.height / 2),
    width,
    height: Math.round(w.height),
  };
}

function paste(
  dst: Float32Array, src: Float32Array, box: SynthPerson, srcBox: SynthPerson,
): void {
  const plane = CLIP_H * CLIP_W;
  for (let y = 0; y < box.height; y += 1) {
    const dy = box.y + y;
    if (dy < 0 || dy >= CLIP_H) continue;
    const sy = srcBox.y + Math.round((y / Math.max(1, box.height)) * srcBox.height);
    if (sy < 0 || sy >= CLIP_H) continue;
    for (let x = 0; x < box.width; x += 1) {
      const dx = box.x + x;
      if (dx < 0 || dx >= CLIP_W) continue;
      const sx = srcBox.x + Math.round((x / Math.max(1, box.width)) * srcBox.width);
      if (sx < 0 || sx >= CLIP_W) continue;
      for (let c = 0; c < 3; c += 1) {
        dst[c * plane + dy * CLIP_W + dx] = src[c * plane + sy * CLIP_W + sx];
      }
    }
  }
}

function fillRect(
  rgb: Float32Array, box: SynthPerson, color: readonly number[],
): void {
  const plane = CLIP_H * CLIP_W;
  for (let y = Math.max(0, box.y); y < Math.min(CLIP_H, box.y + box.height); y += 1) {
    for (let x = Math.max(0, box.x); x < Math.min(CLIP_W, box.x + box.width); x += 1) {
      for (let c = 0; c < 3; c += 1) rgb[c * plane + y * CLIP_W + x] = color[c];
    }
  }
}

/**
 * 대본 하나로 영상 한 편을 만든다.
 *
 * 배경과 대상의 겉모습은 `makeSportsSample` 이 그린 한 장에서 잘라 쓴다 —
 * 두 곳에서 따로 그리면 학습용 그림과 평가용 그림이 달라진다.
 */
export function makeSyntheticClip(input: {
  scenario: ClipScenario;
  /** 스포츠 장면 한 장을 그리는 함수. `hilit-sports-synth` 의 것을 넘긴다. */
  sampler: SportsSampler;
  frames?: number;
  fps?: number;
  seed?: number;
  /** 대상 말고 몇 명이 더 있나. crossing 은 최소 1명이다. */
  others?: number;
  /** 대상 키(화소). 검출기가 크기에 따라 어떻게 무너지는지 재려고 연다. */
  subjectHeight?: number;
}): SyntheticClip {
  const makeSportsSample = input.sampler;
  const subjectHeight = input.subjectHeight ?? SUBJECT_H;
  const scenario = input.scenario;
  const total = input.frames ?? 40;
  const fps = input.fps ?? 20;
  const rand = lcg(input.seed ?? 20260921);
  const others = input.others ?? (scenario === 'crossing' ? 1 : 0);

  /* 겉모습을 한 번 뽑아 둔다. 대상은 영상 내내 같은 사람이어야 한다. */
  const look: SynthSample = makeSportsSample(rand, { emptyProb: 0, maxPeople: 1 });
  const lookBox = look.people[0] ?? { x: 10, y: 10, width: 14, height: SUBJECT_H };
  const otherLooks = Array.from({ length: others }, () => {
    const sample = makeSportsSample(rand, { emptyProb: 0, maxPeople: 1 });
    return { sample, box: sample.people[0] ?? { x: 10, y: 10, width: 14, height: SUBJECT_H } };
  });

  const frames: ClipFrame[] = [];
  for (let i = 0; i < total; i += 1) {
    const k = total <= 1 ? 0 : i / (total - 1);
    /* 배경은 매 프레임 새로 그리되 같은 씨앗 계열이라 비슷하게 유지된다. */
    const bg = makeSportsSample(lcg(1000 + i), { emptyProb: 1, maxPeople: 0 });
    const rgb = Float32Array.from(bg.rgb);

    const otherBoxes: SynthPerson[] = [];
    otherLooks.forEach((other, index) => {
      /* 교차 대본에서는 반대 방향으로 지나간다. */
      const cx = scenario === 'crossing'
        ? (CLIP_W - 6) - k * (CLIP_W - 12)
        : 10 + index * 22;
      const box = boxOf({ cx, cy: CLIP_H * 0.55, height: subjectHeight });
      paste(rgb, other.sample.rgb, box, other.box);
      otherBoxes.push(box);
    });

    const wp = subjectAt(scenario, k, subjectHeight);
    const box = boxOf(wp);
    const visibleArea = Math.max(0, Math.min(CLIP_W, box.x + box.width) - Math.max(0, box.x))
      * Math.max(0, Math.min(CLIP_H, box.y + box.height) - Math.max(0, box.y));
    const onScreen = visibleArea >= box.width * box.height * 0.6;
    paste(rgb, look.rgb, box, lookBox);

    if (wp.hidden) {
      /* 가림 — 대상 앞을 큰 물체가 지난다. 자리는 여전히 안다. */
      fillRect(rgb, {
        x: box.x - 3, y: box.y + Math.round(box.height * 0.1),
        width: box.width + 6, height: Math.round(box.height * 0.85),
      }, [0.12, 0.12, 0.14]);
    }

    frames.push({
      index: i,
      tSec: i / fps,
      rgb,
      truth: onScreen ? box : null,
      occluded: wp.hidden,
      onScreen,
      others: otherBoxes,
    });
  }

  return {
    id: `hilit-clip-${scenario}-${input.seed ?? 20260921}`,
    scenario,
    fps,
    frames,
    rights: {
      owner: 'Hilit',
      aiTrainingConsent: true,
      privacyConsent: true,
      evidence: 'procedurally generated, no photographs, no real persons',
      realVideo: false,
    },
  };
}

export const CLIP_SCENARIOS: readonly ClipScenario[] = [
  'straight', 'turn', 'occlusion', 'exit-return', 'crossing', 'stop-and-go',
];
