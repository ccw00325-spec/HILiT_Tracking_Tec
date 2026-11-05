/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·fb8b19e6 @license @preserve */
/* 스포츠 장면 합성 표본 — 검출기를 우리 쓰임새에 맞게 학습시키기 위해.

## 왜 새로 만드나

지금 검출기(`hilit-grid-synth-v0`)는 **세 띠 색 막대**로 배웠다. 그 그림에
없는 것이 우리 영상에는 전부 있다.

  팔다리         막대에는 없다. 실제 사람은 뛰면 팔다리가 벌어진다
  겹침           경기에서 사람은 늘 겹친다. 막대는 한 번에 최대 둘, 안 겹친다
  크기 차이      골대 근처와 카메라 앞은 사람 크기가 몇 배 차이 난다
  잘림           화면 가장자리에서 반쯤 잘린 사람이 계속 나온다
  움직임 번짐    빠른 동작에서 가로로 번진다
  바닥 무늬      코트 선·잔디 줄무늬가 세로 막대처럼 보인다 — 헛검출의 주범

합성 검증 precision 0.114 는 이 차이에서 나온다. 사진을 쓰지 않고도
저 여섯 가지는 그려 넣을 수 있다.

## 여전히 사진은 쓰지 않는다

전부 우리가 그린 도형이다. 외부 데이터셋·사전학습 가중치를 쓰지 않으므로
수익화에 걸리는 조건이 붙지 않는다. 대신 **실사 성능이라고 말하지 않는다** —
이건 우리 그림에서 잰 값이다.
*/

/* 입력 규격은 `hilit-grid-net.ts` 와 같아야 한다. 값을 여기 다시 적는 이유는
 * 학습 스크립트가 이 파일을 단독으로 불러 쓰기 때문이다 — 어긋나면
 * `sportsSynthMatchesGridNet()` 시험이 잡는다. */
export const SPORTS_IN_W = 64;
export const SPORTS_IN_H = 96;
export const SPORTS_IN_C = 3;
const GRID_IN_W = SPORTS_IN_W;
const GRID_IN_H = SPORTS_IN_H;
const GRID_IN_C = SPORTS_IN_C;

export interface SynthPerson {
  x: number; y: number; width: number; height: number;
}

export interface SynthSample {
  rgb: Float32Array;
  people: SynthPerson[];
}

const PLANE = GRID_IN_H * GRID_IN_W;

function put(rgb: Float32Array, x: number, y: number, c: readonly number[]): void {
  if (x < 0 || y < 0 || x >= GRID_IN_W || y >= GRID_IN_H) return;
  const j = y * GRID_IN_W + x;
  rgb[j] = c[0];
  rgb[PLANE + j] = c[1];
  rgb[2 * PLANE + j] = c[2];
}

function fill(
  rgb: Float32Array, x0: number, y0: number, x1: number, y1: number, c: readonly number[],
): void {
  for (let y = Math.max(0, Math.round(y0)); y <= Math.min(GRID_IN_H - 1, Math.round(y1)); y += 1) {
    for (let x = Math.max(0, Math.round(x0)); x <= Math.min(GRID_IN_W - 1, Math.round(x1)); x += 1) {
      put(rgb, x, y, c);
    }
  }
}

function line(
  rgb: Float32Array, ax: number, ay: number, bx: number, by: number,
  thickness: number, c: readonly number[],
): void {
  const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay)));
  const half = Math.max(0, Math.floor(thickness / 2));
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = Math.round(ax + (bx - ax) * t);
    const y = Math.round(ay + (by - ay) * t);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) put(rgb, x + dx, y + dy, c);
    }
  }
}

/** 코트·잔디 바닥. 세로줄을 일부러 넣는다 — 헛검출을 만드는 무늬다. */
function drawGround(rgb: Float32Array, rng: () => number): void {
  const base = [0.12 + rng() * 0.3, 0.2 + rng() * 0.35, 0.15 + rng() * 0.3];
  for (let y = 0; y < GRID_IN_H; y += 1) {
    /* 위로 갈수록 밝게 — 조명과 원근을 흉내 낸다. */
    const shade = 0.85 + (1 - y / GRID_IN_H) * 0.3;
    for (let x = 0; x < GRID_IN_W; x += 1) {
      put(rgb, x, y, [base[0] * shade, base[1] * shade, base[2] * shade]);
    }
  }
  const lineColor = [0.75 + rng() * 0.2, 0.75 + rng() * 0.2, 0.75 + rng() * 0.2];
  const stripes = Math.floor(rng() * 4);
  for (let s = 0; s < stripes; s += 1) {
    if (rng() < 0.5) {
      const x = Math.floor(rng() * GRID_IN_W);
      line(rgb, x, 0, x + Math.floor(rng() * 8 - 4), GRID_IN_H - 1, 1, lineColor);
    } else {
      const y = Math.floor(rng() * GRID_IN_H);
      line(rgb, 0, y, GRID_IN_W - 1, y + Math.floor(rng() * 6 - 3), 1, lineColor);
    }
  }
}

/** 사람 하나. 막대가 아니라 팔다리가 벌어진 모양이다. */
function drawPlayer(
  rgb: Float32Array, rng: () => number, person: SynthPerson,
): void {
  const { x, y, width, height } = person;
  const cx = x + width / 2;
  const skin = [0.5 + rng() * 0.35, 0.36 + rng() * 0.3, 0.28 + rng() * 0.3];
  const shirt = [rng(), rng(), rng()];
  const shorts = [rng() * 0.8, rng() * 0.8, rng() * 0.8];

  const headR = Math.max(1, height * 0.09);
  const shoulderY = y + headR * 2.1;
  const hipY = y + height * 0.55;
  const span = Math.max(1, width * 0.42);

  /* 머리 */
  fill(rgb, cx - headR, y, cx + headR, y + headR * 2, skin);
  /* 몸통 */
  fill(rgb, cx - span, shoulderY, cx + span, hipY, shirt);
  /* 팔 — 벌어진 각도를 준다 */
  const armSwing = (rng() * 2 - 1) * width * 0.9;
  line(rgb, cx - span, shoulderY, cx - span - Math.abs(armSwing) * 0.5,
    shoulderY + height * 0.3 - armSwing * 0.3, Math.max(1, width * 0.18), skin);
  line(rgb, cx + span, shoulderY, cx + span + Math.abs(armSwing) * 0.5,
    shoulderY + height * 0.3 + armSwing * 0.3, Math.max(1, width * 0.18), skin);
  /* 다리 — 달리기 보폭 */
  const stride = (rng() * 2 - 1) * width * 0.8;
  line(rgb, cx - span * 0.5, hipY, cx - span * 0.5 + stride, y + height,
    Math.max(1, width * 0.24), shorts);
  line(rgb, cx + span * 0.5, hipY, cx + span * 0.5 - stride, y + height,
    Math.max(1, width * 0.24), shorts);
}

/** 가로 번짐. 빠른 동작에서 생긴다. */
function motionBlur(rgb: Float32Array, amount: number): void {
  if (amount < 1) return;
  const copy = Float32Array.from(rgb);
  for (let c = 0; c < GRID_IN_C; c += 1) {
    for (let y = 0; y < GRID_IN_H; y += 1) {
      for (let x = 0; x < GRID_IN_W; x += 1) {
        let sum = 0;
        let n = 0;
        for (let k = -amount; k <= amount; k += 1) {
          const xx = x + k;
          if (xx < 0 || xx >= GRID_IN_W) continue;
          sum += copy[c * PLANE + y * GRID_IN_W + xx];
          n += 1;
        }
        rgb[c * PLANE + y * GRID_IN_W + x] = sum / Math.max(1, n);
      }
    }
  }
}

export interface SportsSynthOptions {
  /** 아무도 없는 장면 비율. 헛검출을 줄이려면 있어야 한다. */
  emptyProb?: number;
  /** 최대 사람 수. */
  maxPeople?: number;
}

/**
 * 스포츠 장면 한 장.
 *
 * 화면 밖으로 반쯤 잘린 사람은 **정답에 넣지 않는다.** 보이는 부분만으로는
 * 상자 크기를 정할 수 없고, 억지로 정답을 주면 검출기가 잘린 상자를
 * 온전한 사람이라고 배운다.
 */
export function makeSportsSample(
  rng: () => number,
  options: SportsSynthOptions = {},
): SynthSample {
  const emptyProb = options.emptyProb ?? 0.14;
  const maxPeople = options.maxPeople ?? 4;
  const rgb = new Float32Array(GRID_IN_C * PLANE);
  drawGround(rgb, rng);

  const people: SynthPerson[] = [];
  const count = rng() < emptyProb ? 0 : 1 + Math.floor(rng() * maxPeople);
  const drawn: SynthPerson[] = [];

  for (let i = 0; i < count; i += 1) {
    /* 크기를 넓게 흩는다 — 멀리 있는 작은 사람부터 카메라 앞까지. */
    const scale = 0.18 + Math.pow(rng(), 1.6) * 0.82;
    const height = Math.round(14 + scale * 66);
    const width = Math.max(5, Math.round(height * (0.28 + rng() * 0.2)));
    /* 가장자리 밖까지 나가게 둔다. 잘린 사람이 실제로 흔하다. */
    const x = Math.round(-width * 0.5 + rng() * (GRID_IN_W + width * 0.5));
    const y = Math.round(-height * 0.3 + rng() * (GRID_IN_H - height * 0.4));
    const person = { x, y, width, height };
    drawPlayer(rgb, rng, person);
    drawn.push(person);

    /* 화면 안에 충분히 들어온 사람만 정답이다. */
    const vx0 = Math.max(0, x);
    const vy0 = Math.max(0, y);
    const vx1 = Math.min(GRID_IN_W, x + width);
    const vy1 = Math.min(GRID_IN_H, y + height);
    const visible = Math.max(0, vx1 - vx0) * Math.max(0, vy1 - vy0);
    if (visible >= width * height * 0.72 && height >= 12) people.push(person);
  }

  /* 가림 — 다른 물체가 사람 앞을 지난다. 가려진 사람도 정답에 남긴다.
   * 검출기는 반쯤 가려져도 찾아야 한다. */
  const occluders = Math.floor(rng() * 2);
  for (let i = 0; i < occluders; i += 1) {
    const ox = rng() * GRID_IN_W;
    const oy = rng() * GRID_IN_H;
    fill(rgb, ox, oy, ox + 4 + rng() * 12, oy + 6 + rng() * 20,
      [rng() * 0.5, rng() * 0.5, rng() * 0.5]);
  }

  if (rng() < 0.25) motionBlur(rgb, 1 + Math.floor(rng() * 2));

  /* 잡음. 압축 때문에 실제 프레임에는 늘 있다. */
  const noise = 0.02 + rng() * 0.05;
  for (let i = 0; i < rgb.length; i += 1) {
    rgb[i] = Math.max(0, Math.min(1, rgb[i] + (rng() - 0.5) * noise));
  }

  void drawn;
  return { rgb, people };
}

export function makeSportsSet(
  n: number,
  seed: number,
  options: SportsSynthOptions = {},
): SynthSample[] {
  let s = seed >>> 0;
  const rng = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: SynthSample[] = [];
  for (let i = 0; i < n; i += 1) out.push(makeSportsSample(rng, options));
  return out;
}
