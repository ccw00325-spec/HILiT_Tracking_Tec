/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e89df199 @license @preserve */
/* 위치 추적기(상관필터)의 GPU 계산판 — 2026-10-12.
 *
 * ## 무엇을 옮겼나
 *
 * 추적기 한 걸음의 무거운 수치 계산만 GPU(WebGPU 계산 셰이더)로 옮겼다:
 *   조각 뜨기(쌍선형) → 칸 특징(방향 9 · 밝기 · 반대색 2) → 정규화·코사인 창 → 2차원 푸리에 변환 →
 *   가우시안 커널 상관 → 응답 지도, 그리고 모델 학습(α · 모델 스펙트럼 갱신).
 *
 * **판단 규칙은 옮기지 않았다.** 어느 크기를 고를지, 놓쳤다고 볼지, 배울지 말지는 정본
 * (packages/hilit-vision/src/dcf-tracker.ts → generated/dcf-tracker.js) 의 HilitDcfTrackerCore 가 그대로 정한다.
 * 이 파일의 DcfDeferredCore 는 그 클래스를 물려받아 계산 세 곳(features · train · respond)만 계산기(engine)로 돌린다.
 * 그래서 규칙이 두 벌로 갈라지지 않는다.
 *
 * ## 계산기 둘
 *
 *   DcfReferenceEngine  CPU. 정본의 계산을 그대로 부른다. 이 계산기로 돌리면 결과가 정본과 **완전히 같다** —
 *                       「계산을 미뤄 돌리는 구조」가 규칙을 바꾸지 않았다는 것을 시험으로 고정한다.
 *   DcfWebGpuEngine     GPU. 32비트 실수로 계산한다(정본은 64비트). 그래서 응답 값이 소수 아래에서 조금 다르다.
 *                       같은 결과라고 말하지 않는다 — 차이는 재서 기록한다(연구 저장소 docs/tracking-research).
 *
 * ## 이것이 아닌 것
 *
 * - 동일인 판정이 아니다. confidence 는 상관 응답 PSR 에서 온 위치 관측 품질이다(정본과 같다).
 * - 외부 코드·가중치가 없다. 셰이더는 정본 식을 옮겨 적은 자체 구현이다.
 * - 영상을 읽는 일(디코딩)은 여기서 하지 않는다.
 */
import { HilitDcfTrackerCore, DCF_CHANNELS, DCF_HOG_BINS, samplePatch } from './generated/dcf-tracker.js';

const GPU_MODEL = Object.freeze({ gpu: true });

function patchStdOf(p) {
  const n = p.r.length;
  if (!n) return 0;
  let s = 0, sq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = 0.299 * p.r[i] + 0.587 * p.g[i] + 0.114 * p.b[i];
    s += v; sq += v * v;
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

/**
 * 정본 추적기에서 계산 세 곳만 미뤄 돌린다.
 *
 *   respond(frame, s)   미리 계산해 둔 응답(cache)을 꺼내 준다
 *   features(...)       계산하지 않고 「어디를 볼지」만 적어 돌려준다
 *   train(desc, rate)   할 일 목록(pending)에 올린다 — 어댑터가 update 뒤에 차례로 실행한다
 */
export class DcfDeferredCore extends HilitDcfTrackerCore {
  constructor(params = {}) {
    super(params);
    this.pending = [];
    this.cache = null;
    this.inInit = false;
  }

  init(frame, box, timeSec = null) {
    this.inInit = true;
    try { super.init(frame, box, timeSec); } finally { this.inInit = false; }
  }

  features(frame, cx, cy, s) {
    const winW = this.baseWinW * s;
    const winH = this.baseWinH * s;
    if (this.inInit) {
      /* init 은 방금 뜬 조각이 빈 화면인지(밝기 표준편차)를 곧바로 본다. 드문 길이라 여기서만 CPU 로 잰다. */
      const c = this.params.cell;
      this.lastPatchStd = patchStdOf(samplePatch(frame, cx, cy, winW, winH, this.fw * c, this.fh * c));
    }
    return { frame, cx, cy, winW, winH };
  }

  train(desc, rate) {
    const replace = !this.modelX || rate >= 1;
    if (replace) {
      /* 새로 배운다 — 격자·창·목표가 바뀌었을 수 있으니 계산기를 다시 맞춘다. */
      this.pending.push({
        kind: 'configure', fw: this.fw, fh: this.fh, cell: this.params.cell,
        winX: this.winX, winY: this.winY, yf: this.yf,
      });
    }
    this.pending.push({ kind: 'train', ...desc, rate, replace });
    this.modelX = GPU_MODEL;
  }

  respond(_frame, s) {
    const resp = this.cache?.get(s);
    if (!resp) throw new Error(`DcfDeferredCore: 크기 ${s} 의 응답이 준비되지 않았습니다`);
    return { resp, z: null };
  }

  /** 다음 update 가 물어볼 크기들(정본 update 의 고리와 같은 식). 응답을 미리 계산할 때 쓴다. */
  plannedScales() {
    if (!this.initialized || this.blankInit) return [];
    const out = [];
    for (const f of this.params.scales) {
      const s = this.scale * f;
      if (s < this.params.minScale || s > this.params.maxScale) continue;
      out.push(s);
    }
    return out;
  }
}

/* ------------------------------------------------------------------
 * 계산기 — CPU 기준판
 * ------------------------------------------------------------------ */

/** 정본의 계산을 그대로 부른다. 결과는 정본 추적기와 완전히 같다. */
export class DcfReferenceEngine {
  constructor(params = {}) {
    this.kind = 'cpu-reference';
    this.ref = new HilitDcfTrackerCore(params);
  }

  configure({ fw, fh, winX, winY, yf }) {
    Object.assign(this.ref, { fw, fh, winX, winY, yf, modelX: null, alphaRe: null, alphaIm: null });
  }

  place(cx, cy, winW, winH) {
    Object.assign(this.ref, { cx, cy, baseWinW: winW, baseWinH: winH });
  }

  async respond(frame, cx, cy, wins) {
    return wins.map((w) => {
      this.place(cx, cy, w.winW, w.winH);
      return this.ref.respond(frame, 1).resp;
    });
  }

  async train({ frame, cx, cy, winW, winH, rate, replace }) {
    this.place(cx, cy, winW, winH);
    if (replace) this.ref.modelX = null;
    this.ref.train(this.ref.features(frame, cx, cy, 1), rate);
  }

  dispose() {}
}

/* ------------------------------------------------------------------
 * 계산기 — WebGPU
 * ------------------------------------------------------------------ */

let sharedDevice = null;

/** GPU 장치를 얻는다. 없거나 실패하면 null 과 이유. 한 번 얻은 장치는 나눠 쓴다. */
export async function requestDcfGpuDevice(options = {}) {
  if (sharedDevice) return sharedDevice;
  const attempt = (async () => {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return { device: null, reason: 'webgpu-unavailable' };
    let adapter = null;
    try {
      adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' });
    } catch (cause) {
      return { device: null, reason: `adapter-failed: ${String(cause?.message ?? cause)}` };
    }
    if (!adapter) return { device: null, reason: 'no-adapter' };
    try {
      const device = await adapter.requestDevice();
      const info = adapter.info ?? null;
      device.lost.then(() => { sharedDevice = null; pipelineCache.delete(device); });
      return {
        device, reason: null,
        adapter: { vendor: info?.vendor ?? null, architecture: info?.architecture ?? null, fallback: adapter.isFallbackAdapter ?? info?.isFallbackAdapter ?? null },
      };
    } catch (cause) {
      return { device: null, reason: `device-failed: ${String(cause?.message ?? cause)}` };
    }
  })();
  sharedDevice = attempt;
  const got = await attempt;
  if (!got.device) sharedDevice = null;
  return got;
}

const f32 = (v) => {
  const s = Math.fround(v).toString();
  return /[.e]/.test(s) ? s : `${s}.0`;
};
const f32List = (values) => Array.from(values, f32).join(', ');

/** 푸리에 변환 한 축(직접 합). 격자가 64 이하라 곱셈 수가 작다. 회전 인자는 표로 굽는다 — GPU 삼각함수를 믿지 않는다. */
function dftShader({ fw, fh, axis, inverse }) {
  const N = axis === 'x' ? fw : fh;
  const table = [];
  for (let i = 0; i < N; i += 1) {
    const a = (2 * Math.PI * i) / N;
    table.push(`vec2<f32>(${f32(Math.cos(a))}, ${f32((inverse ? 1 : -1) * Math.sin(a))})`);
  }
  return /* wgsl */`
const FW: u32 = ${fw}u;
const FH: u32 = ${fh}u;
const N: u32 = ${N}u;
const SCALE: f32 = ${f32(inverse ? 1 / N : 1)};
const TW = array<vec2<f32>, ${N}>(${table.join(', ')});
@group(0) @binding(0) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&dst)) { return; }
  let n = FW * FH;
  let base = (i / n) * n;
  let k = i % n;
  let y = k / FW;
  let x = k % FW;
  var acc = vec2<f32>(0.0, 0.0);
  for (var j = 0u; j < N; j = j + 1u) {
    ${axis === 'x'
    ? 'let v = src[base + y * FW + j]; let w = TW[(x * j) % N];'
    : 'let v = src[base + j * FW + x]; let w = TW[(y * j) % N];'}
    acc = acc + vec2<f32>(v.x * w.x - v.y * w.y, v.x * w.y + v.y * w.x);
  }
  dst[i] = acc * SCALE;
}`;
}

function shaders({ fw, fh, cell, smax, winX, winY, kernelSigma, lambda }) {
  const pw = fw * cell;
  const ph = fh * cell;
  const n = fw * fh;
  const C = DCF_CHANNELS;
  const B = DCF_HOG_BINS;
  const RAW = C + 1;                       // 방향 9 · 밝기 · 반대색 2 · 칸 에너지
  const head = /* wgsl */`
const FW: u32 = ${fw}u;
const FH: u32 = ${fh}u;
const CELL: u32 = ${cell}u;
const PW: u32 = ${pw}u;
const PH: u32 = ${ph}u;
const NCELL: u32 = ${n}u;
const SMAX: u32 = ${smax}u;
const CH: u32 = ${C}u;
const BINS: u32 = ${B}u;
const RAW: u32 = ${RAW}u;
struct Call {
  region: vec4<f32>,                       // 조각 가로 · 세로 · 학습률 · 새로 배우기(1)
  wins: array<vec4<f32>, ${smax}>,         // 크기마다: 조각 안 창 왼쪽 위 x · y · 창 가로 · 세로
};`;

  const patch = /* wgsl */`${head}
@group(0) @binding(0) var frame: texture_2d<u32>;
@group(0) @binding(1) var<uniform> call: Call;
@group(0) @binding(2) var<storage, read_write> tile: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&tile)) { return; }
  let per = PW * PH;
  let s = i / per;
  let o = i % per;
  let y = o / PW;
  let x = o % PW;
  let win = call.wins[s];
  let W = call.region.x;
  let H = call.region.y;
  let sx = win.z / f32(PW);
  let sy = win.w / f32(PH);
  var fy = win.y + (f32(y) + 0.5) * sy - 0.5;
  fy = clamp(fy, 0.0, H - 1.0);
  let iy = min(H - 2.0, floor(fy));
  var ty = 0.0;
  if (H > 1.0) { ty = fy - iy; }
  var fx = win.x + (f32(x) + 0.5) * sx - 0.5;
  fx = clamp(fx, 0.0, W - 1.0);
  let ix = min(W - 2.0, floor(fx));
  var tx = 0.0;
  if (W > 1.0) { tx = fx - ix; }
  let x0 = i32(max(0.0, ix));
  let x1 = i32(min(W - 1.0, ix + 1.0));
  let y0 = i32(max(0.0, iy));
  let y1 = i32(min(H - 1.0, iy + 1.0));
  let p00 = vec3<f32>(textureLoad(frame, vec2<i32>(x0, y0), 0).rgb);
  let p01 = vec3<f32>(textureLoad(frame, vec2<i32>(x1, y0), 0).rgb);
  let p10 = vec3<f32>(textureLoad(frame, vec2<i32>(x0, y1), 0).rgb);
  let p11 = vec3<f32>(textureLoad(frame, vec2<i32>(x1, y1), 0).rgb);
  let c = (1.0 - tx) * (1.0 - ty) * p00 + tx * (1.0 - ty) * p01 + (1.0 - tx) * ty * p10 + tx * ty * p11;
  tile[i] = vec4<f32>(c, 0.299 * c.x + 0.587 * c.y + 0.114 * c.z);
}`;

  const cells = /* wgsl */`${head}
@group(0) @binding(0) var<storage, read> tile: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> raw: array<f32>;
fn unsignedAngle(gx0: f32, gy0: f32) -> f32 {
  var x = gx0;
  var y = gy0;
  if (y < 0.0 || (y == 0.0 && x < 0.0)) { x = -x; y = -y; }
  let ax = abs(x);
  if (ax < 1e-12 && y < 1e-12) { return 0.0; }
  let swap = y > ax;
  var t = 0.0;
  if (swap) { t = ax / y; } else { t = y / ax; }
  let t2 = t * t;
  var a = t * (0.9998660 + t2 * (-0.3302995 + t2 * (0.1801410 + t2 * (-0.0851330 + t2 * 0.0208351))));
  if (swap) { a = 1.5707963267948966 - a; }
  if (x < 0.0) { a = 3.141592653589793 - a; }
  if (a >= 3.141592653589793) { return 0.0; }
  return a;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= SMAX * NCELL) { return; }
  let s = i / NCELL;
  let c = i % NCELL;
  let cy = c / FW;
  let cx = c % FW;
  let base = s * PW * PH;
  var hog: array<f32, ${B}>;
  var lum = 0.0;
  var opp1 = 0.0;
  var opp2 = 0.0;
  let binScale = f32(BINS) / 3.141592653589793;
  for (var dy = 0u; dy < CELL; dy = dy + 1u) {
    let y = cy * CELL + dy;
    var yU = y;
    if (y > 0u) { yU = y - 1u; }
    var yD = y;
    if (y < PH - 1u) { yD = y + 1u; }
    for (var dx = 0u; dx < CELL; dx = dx + 1u) {
      let x = cx * CELL + dx;
      var xL = x;
      if (x > 0u) { xL = x - 1u; }
      var xR = x;
      if (x < PW - 1u) { xR = x + 1u; }
      let p = tile[base + y * PW + x];
      let gx = tile[base + y * PW + xR].w - tile[base + y * PW + xL].w;
      let gy = tile[base + yD * PW + x].w - tile[base + yU * PW + x].w;
      let mag = sqrt(gx * gx + gy * gy);
      if (mag > 1e-6) {
        let fb = unsignedAngle(gx, gy) * binScale - 0.5;
        let fl = floor(fb);
        let t = fb - fl;
        var b0 = i32(fl);
        var b1 = b0 + 1;
        if (b0 < 0) { b0 = b0 + i32(BINS); }
        if (b1 >= i32(BINS)) { b1 = b1 - i32(BINS); }
        hog[b0] = hog[b0] + mag * (1.0 - t);
        hog[b1] = hog[b1] + mag * t;
      }
      lum = lum + p.w;
      opp1 = opp1 + (p.x - p.y);
      opp2 = opp2 + (p.x + p.y - 2.0 * p.z);
    }
  }
  let o = i * RAW;
  var e = 0.0;
  for (var k = 0u; k < BINS; k = k + 1u) {
    raw[o + k] = hog[k];
    e = e + hog[k] * hog[k];
  }
  raw[o + BINS] = lum;
  raw[o + BINS + 1u] = opp1;
  raw[o + BINS + 2u] = opp2;
  raw[o + BINS + 3u] = e;
}`;

  const norm = /* wgsl */`${head}
const WINX = array<f32, ${fw}>(${f32List(winX)});
const WINY = array<f32, ${fh}>(${f32List(winY)});
@group(0) @binding(0) var<storage, read> raw: array<f32>;
@group(0) @binding(1) var<storage, read_write> spec: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= SMAX * NCELL) { return; }
  let s = i / NCELL;
  let c = i % NCELL;
  let y = i32(c / FW);
  let x = i32(c % FW);
  var sum = 0.0;
  var cnt = 0.0;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    let yy = y + dy;
    if (yy < 0 || yy >= i32(FH)) { continue; }
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let xx = x + dx;
      if (xx < 0 || xx >= i32(FW)) { continue; }
      sum = sum + raw[(s * NCELL + u32(yy) * FW + u32(xx)) * RAW + BINS + 3u];
      cnt = cnt + 1.0;
    }
  }
  let nrm = 1.0 / sqrt(sum / cnt + 1e-4);
  let wgt = WINX[x] * WINY[y];
  let px = f32(CELL * CELL);
  let o = i * RAW;
  let out = s * CH * NCELL + c;
  for (var k = 0u; k < BINS; k = k + 1u) {
    spec[out + k * NCELL] = vec2<f32>(min(0.2, raw[o + k] * nrm) * wgt, 0.0);
  }
  spec[out + BINS * NCELL] = vec2<f32>((raw[o + BINS] / px / 255.0 - 0.5) * wgt, 0.0);
  spec[out + (BINS + 1u) * NCELL] = vec2<f32>((raw[o + BINS + 1u] / px / 255.0) * wgt, 0.0);
  spec[out + (BINS + 2u) * NCELL] = vec2<f32>((raw[o + BINS + 2u] / px / 510.0) * wgt, 0.0);
}`;

  /* 공간 영역 제곱합. 줄마다 먼저 모아 더한다(32비트 누적 오차를 줄인다). */
  const energy = /* wgsl */`${head}
@group(0) @binding(0) var<storage, read> spec: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> energy: array<f32>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= SMAX) { return; }
  let base = s * CH * NCELL;
  var total = 0.0;
  for (var row = 0u; row < CH * FH; row = row + 1u) {
    var part = 0.0;
    for (var x = 0u; x < FW; x = x + 1u) {
      let v = spec[base + row * FW + x].x;
      part = part + v * v;
    }
    total = total + part;
  }
  energy[s] = total;
}`;

  /* Σ_c A_c ⊙ conj(B_c). 응답 때는 A=지금 조각(크기마다) · B=모델, 학습 때는 A=B=지금 조각. */
  const cross = /* wgsl */`${head}
@group(0) @binding(0) var<storage, read> a: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> b: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= SMAX * NCELL) { return; }
  let s = i / NCELL;
  let k = i % NCELL;
  var acc = vec2<f32>(0.0, 0.0);
  for (var c = 0u; c < CH; c = c + 1u) {
    let x = a[(s * CH + c) * NCELL + k];
    let z = b[c * NCELL + k];
    acc = acc + vec2<f32>(x.x * z.x + x.y * z.y, x.y * z.x - x.x * z.y);
  }
  dst[i] = acc;
}`;

  const gauss = (self) => /* wgsl */`${head}
const INV: f32 = ${f32(1 / (kernelSigma * kernelSigma))};
const DENOM: f32 = ${f32(n * C)};
@group(0) @binding(0) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> energy: array<f32>;
@group(0) @binding(2) var<storage, read> modelEnergy: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= SMAX * NCELL) { return; }
  let s = i / NCELL;
  let xe = energy[s];
  ${self ? 'let ze = energy[s] + 0.0 * modelEnergy[0];' : 'let ze = modelEnergy[0];'}
  let d = max(0.0, (xe + ze - 2.0 * src[i].x) / DENOM);
  dst[i] = vec2<f32>(exp(-INV * d), 0.0);
}`;

  const respMul = /* wgsl */`${head}
@group(0) @binding(0) var<storage, read> k: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> alpha: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= SMAX * NCELL) { return; }
  let a = alpha[i % NCELL];
  let v = k[i];
  dst[i] = vec2<f32>(a.x * v.x - a.y * v.y, a.x * v.y + a.y * v.x);
}`;

  const trainAlpha = /* wgsl */`${head}
const LAMBDA: f32 = ${f32(lambda)};
@group(0) @binding(0) var<storage, read> k: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> label: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> energy: array<f32>;
@group(0) @binding(3) var<uniform> call: Call;
@group(0) @binding(4) var<storage, read_write> alpha: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> modelEnergy: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= NCELL) { return; }
  let rate = call.region.z;
  let replace = call.region.w > 0.5;
  let dr = k[i].x + LAMBDA;
  let di = k[i].y;
  let den = dr * dr + di * di;
  let y = label[i];
  let fresh = vec2<f32>((y.x * dr + y.y * di) / den, (y.y * dr - y.x * di) / den);
  if (replace) { alpha[i] = fresh; } else { alpha[i] = alpha[i] + rate * (fresh - alpha[i]); }
  if (i == 0u) {
    if (replace) { modelEnergy[0] = energy[0]; } else { modelEnergy[0] = modelEnergy[0] + rate * (energy[0] - modelEnergy[0]); }
  }
}`;

  const trainModel = /* wgsl */`${head}
@group(0) @binding(0) var<storage, read> spec: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> call: Call;
@group(0) @binding(2) var<storage, read_write> model: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= CH * NCELL) { return; }
  let rate = call.region.z;
  if (call.region.w > 0.5) { model[i] = spec[i]; } else { model[i] = model[i] + rate * (spec[i] - model[i]); }
}`;

  return {
    patch, cells, norm, energy, cross, gaussSelf: gauss(true), gaussModel: gauss(false), respMul, trainAlpha, trainModel,
    dftXf: dftShader({ fw, fh, axis: 'x', inverse: false }), dftYf: dftShader({ fw, fh, axis: 'y', inverse: false }),
    dftXi: dftShader({ fw, fh, axis: 'x', inverse: true }), dftYi: dftShader({ fw, fh, axis: 'y', inverse: true }),
  };
}

/** 장치마다 · 격자마다 한 번만 셰이더를 짠다(대상 여럿이 같은 격자를 쓰면 나눠 쓴다). */
const pipelineCache = new WeakMap();

function pipelinesFor(device, key, config) {
  let byKey = pipelineCache.get(device);
  if (!byKey) { byKey = new Map(); pipelineCache.set(device, byKey); }
  let set = byKey.get(key);
  if (set) return set;
  const source = shaders(config);
  set = {};
  for (const [name, code] of Object.entries(source)) {
    const module = device.createShaderModule({ code });
    set[name] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  }
  byKey.set(key, set);
  return set;
}

export class DcfWebGpuEngine {
  constructor(device, params = {}) {
    this.kind = 'webgpu';
    this.device = device;
    this.kernelSigma = params.kernelSigma;
    this.lambda = params.lambda;
    this.smax = Math.max(1, params.scales?.length ?? 1);
    this.key = null;
    this.buffers = null;
    this.texture = null;
    this.textureSize = [0, 0];
    this.uploaded = null;
    this.groups = null;
    this.stats = { responds: 0, trains: 0, configures: 0 };
  }

  configure({ fw, fh, cell, winX, winY, yf }) {
    const key = `${fw}x${fh}c${cell}s${this.smax}k${this.kernelSigma}l${this.lambda}`;
    this.stats.configures += 1;
    if (key !== this.key) {
      this.disposeBuffers();
      this.key = key;
      this.grid = { fw, fh, cell, n: fw * fh, pw: fw * cell, ph: fh * cell };
      this.pipes = pipelinesFor(this.device, key, { fw, fh, cell, smax: this.smax, winX, winY, kernelSigma: this.kernelSigma, lambda: this.lambda });
      this.allocate();
    }
    const { n } = this.grid;
    const label = new Float32Array(n * 2);
    for (let k = 0; k < n; k += 1) { label[k * 2] = yf.re[k]; label[k * 2 + 1] = yf.im[k]; }
    this.device.queue.writeBuffer(this.buffers.label, 0, label);
  }

  allocate() {
    const d = this.device;
    const { n, pw, ph } = this.grid;
    const S = this.smax;
    const C = DCF_CHANNELS;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const make = (floats, usage = storage) => d.createBuffer({ size: Math.max(16, floats * 4), usage });
    this.buffers = {
      patch: make(S * pw * ph * 4),
      raw: make(S * n * (C + 1)),
      specA: make(S * C * n * 2),
      specB: make(S * C * n * 2),
      energy: make(Math.max(4, S)),
      kA: make(S * n * 2),
      kB: make(S * n * 2),
      model: make(C * n * 2),
      alpha: make(n * 2),
      label: make(n * 2),
      modelEnergy: make(4),
      call: d.createBuffer({ size: 16 + 16 * S, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      readback: d.createBuffer({ size: S * n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    };
    this.groups = null;
  }

  ensureTexture(width, height) {
    if (this.texture && this.textureSize[0] >= width && this.textureSize[1] >= height) return;
    this.texture?.destroy();
    const w = Math.max(width, this.textureSize[0], 2);
    const h = Math.max(height, this.textureSize[1], 2);
    this.texture = this.device.createTexture({
      size: [w, h], format: 'rgba8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.textureSize = [w, h];
    this.uploaded = null;
    this.groups = null;
  }

  bind() {
    if (this.groups) return this.groups;
    const d = this.device;
    const b = this.buffers;
    const p = this.pipes;
    const group = (pipeline, entries) => d.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource: resource.createView ? resource.createView() : { buffer: resource } })),
    });
    const dft = (pipeline, src, dst) => group(pipeline, [src, dst]);
    this.groups = {
      patch: group(p.patch, [this.texture, b.call, b.patch]),
      cells: group(p.cells, [b.patch, b.raw]),
      norm: group(p.norm, [b.raw, b.specA]),
      energy: group(p.energy, [b.specA, b.energy]),          // 변환 전(공간 영역) 특징의 제곱합
      specXf: dft(p.dftXf, b.specA, b.specB),
      specYf: dft(p.dftYf, b.specB, b.specA),
      crossModel: group(p.cross, [b.specA, b.model, b.kA]),
      crossSelf: group(p.cross, [b.specA, b.specB, b.kA]),   // 학습: B 자리에 specA 의 사본(specB)을 쓴다 — 같은 버퍼를 읽기·쓰기에 겹쳐 묶지 않으려고
      kXi: dft(p.dftXi, b.kA, b.kB),
      kYi: dft(p.dftYi, b.kB, b.kA),
      gaussModel: group(p.gaussModel, [b.kA, b.energy, b.modelEnergy, b.kB]),
      gaussSelf: group(p.gaussSelf, [b.kA, b.energy, b.modelEnergy, b.kB]),
      kXf: dft(p.dftXf, b.kB, b.kA),
      kYf: dft(p.dftYf, b.kA, b.kB),
      respMul: group(p.respMul, [b.kB, b.alpha, b.kA]),
      trainAlpha: group(p.trainAlpha, [b.kB, b.label, b.energy, b.call, b.alpha, b.modelEnergy]),
      trainModel: group(p.trainModel, [b.specA, b.call, b.model]),
    };
    return this.groups;
  }

  upload(frame) {
    if (this.uploaded === frame) return;
    this.ensureTexture(frame.frameWidth ?? frame.width, frame.frameHeight ?? frame.height);
    this.device.queue.writeTexture(
      { texture: this.texture },
      frame.data,
      { offset: 0, bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
      { width: frame.width, height: frame.height },
    );
    this.uploaded = frame;
  }

  writeCall(frame, cx, cy, wins, rate, replace) {
    const data = new Float32Array(4 + 4 * this.smax);
    data[0] = frame.width;
    data[1] = frame.height;
    data[2] = rate;
    data[3] = replace ? 1 : 0;
    const ox = frame.ox ?? 0;
    const oy = frame.oy ?? 0;
    wins.forEach((w, i) => {
      data[4 + i * 4] = cx - w.winW / 2 - ox;
      data[5 + i * 4] = cy - w.winH / 2 - oy;
      data[6 + i * 4] = w.winW;
      data[7 + i * 4] = w.winH;
    });
    /* 쓰지 않는 크기 자리는 첫 창으로 채운다(0 으로 나누는 일을 막는다). 결과는 읽지 않는다. */
    for (let i = wins.length; i < this.smax; i += 1) data.copyWithin(4 + i * 4, 4, 8);
    this.device.queue.writeBuffer(this.buffers.call, 0, data);
  }

  /** 조각 → 스펙트럼(specA) · 에너지. layers 는 크기 수. */
  encodeFeatures(pass, g, layers) {
    const { n, pw, ph } = this.grid;
    const C = DCF_CHANNELS;
    const run = (pipeline, groupName, count, size = 64) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, g[groupName]);
      pass.dispatchWorkgroups(Math.ceil(count / size));
    };
    run(this.pipes.patch, 'patch', layers * pw * ph);
    run(this.pipes.cells, 'cells', layers * n);
    run(this.pipes.norm, 'norm', layers * n);
    run(this.pipes.energy, 'energy', layers, 1);
    run(this.pipes.dftXf, 'specXf', layers * C * n);
    run(this.pipes.dftYf, 'specYf', layers * C * n);
    return run;
  }

  async respond(frame, cx, cy, wins) {
    if (wins.length > this.smax) throw new Error(`DcfWebGpuEngine: 크기 후보가 ${this.smax} 개를 넘습니다`);
    const d = this.device;
    const { n } = this.grid;
    const S = wins.length;
    this.upload(frame);
    this.writeCall(frame, cx, cy, wins, 0, false);
    const g = this.bind();
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const run = this.encodeFeatures(pass, g, S);
    run(this.pipes.cross, 'crossModel', S * n);
    run(this.pipes.dftXi, 'kXi', S * n);
    run(this.pipes.dftYi, 'kYi', S * n);
    run(this.pipes.gaussModel, 'gaussModel', S * n);
    run(this.pipes.dftXf, 'kXf', S * n);
    run(this.pipes.dftYf, 'kYf', S * n);
    run(this.pipes.respMul, 'respMul', S * n);
    run(this.pipes.dftXi, 'kXi', S * n);
    run(this.pipes.dftYi, 'kYi', S * n);
    pass.end();
    encoder.copyBufferToBuffer(this.buffers.kA, 0, this.buffers.readback, 0, S * n * 8);
    d.queue.submit([encoder.finish()]);
    await this.buffers.readback.mapAsync(GPUMapMode.READ, 0, S * n * 8);
    const view = new Float32Array(this.buffers.readback.getMappedRange(0, S * n * 8));
    const out = [];
    for (let s = 0; s < S; s += 1) {
      const resp = new Float64Array(n);
      for (let k = 0; k < n; k += 1) resp[k] = view[(s * n + k) * 2];
      out.push(resp);
    }
    this.buffers.readback.unmap();
    this.stats.responds += 1;
    return out;
  }

  async train({ frame, cx, cy, winW, winH, rate, replace }) {
    const d = this.device;
    const { n } = this.grid;
    const C = DCF_CHANNELS;
    this.upload(frame);
    this.writeCall(frame, cx, cy, [{ winW, winH }], rate, replace);
    const g = this.bind();
    const encoder = d.createCommandEncoder();
    {
      const pass = encoder.beginComputePass();
      this.encodeFeatures(pass, g, 1);
      pass.end();
    }
    /* 자기 상관은 같은 스펙트럼을 두 자리에 읽는다. 사본을 떠 둔다. */
    encoder.copyBufferToBuffer(this.buffers.specA, 0, this.buffers.specB, 0, C * n * 8);
    {
      const pass = encoder.beginComputePass();
      const run = (pipeline, groupName, count) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, g[groupName]);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
      };
      run(this.pipes.cross, 'crossSelf', n);
      run(this.pipes.dftXi, 'kXi', n);
      run(this.pipes.dftYi, 'kYi', n);
      run(this.pipes.gaussSelf, 'gaussSelf', n);
      run(this.pipes.dftXf, 'kXf', n);
      run(this.pipes.dftYf, 'kYf', n);
      run(this.pipes.trainAlpha, 'trainAlpha', n);
      run(this.pipes.trainModel, 'trainModel', C * n);
      pass.end();
    }
    d.queue.submit([encoder.finish()]);
    this.stats.trains += 1;
  }

  disposeBuffers() {
    if (this.buffers) for (const buffer of Object.values(this.buffers)) buffer.destroy();
    this.buffers = null;
    this.groups = null;
  }

  dispose() {
    this.disposeBuffers();
    this.texture?.destroy();
    this.texture = null;
    this.uploaded = null;
  }
}

/* ------------------------------------------------------------------
 * 파이프라인이 부르는 어댑터 — 모양은 hilit-dcf-tracker.js 의 HilitDcfTracker 와 같다.
 * ------------------------------------------------------------------ */

function readRegion(ctx, rect) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const x = Math.max(0, Math.min(W - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(H - 1, Math.floor(rect.y)));
  const w = Math.max(1, Math.min(W - x, Math.ceil(rect.width)));
  const h = Math.max(1, Math.min(H - y, Math.ceil(rect.height)));
  const id = ctx.getImageData(x, y, w, h);
  return { data: id.data, width: w, height: h, ox: x, oy: y, frameWidth: W, frameHeight: H };
}

const normBox = (box) => ({ x: box.x, y: box.y, width: box.width ?? box.w, height: box.height ?? box.h });
const roundBox = (box) => ({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });

export class HilitDcfGpuTracker {
  /** engine: DcfWebGpuEngine 또는 DcfReferenceEngine. 보통은 create() 로 만든다. */
  constructor(params = {}, engine) {
    this.core = new DcfDeferredCore(params);
    this.engine = engine;
    this.kind = 'dcf';
    this.backend = engine.kind;
  }

  /**
   * GPU 계산판을 만든다. GPU 를 쓸 수 없으면 { tracker: null, reason } — 부르는 쪽이 CPU 판으로 돌아간다.
   */
  static async create(params = {}, options = {}) {
    const got = await requestDcfGpuDevice(options);
    if (!got.device) return { tracker: null, reason: got.reason, adapter: null };
    const core = new HilitDcfTrackerCore(params);
    const engine = new DcfWebGpuEngine(got.device, core.params);
    return { tracker: new HilitDcfGpuTracker(params, engine), reason: null, adapter: got.adapter ?? null };
  }

  get w0() { return this.core.w0; }
  set w0(v) { this.core.w0 = v; }
  get h0() { return this.core.h0; }
  set h0(v) { this.core.h0 = v; }

  /** 미뤄 둔 계산(다시 맞추기 · 학습)을 차례로 실행한다. */
  async flush() {
    const jobs = this.core.pending.splice(0);
    for (const job of jobs) {
      if (job.kind === 'configure') this.engine.configure(job);
      else await this.engine.train(job);
    }
  }

  async init(ctx, box, timeSec = null) {
    const b = normBox(box);
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    this.core.init(readRegion(ctx, this.core.searchRegion(W, H, b)), b, timeSec);
    await this.flush();
  }

  async update(ctx, timeSec = null, options = null) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const core = this.core;
    const frame = readRegion(ctx, core.searchRegion(W, H));
    const scales = core.plannedScales();
    core.cache = new Map();
    if (scales.length) {
      const wins = scales.map((s) => ({ winW: core.baseWinW * s, winH: core.baseWinH * s }));
      const responses = await this.engine.respond(frame, core.cx, core.cy, wins);
      scales.forEach((s, i) => core.cache.set(s, responses[i]));
    }
    let r;
    try { r = core.update(frame, timeSec, options); } finally { core.cache = null; }
    await this.flush();
    return {
      box: roundBox(r.box),
      confidence: r.confidence,
      status: r.status,
      observed: r.observed,
      pointsUsed: null,
      pointsKept: null,
      fbError: null,
      scaleEvidence: r.scale,
      psr: r.psr,
      reason: r.reason,
      frameTimestamp: r.frameTimestamp,
      referenceTimestamp: r.referenceTimestamp,
    };
  }

  async refreshTemplate(ctx, box, timeSec = null) {
    const cur = this.core.current();
    const b = {
      x: box.x ?? cur?.x ?? 0,
      y: box.y ?? cur?.y ?? 0,
      width: box.width ?? cur?.width ?? this.w0,
      height: box.height ?? cur?.height ?? this.h0,
    };
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    this.core.refresh(readRegion(ctx, this.core.searchRegion(W, H, b)), b, timeSec);
    await this.flush();
  }

  reset() {
    this.core.reset();
    this.core.pending.length = 0;
  }

  reposition(box, opts = {}) {
    this.core.reposition(normBox(box), opts);
  }

  dispose() {
    this.engine.dispose?.();
  }
}
