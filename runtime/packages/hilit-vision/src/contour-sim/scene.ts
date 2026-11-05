/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·46a8d575 @license @preserve */
/* 외곽선 연속성 시뮬레이션용 합성 장면. 실사가 아니다.

사람마다 관절 막대 인형(머리·몸통·팔·다리, 사이클은 자전거까지)을 그려
프레임 RGB 와 사람별 가시 마스크·정답 상자를 함께 낸다. 권리 확인이 된
실사 영상에는 사람 마스크도 신원 정답도 없어서(2026-09-23 기록),
외곽선 기능은 이 생성기로만 잴 수 있다.

결정적이다: 같은 seed·시나리오·종목이면 같은 프레임·같은 탐지가 나온다.
*/

export type SimSport = 'running' | 'cycling' | 'skating';

export type SimScenario =
  | 'fixed-camera'
  | 'slow-pan'
  | 'fast-pan'
  | 'zoom'
  | 'small-players'
  | 'crowd-crossing'
  | 'short-occlusion'
  | 'long-occlusion'
  | 'exit-reentry'
  | 'similar-uniforms'
  | 'lighting-change'
  | 'low-quality'
  | 'compression'
  | 'motion-blur'
  | 'mask-missing-part'
  | 'mask-merge'
  | 'border-cut'
  | 'similar-poses'
  | 'abrupt-pose-change';

export const SIM_SCENARIOS: readonly SimScenario[] = [
  'fixed-camera', 'slow-pan', 'fast-pan', 'zoom', 'small-players', 'crowd-crossing',
  'short-occlusion', 'long-occlusion', 'exit-reentry', 'similar-uniforms', 'lighting-change',
  'low-quality', 'compression', 'motion-blur', 'mask-missing-part', 'mask-merge', 'border-cut',
  'similar-poses', 'abrupt-pose-change',
];

export const SIM_SPORTS: readonly SimSport[] = ['running', 'cycling', 'skating'];

export const SIM_W = 320;
export const SIM_H = 180;
export const SIM_FPS = 10;

export interface Rng {
  next(): number;
  normal(): number;
  range(a: number, b: number): number;
  int(a: number, b: number): number;
}

export function makeRng(seed: number): Rng {
  let s = (seed >>> 0) || 1;
  const next = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    normal() {
      const u = Math.max(1e-9, next());
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    range(a, b) {
      return a + (b - a) * next();
    },
    int(a, b) {
      return Math.floor(a + (b - a + 1) * next());
    },
  };
}

export function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e3779b9;
  }
  return h >>> 0;
}

type RGB = [number, number, number];

interface SimPerson {
  id: number;
  sport: SimSport;
  /** 세계 좌표의 발 위치 */
  x: number;
  y: number;
  vx: number;
  vy: number;
  height: number;
  build: number;
  top: RGB;
  bottom: RGB;
  skin: RGB;
  bike: RGB;
  phase: number;
  cadence: number;
  crouch: number;
  /** 등장 프레임 구간 (화면 이탈 재진입용 경로는 궤적으로 표현) */
  path?: (f: number) => { x: number; y: number } | null;
  crouchAt?: (f: number) => number;
}

interface Occluder {
  x: number;
  y: number;
  w: number;
  h: number;
  color: RGB;
}

export interface SimGroundTruth {
  id: number;
  /** 가려지지 않은 전체 몸 상자 (화면 좌표) */
  box: { x: number; y: number; width: number; height: number };
  /** 보이는 화소 상자. 보이는 화소가 없으면 null */
  visibleBox: { x: number; y: number; width: number; height: number } | null;
  visiblePixels: number;
  fullPixels: number;
  visibleRatio: number;
}

export interface SimFrame {
  index: number;
  rgb: Uint8ClampedArray;
  gray: Uint8Array;
  /** 화소별 보이는 사람 id, -1 = 배경 */
  label: Int16Array;
  /** 가림 물체 화소 */
  occluder: Uint8Array;
  gt: SimGroundTruth[];
  camera: { cx: number; cy: number; zoom: number };
  /** 이 프레임의 실제 카메라 변환 (이전 프레임 → 이번 프레임, 화면 좌표) */
  cameraAffine: { a: number; b: number; tx: number; c: number; d: number; ty: number };
  blur: number;
  lighting: number;
}

export interface SimClipSpec {
  scenario: SimScenario;
  sport: SimSport;
  seed: number;
  frames: number;
}

export interface SimClip {
  spec: SimClipSpec;
  targetId: number;
  frames: SimFrame[];
  /** 이 장면에서 대상과 비슷한 유니폼을 입은 사람이 있는가 */
  similarUniform: boolean;
}

const WORLD_W = 960;
const WORLD_H = 360;

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function palette(rng: Rng): RGB {
  const hues: RGB[] = [
    [200, 40, 40], [40, 80, 200], [30, 160, 60], [230, 200, 30], [240, 120, 20],
    [140, 40, 170], [20, 170, 180], [240, 240, 240], [30, 30, 30], [200, 90, 150],
  ];
  const c = hues[rng.int(0, hues.length - 1)];
  return [clampByte(c[0] + rng.normal() * 12), clampByte(c[1] + rng.normal() * 12), clampByte(c[2] + rng.normal() * 12)];
}

function jitterColor(c: RGB, rng: Rng, s: number): RGB {
  return [clampByte(c[0] + rng.normal() * s), clampByte(c[1] + rng.normal() * s), clampByte(c[2] + rng.normal() * s)];
}

/** 정적 배경 무늬 (세계 좌표). GMC 가 잡을 모서리가 있도록 사각형·줄을 뿌린다. */
function buildBackground(rng: Rng): Uint8ClampedArray {
  const bg = new Uint8ClampedArray(WORLD_W * WORLD_H * 3);
  const base: RGB = [90 + rng.int(-15, 15), 110 + rng.int(-15, 15), 95 + rng.int(-15, 15)];
  for (let y = 0; y < WORLD_H; y += 1) {
    const g = y / WORLD_H;
    for (let x = 0; x < WORLD_W; x += 1) {
      const i = (y * WORLD_W + x) * 3;
      bg[i] = base[0] * (0.8 + 0.3 * g);
      bg[i + 1] = base[1] * (0.8 + 0.3 * g);
      bg[i + 2] = base[2] * (0.8 + 0.3 * g);
    }
  }
  for (let k = 0; k < 220; k += 1) {
    const w = rng.int(6, 48);
    const h = rng.int(4, 30);
    const x0 = rng.int(0, WORLD_W - w);
    const y0 = rng.int(0, WORLD_H - h);
    const c: RGB = [rng.int(40, 200), rng.int(40, 200), rng.int(40, 200)];
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const i = (y * WORLD_W + x) * 3;
        bg[i] = (bg[i] + c[0]) / 2;
        bg[i + 1] = (bg[i + 1] + c[1]) / 2;
        bg[i + 2] = (bg[i + 2] + c[2]) / 2;
      }
    }
  }
  // 약한 무작위 잡음 — 평평한 면만 있으면 모서리 검출이 안 된다
  for (let i = 0; i < bg.length; i += 1) bg[i] = clampByte(bg[i] + (rng.next() - 0.5) * 14);
  return bg;
}

/* ---------- 관절 인형 ---------- */

interface Capsule {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
  color: RGB;
}

interface Ring {
  cx: number;
  cy: number;
  r: number;
  t: number;
  color: RGB;
}

function limb(x0: number, y0: number, ang: number, len: number): [number, number] {
  return [x0 + Math.sin(ang) * len, y0 + Math.cos(ang) * len];
}

/** 발 위치(fx,fy)·키 H 의 인형을 화면 좌표 도형으로. dir = 진행 방향 부호. */
function bodyShapes(p: SimPerson, fx: number, fy: number, H: number, f: number, dir: number): { caps: Capsule[]; rings: Ring[] } {
  const caps: Capsule[] = [];
  const rings: Ring[] = [];
  const ph = p.phase + f * p.cadence;
  const crouch = p.crouchAt ? p.crouchAt(f) : p.crouch;
  const b = p.build;
  if (p.sport === 'cycling') {
    const wr = 0.19 * H;
    const wheelY = fy - wr;
    const back = fx - dir * 0.3 * H;
    const front = fx + dir * 0.3 * H;
    rings.push({ cx: back, cy: wheelY, r: wr, t: Math.max(1.2, 0.028 * H), color: p.bike });
    rings.push({ cx: front, cy: wheelY, r: wr, t: Math.max(1.2, 0.028 * H), color: p.bike });
    const crankX = fx;
    const crankY = wheelY;
    const seatX = fx - dir * 0.1 * H;
    const seatY = fy - 0.52 * H;
    const barX = fx + dir * 0.24 * H;
    const barY = fy - 0.6 * H;
    const fr = Math.max(1, 0.022 * H);
    caps.push({ ax: back, ay: wheelY, bx: crankX, by: crankY, r: fr, color: p.bike });
    caps.push({ ax: crankX, ay: crankY, bx: seatX, by: seatY, r: fr, color: p.bike });
    caps.push({ ax: seatX, ay: seatY, bx: barX, by: barY, r: fr, color: p.bike });
    caps.push({ ax: barX, ay: barY, bx: front, by: wheelY, r: fr, color: p.bike });
    // 사람: 안장 위, 앞으로 숙임
    const hipX = seatX;
    const hipY = seatY - 0.03 * H;
    const lean = 0.75 + 0.15 * crouch;
    const neckX = hipX + dir * Math.sin(lean) * 0.3 * H;
    const neckY = hipY - Math.cos(lean) * 0.3 * H;
    caps.push({ ax: hipX, ay: hipY, bx: neckX, by: neckY, r: 0.075 * H * b, color: p.top });
    caps.push({ ax: neckX, ay: neckY, bx: barX, by: barY - 0.02 * H, r: 0.03 * H, color: p.top });
    const pedal = ph * 2;
    for (const s of [0, Math.PI]) {
      const px = crankX + Math.cos(pedal + s) * 0.08 * H;
      const py = crankY + Math.sin(pedal + s) * 0.08 * H;
      const kx = (hipX + px) / 2 + dir * 0.1 * H;
      const ky = (hipY + py) / 2 - 0.04 * H;
      caps.push({ ax: hipX, ay: hipY, bx: kx, by: ky, r: 0.045 * H * b, color: p.bottom });
      caps.push({ ax: kx, ay: ky, bx: px, by: py, r: 0.038 * H * b, color: p.bottom });
    }
    const hx = neckX + dir * 0.06 * H;
    const hy = neckY - 0.06 * H;
    caps.push({ ax: hx, ay: hy, bx: hx, by: hy, r: 0.065 * H, color: p.skin });
    return { caps, rings };
  }

  const lean = p.sport === 'skating' ? 0.25 + 0.55 * crouch : 0.12 + 0.2 * crouch;
  const legLen = 0.47 * H * (1 - 0.18 * crouch);
  const hipY = fy - legLen * (p.sport === 'skating' ? 0.9 : 0.97);
  const hipX = fx;
  const torso = 0.3 * H;
  const neckX = hipX + dir * Math.sin(lean) * torso;
  const neckY = hipY - Math.cos(lean) * torso;
  caps.push({ ax: hipX, ay: hipY, bx: neckX, by: neckY, r: 0.08 * H * b, color: p.top });
  const hx = neckX + dir * Math.sin(lean) * 0.07 * H;
  const hy = neckY - Math.cos(lean) * 0.07 * H - 0.02 * H;
  caps.push({ ax: hx, ay: hy, bx: hx, by: hy, r: 0.065 * H, color: p.skin });
  // 다리
  const swing = p.sport === 'running' ? 0.7 : 0.55;
  for (const s of [0, Math.PI]) {
    let thigh: number;
    let shin: number;
    if (p.sport === 'skating') {
      // 옆으로 미는 보폭
      thigh = dir * (0.15 + Math.sin(ph + s) * swing * 0.7);
      shin = thigh - dir * 0.25 * crouch;
    } else {
      thigh = dir * Math.sin(ph + s) * swing;
      shin = thigh - dir * Math.max(0, Math.cos(ph + s)) * 0.9;
    }
    const [kx, ky] = limb(hipX, hipY, thigh, legLen * 0.52);
    const [ax, ay] = limb(kx, ky, shin, legLen * 0.5);
    caps.push({ ax: hipX, ay: hipY, bx: kx, by: ky, r: 0.05 * H * b, color: p.bottom });
    caps.push({ ax: kx, ay: ky, bx: ax, by: ay, r: 0.04 * H * b, color: p.bottom });
  }
  // 팔
  const armSwing = p.sport === 'running' ? 0.9 : 0.6;
  for (const s of [Math.PI, 0]) {
    const up = p.sport === 'skating'
      ? -dir * (0.9 + 0.5 * Math.sin(ph + s))
      : -dir * Math.sin(ph + s) * armSwing;
    const [ex, ey] = limb(neckX, neckY + 0.02 * H, up, 0.17 * H);
    const [wx, wy] = limb(ex, ey, up + dir * (p.sport === 'running' ? 1.1 : 0.4), 0.16 * H);
    caps.push({ ax: neckX, ay: neckY + 0.02 * H, bx: ex, by: ey, r: 0.035 * H * b, color: p.top });
    caps.push({ ax: ex, ay: ey, bx: wx, by: wy, r: 0.03 * H * b, color: p.skin });
  }
  return { caps, rings };
}

function rasterPerson(shapes: { caps: Capsule[]; rings: Ring[] }, id: number, label: Int16Array,
  color: Uint8ClampedArray, full: Uint8Array | null): void {
  const W = SIM_W;
  const Hh = SIM_H;
  for (const c of shapes.caps) {
    const x0 = Math.max(0, Math.floor(Math.min(c.ax, c.bx) - c.r - 1));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(c.ax, c.bx) + c.r + 1));
    const y0 = Math.max(0, Math.floor(Math.min(c.ay, c.by) - c.r - 1));
    const y1 = Math.min(Hh - 1, Math.ceil(Math.max(c.ay, c.by) + c.r + 1));
    const dx = c.bx - c.ax;
    const dy = c.by - c.ay;
    const len2 = dx * dx + dy * dy;
    const r2 = Math.max(0.36, c.r * c.r);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5 - c.ax;
        const py = y + 0.5 - c.ay;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        const qx = px - t * dx;
        const qy = py - t * dy;
        if (qx * qx + qy * qy > r2) continue;
        const i = y * W + x;
        if (full) {
          full[i] = 1;
          continue;
        }
        label[i] = id;
        color[i * 3] = c.color[0];
        color[i * 3 + 1] = c.color[1];
        color[i * 3 + 2] = c.color[2];
      }
    }
  }
  for (const r of shapes.rings) {
    const x0 = Math.max(0, Math.floor(r.cx - r.r - r.t - 1));
    const x1 = Math.min(W - 1, Math.ceil(r.cx + r.r + r.t + 1));
    const y0 = Math.max(0, Math.floor(r.cy - r.r - r.t - 1));
    const y1 = Math.min(Hh - 1, Math.ceil(r.cy + r.r + r.t + 1));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const d = Math.hypot(x + 0.5 - r.cx, y + 0.5 - r.cy);
        if (Math.abs(d - r.r) > r.t / 2 + 0.3) continue;
        const i = y * W + x;
        if (full) {
          full[i] = 1;
          continue;
        }
        label[i] = id;
        color[i * 3] = r.color[0];
        color[i * 3 + 1] = r.color[1];
        color[i * 3 + 2] = r.color[2];
      }
    }
  }
}

/* ---------- 장면 구성 ---------- */

interface SceneSetup {
  people: SimPerson[];
  occluders: Occluder[];
  camera: (f: number) => { cx: number; cy: number; zoom: number };
  lighting: (f: number) => { gain: number; warm: number };
  blur: (f: number) => number;
  lowQuality: boolean;
  compression: boolean;
  similarUniform: boolean;
}

function setupScene(spec: SimClipSpec, rng: Rng): SceneSetup {
  const sc = spec.scenario;
  const N = spec.frames;
  const baseH = sc === 'small-players' ? rng.range(22, 30) : rng.range(58, 82);
  const speed = spec.sport === 'cycling' ? 4.2 : spec.sport === 'skating' ? 3.2 : 2.6;
  const targetTop = palette(rng);
  const targetBottom = palette(rng);
  const similar = sc === 'similar-uniforms' || sc === 'crowd-crossing' && rng.next() < 0.5;
  const people: SimPerson[] = [];
  const count = sc === 'crowd-crossing' ? 6 : sc === 'similar-poses' ? 4 : sc === 'fixed-camera' ? 2 : 3;
  const cam0x = WORLD_W / 2;
  const cam0y = WORLD_H / 2;
  const panSpeed = sc === 'slow-pan' ? 1.2 : sc === 'fast-pan' ? 5.5 : 0;
  for (let k = 0; k < count; k += 1) {
    const isTarget = k === 0;
    const dir = isTarget ? 1 : (rng.next() < 0.5 ? -1 : 1);
    const H = baseH * (isTarget ? 1 : rng.range(0.85, 1.15));
    let x = cam0x + rng.range(-110, 110);
    let y = cam0y + rng.range(10, 70);
    let vx = dir * speed * rng.range(0.8, 1.2) + panSpeed * (isTarget ? 1 : rng.range(0.6, 1.1));
    let vy = rng.range(-0.4, 0.4);
    if (sc === 'crowd-crossing' || sc === 'similar-poses') {
      // 대상과 반대 방향으로 지나가며 겹친다
      x = isTarget ? cam0x - 80 : cam0x + 40 + k * 18;
      y = cam0y + 40 + rng.range(-12, 12);
      vx = isTarget ? speed : -speed * rng.range(0.8, 1.2);
      vy = isTarget ? 0 : rng.range(-0.3, 0.3);
    }
    if (sc === 'mask-merge' && k === 1) {
      // 대상과 나란히 붙어 달린다 — 마스크가 합쳐지는 장면
      x = cam0x - 60 + H * 0.28;
      y = cam0y + 42;
      vx = speed;
      vy = 0;
    }
    if (isTarget && sc !== 'crowd-crossing' && sc !== 'similar-poses') {
      x = cam0x - 70;
      y = cam0y + 40;
    }
    const top = isTarget ? targetTop : similar ? jitterColor(targetTop, rng, 10) : palette(rng);
    const bottom = isTarget ? targetBottom : similar ? jitterColor(targetBottom, rng, 10) : palette(rng);
    const p: SimPerson = {
      id: k,
      sport: spec.sport,
      x,
      y,
      vx,
      vy,
      height: H,
      build: sc === 'similar-poses' || similar ? 1 : rng.range(0.85, 1.2),
      top,
      bottom,
      skin: jitterColor([200, 160, 130], rng, 20),
      bike: jitterColor([50, 50, 55], rng, 10),
      phase: sc === 'similar-poses' ? 0 : rng.range(0, Math.PI * 2),
      cadence: (spec.sport === 'running' ? 0.9 : spec.sport === 'cycling' ? 0.8 : 0.5) * rng.range(0.9, 1.1),
      crouch: spec.sport === 'skating' ? rng.range(0.4, 0.8) : rng.range(0, 0.3),
    };
    if (isTarget && sc === 'abrupt-pose-change') {
      const t0 = Math.floor(N * 0.45);
      p.crouchAt = (f) => (f < t0 ? 0.05 : 0.95);
    }
    if (isTarget && sc === 'exit-reentry') {
      // 화면 밖으로 나갔다가 돌아온다 (카메라는 고정)
      const out0 = Math.floor(N * 0.35);
      const back0 = Math.floor(N * 0.65);
      const x0 = x;
      p.path = (f) => {
        if (f < out0) return { x: x0 + f * 5, y };
        if (f < back0) return null;
        return { x: cam0x + 175 - (f - back0) * 4, y: y + 6 };
      };
    }
    people.push(p);
  }
  const occluders: Occluder[] = [];
  if (sc === 'short-occlusion' || sc === 'long-occlusion') {
    const t = people[0];
    const hitFrame = Math.floor(N * 0.4);
    const ox = t.x + t.vx * hitFrame;
    const width = sc === 'short-occlusion' ? t.vx * 4 + t.height * 0.4 : t.vx * 18 + t.height * 0.4;
    occluders.push({ x: ox, y: t.y - t.height * 1.3, w: width, h: t.height * 1.5, color: [120, 100, 80] });
  }
  if (sc === 'border-cut') {
    people[0].x = cam0x - 160 - people[0].height * 0.1;
    people[0].vx = 0.5;
  }
  const camera = (f: number) => {
    let cx = cam0x + panSpeed * f;
    let cy = cam0y;
    let zoom = 1;
    if (sc === 'fast-pan') cy += Math.sin(f * 0.25) * 6;
    if (sc === 'zoom') zoom = 1 + 0.35 * Math.sin((f / N) * Math.PI * 2);
    if (sc === 'motion-blur') cx += Math.sin(f * 0.9) * 8;
    return { cx, cy, zoom };
  };
  const lighting = (f: number) => {
    if (sc !== 'lighting-change') return { gain: 1, warm: 0 };
    const t = Math.min(1, Math.max(0, (f - N * 0.3) / (N * 0.2)));
    return { gain: 1 - 0.45 * t, warm: 30 * t };
  };
  const blur = (f: number) => (sc === 'motion-blur' ? 0.5 + 0.3 * Math.abs(Math.sin(f * 0.9)) : sc === 'fast-pan' ? 0.3 : 0);
  return {
    people,
    occluders,
    camera,
    lighting,
    blur,
    lowQuality: sc === 'low-quality',
    compression: sc === 'compression',
    similarUniform: similar,
  };
}

function personAt(p: SimPerson, f: number): { x: number; y: number } | null {
  if (p.path) return p.path(f);
  return { x: p.x + p.vx * f, y: p.y + p.vy * f + Math.sin(f * 0.07 + p.phase) * 1.5 };
}

function worldToFrame(cam: { cx: number; cy: number; zoom: number }, x: number, y: number): [number, number] {
  return [(x - cam.cx) * cam.zoom + SIM_W / 2, (y - cam.cy) * cam.zoom + SIM_H / 2];
}

export function renderClip(spec: SimClipSpec): SimClip {
  const rng = makeRng(hashSeed('contour-sim', spec.scenario, spec.sport, spec.seed));
  const bg = buildBackground(rng);
  const setup = setupScene(spec, rng);
  const frames: SimFrame[] = [];
  let prevCam = setup.camera(0);
  for (let f = 0; f < spec.frames; f += 1) {
    const cam = setup.camera(f);
    const light = setup.lighting(f);
    const rgb = new Uint8ClampedArray(SIM_W * SIM_H * 3);
    const label = new Int16Array(SIM_W * SIM_H).fill(-1);
    const occ = new Uint8Array(SIM_W * SIM_H);
    // 배경 (역사상)
    for (let y = 0; y < SIM_H; y += 1) {
      for (let x = 0; x < SIM_W; x += 1) {
        const wx = Math.min(WORLD_W - 1, Math.max(0, Math.round((x - SIM_W / 2) / cam.zoom + cam.cx)));
        const wy = Math.min(WORLD_H - 1, Math.max(0, Math.round((y - SIM_H / 2) / cam.zoom + cam.cy)));
        const s = (wy * WORLD_W + wx) * 3;
        const d = (y * SIM_W + x) * 3;
        rgb[d] = bg[s];
        rgb[d + 1] = bg[s + 1];
        rgb[d + 2] = bg[s + 2];
      }
    }
    // 사람: 먼 쪽(발 y 작은 쪽)부터
    const order = setup.people
      .map((p) => ({ p, at: personAt(p, f) }))
      .filter((r) => r.at != null)
      .sort((a, b) => a.at!.y - b.at!.y);
    const gt: SimGroundTruth[] = [];
    const fullMasks = new Map<number, Uint8Array>();
    for (const { p, at } of order) {
      const [fx, fy] = worldToFrame(cam, at!.x, at!.y);
      const H = p.height * cam.zoom;
      const dir = p.vx - (cam.cx - prevCam.cx) >= 0 || p.vx >= 0 ? 1 : -1;
      const shapes = bodyShapes(p, fx, fy, H, f, p.vx >= 0 ? 1 : -1);
      void dir;
      const full = new Uint8Array(SIM_W * SIM_H);
      rasterPerson(shapes, p.id, label, rgb, full);
      fullMasks.set(p.id, full);
      rasterPerson(shapes, p.id, label, rgb, null);
    }
    // 가림 물체
    for (const o of setup.occluders) {
      const [x0, y0] = worldToFrame(cam, o.x, o.y);
      const [x1, y1] = worldToFrame(cam, o.x + o.w, o.y + o.h);
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(SIM_H, Math.ceil(y1)); y += 1) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(SIM_W, Math.ceil(x1)); x += 1) {
          const i = y * SIM_W + x;
          occ[i] = 1;
          label[i] = -1;
          rgb[i * 3] = o.color[0];
          rgb[i * 3 + 1] = o.color[1];
          rgb[i * 3 + 2] = o.color[2];
        }
      }
    }
    for (const p of setup.people) {
      const full = fullMasks.get(p.id);
      if (!full) continue;
      let fminX = SIM_W;
      let fminY = SIM_H;
      let fmaxX = -1;
      let fmaxY = -1;
      let vminX = SIM_W;
      let vminY = SIM_H;
      let vmaxX = -1;
      let vmaxY = -1;
      let fullN = 0;
      let visN = 0;
      for (let i = 0; i < full.length; i += 1) {
        const x = i % SIM_W;
        const y = (i - x) / SIM_W;
        if (full[i]) {
          fullN += 1;
          if (x < fminX) fminX = x;
          if (x > fmaxX) fmaxX = x;
          if (y < fminY) fminY = y;
          if (y > fmaxY) fmaxY = y;
        }
        if (label[i] === p.id) {
          visN += 1;
          if (x < vminX) vminX = x;
          if (x > vmaxX) vmaxX = x;
          if (y < vminY) vminY = y;
          if (y > vmaxY) vmaxY = y;
        }
      }
      if (fullN === 0) continue;
      // 화면 밖 몸은 전체 화소 수에 넣지 않았으므로 화면 잘림 비율을 대략 보정한다
      const at = personAt(p, f)!;
      const [fx, fy] = worldToFrame(cam, at.x, at.y);
      const H = p.height * cam.zoom;
      const amodal = {
        x: fx - 0.28 * H,
        y: fy - H,
        width: 0.56 * H,
        height: H,
      };
      gt.push({
        id: p.id,
        box: fmaxX >= 0 ? { x: fminX, y: fminY, width: fmaxX - fminX + 1, height: fmaxY - fminY + 1 } : amodal,
        visibleBox: visN > 0 ? { x: vminX, y: vminY, width: vmaxX - vminX + 1, height: vmaxY - vminY + 1 } : null,
        visiblePixels: visN,
        fullPixels: fullN,
        visibleRatio: fullN ? visN / fullN : 0,
      });
    }
    // 조명
    if (light.gain !== 1 || light.warm !== 0) {
      for (let i = 0; i < rgb.length; i += 3) {
        rgb[i] = clampByte(rgb[i] * light.gain + light.warm);
        rgb[i + 1] = clampByte(rgb[i + 1] * light.gain + light.warm * 0.4);
        rgb[i + 2] = clampByte(rgb[i + 2] * light.gain - light.warm * 0.3);
      }
    }
    const blur = setup.blur(f);
    if (blur > 0) boxBlurH(rgb, Math.max(1, Math.round(blur * 6)));
    if (setup.lowQuality) degradeLowQuality(rgb, rng);
    if (setup.compression) blockQuantize(rgb);
    const gray = new Uint8Array(SIM_W * SIM_H);
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
    }
    // 이전 → 이번 카메라 변환 (화면 좌표). x' = z1/z0 (x - W/2) - (c1 - c0) z1 + W/2
    const k = cam.zoom / prevCam.zoom;
    const cameraAffine = {
      a: k,
      b: 0,
      tx: (1 - k) * SIM_W / 2 - (cam.cx - prevCam.cx) * cam.zoom,
      c: 0,
      d: k,
      ty: (1 - k) * SIM_H / 2 - (cam.cy - prevCam.cy) * cam.zoom,
    };
    frames.push({ index: f, rgb, gray, label, occluder: occ, gt, camera: cam, cameraAffine, blur, lighting: light.gain });
    prevCam = cam;
  }
  return { spec, targetId: 0, frames, similarUniform: setup.similarUniform };
}

function boxBlurH(rgb: Uint8ClampedArray, r: number): void {
  const row = new Float32Array(SIM_W * 3);
  for (let y = 0; y < SIM_H; y += 1) {
    for (let x = 0; x < SIM_W; x += 1) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let n = 0;
      for (let d = -r; d <= r; d += 1) {
        const xx = Math.min(SIM_W - 1, Math.max(0, x + d));
        const i = (y * SIM_W + xx) * 3;
        s0 += rgb[i];
        s1 += rgb[i + 1];
        s2 += rgb[i + 2];
        n += 1;
      }
      row[x * 3] = s0 / n;
      row[x * 3 + 1] = s1 / n;
      row[x * 3 + 2] = s2 / n;
    }
    for (let x = 0; x < SIM_W * 3; x += 1) rgb[y * SIM_W * 3 + x] = row[x];
  }
}

function degradeLowQuality(rgb: Uint8ClampedArray, rng: Rng): void {
  // 1/2 로 줄였다 늘리고 잡음
  for (let y = 0; y < SIM_H; y += 2) {
    for (let x = 0; x < SIM_W; x += 2) {
      for (let c = 0; c < 3; c += 1) {
        let s = 0;
        let n = 0;
        for (let dy = 0; dy < 2 && y + dy < SIM_H; dy += 1) {
          for (let dx = 0; dx < 2 && x + dx < SIM_W; dx += 1) {
            s += rgb[((y + dy) * SIM_W + x + dx) * 3 + c];
            n += 1;
          }
        }
        const v = s / n;
        for (let dy = 0; dy < 2 && y + dy < SIM_H; dy += 1) {
          for (let dx = 0; dx < 2 && x + dx < SIM_W; dx += 1) {
            rgb[((y + dy) * SIM_W + x + dx) * 3 + c] = clampByte(v + rng.normal() * 9);
          }
        }
      }
    }
  }
}

function blockQuantize(rgb: Uint8ClampedArray): void {
  for (let by = 0; by < SIM_H; by += 8) {
    for (let bx = 0; bx < SIM_W; bx += 8) {
      for (let c = 0; c < 3; c += 1) {
        let s = 0;
        let n = 0;
        for (let y = by; y < Math.min(SIM_H, by + 8); y += 1) {
          for (let x = bx; x < Math.min(SIM_W, bx + 8); x += 1) {
            s += rgb[(y * SIM_W + x) * 3 + c];
            n += 1;
          }
        }
        const mean = s / n;
        for (let y = by; y < Math.min(SIM_H, by + 8); y += 1) {
          for (let x = bx; x < Math.min(SIM_W, bx + 8); x += 1) {
            const i = (y * SIM_W + x) * 3 + c;
            // 블록 평균 쪽으로 70% 끌어당기고 16단계 양자화
            rgb[i] = Math.round((mean * 0.7 + rgb[i] * 0.3) / 16) * 16;
          }
        }
      }
    }
  }
}
