/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·374fc8f4 @license @preserve */
/* 마스크 외곽선의 단기 연속성 특징.

이것은 신원 특징이 아니다. 몇 프레임 사이에 "같은 트랙이 자연스럽게
이어지고 있는가" 만 본다. 그래서 이 파일이 내는 값은

  - Re-ID embedding 과 이어 붙이지 않는다 (family 가 다르다),
  - 갤러리 대표값을 갱신하지 않는다,
  - LightGlue 같은 정합기의 descriptor 로 넣지 않는다,
  - 로그·서버로 보내지 않는다 (feature-payload-guard 가 contourVector 를 가린다).

처리 순서 (요청서 3장 순서 그대로):
  1 경계 추출 → 2 외부 경계만 → 3 작은 조각 제거 → 4 평활화 →
  5 가림·화면 잘림·접촉 표시 → 6 정규화 호 길이 샘플링 → 7 접선 →
  8 곡률 → 9 폭·높이·면적·둘레·종횡비 → 10 고정 길이 벡터 → 11 거리.

좌표는 마스크 중심을 원점으로, 키(높이)로 나눈다. 가로·세로를 같은 값으로
나누는 이유는 몸 모양을 찌그러뜨리지 않기 위해서다. 종횡비는 전역 특징에
따로 남는다. 주축 회전 정규화는 하지 않는다 — 달리기·사이클·스케이팅의
기울기 정보가 사라지기 때문이다.

경계점 대응은 배열 인덱스가 아니라 공간 최근접으로 찾는다. 경계 시작점이나
경계점 순서가 달라도 거리가 같게 나온다.
*/

export const CONTOUR_FEATURE_FAMILY = 'contour-short-term-continuity' as const;
export const CONTOUR_FEATURE_VERSION = 1;

export type ContourRegion = 'upper' | 'torso' | 'lower';
export type ContourSide = 'left' | 'right';
export type ContourSport = 'running' | 'cycling' | 'skating' | 'generic';
export type ContourDistanceMethod =
  | 'trimmed-chamfer'
  | 'symmetric-chamfer'
  | 'hausdorff-p90'
  | 'hausdorff-p95';

/** 한 객체의 마스크. 격자 좌표 → 화면 좌표는 frameX + x*scale. */
export interface ContourMaskInput {
  width: number;
  height: number;
  /** 1 = 대상. 길이 width*height. */
  data: Uint8Array;
  frameX: number;
  frameY: number;
  /** 화면 px / 마스크 px. 1/2 해상도로 처리하면 2. */
  scale: number;
  frameWidth: number;
  frameHeight: number;
  /** 같은 격자의 다른 객체 마스크(접촉 구간 판정). */
  otherMask?: Uint8Array | null;
  /** 알려진 가림 영역(가림 구간 판정). */
  occluderMask?: Uint8Array | null;
  /** segmentation 신뢰도. 모르면 null — 1 로 치지 않는다. */
  segConfidence?: number | null;
}

export interface ContourPoint {
  /** 화면 좌표 */
  x: number;
  y: number;
  /** 중심 원점 · 키로 나눈 좌표 (수직 방향 유지) */
  u: number;
  v: number;
  /** 접선 방향 */
  sin: number;
  cos: number;
  /** 원 = 1 이 되도록 정규화한 평활 곡률 */
  curvature: number;
  visible: boolean;
  cut: boolean;
  contact: boolean;
  occluded: boolean;
  region: ContourRegion;
  side: ContourSide;
}

export interface ContourGlobal {
  width: number;
  height: number;
  aspect: number;
  area: number;
  extent: number;
  normPerimeter: number;
  centroidX: number;
  centroidY: number;
  solidity: number;
  /** 상·중·하단 폭 / 키 */
  bandWidths: [number, number, number];
  /** 높이별 [왼쪽, 오른쪽] 폭 / 키, NaN = 그 행이 가려지거나 잘림 */
  widthProfile: Float32Array;
  asymmetry: number;
  completeness: number;
  visibleRatio: number;
  cutRatio: number;
  contactRatio: number;
  occludedRatio: number;
}

export interface ContourExtractStats {
  componentCount: number;
  keptArea: number;
  removedArea: number;
  boundaryLength: number;
  maxProtrusion: number;
}

export interface ContourFeature {
  family: typeof CONTOUR_FEATURE_FAMILY;
  version: typeof CONTOUR_FEATURE_VERSION;
  identityClaim: false;
  sampleCount: number;
  points: ContourPoint[];
  global: ContourGlobal;
  stats: ContourExtractStats;
  segConfidence: number | null;
}

export const WIDTH_PROFILE_ROWS = 12;

export const CONTOUR_FEATURE_DEFAULTS = Object.freeze({
  sampleCount: 48,
  smoothingStrength: 1,
  /** 가장 큰 조각 대비 이 비율 미만 조각은 잡음으로 지운다 */
  minComponentShare: 0.04,
  /** 화면 가장자리에서 이 마스크 px 안의 점은 잘린 점 */
  borderMarginPx: 1.5,
  /** 다른 객체·가림에서 이 마스크 px 안의 점은 접촉/가림 점 */
  contactRadiusPx: 2,
  /** 밀집 재표본 수 (평활화·곡률 계산용) */
  denseSamples: 256,
});

export interface ContourExtractOptions {
  sampleCount?: number;
  smoothingStrength?: number;
  minComponentShare?: number;
  borderMarginPx?: number;
  contactRadiusPx?: number;
}

/* ---------- 1~3: 조각 정리 ---------- */

interface Components {
  labels: Int32Array;
  areas: number[];
}

function labelComponents(mask: ContourMaskInput): Components {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h).fill(-1);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!data[i] || labels[i] >= 0) continue;
    const id = areas.length;
    let area = 0;
    labels[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop() as number;
      area += 1;
      const px = p % w;
      const py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = px + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (data[q] && labels[q] < 0) {
            labels[q] = id;
            stack.push(q);
          }
        }
      }
    }
    areas.push(area);
  }
  return { labels, areas };
}

/* ---------- 1~2: 외부 경계 추적 (Moore 이웃) ---------- */

const MOORE: ReadonlyArray<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** 가장 큰 조각의 외부 경계를 시계 방향으로 따라간다. 구멍 경계는 보지 않는다. */
function traceOuterBoundary(inside: (x: number, y: number) => boolean, w: number, h: number): Array<[number, number]> {
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (inside(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return [];
  const out: Array<[number, number]> = [[sx, sy]];
  // 시작점 왼쪽은 배경이 보장된다(행 우선 첫 화소). 이전 방향을 서쪽으로 둔다.
  let cx = sx;
  let cy = sy;
  let back = 4;
  let firstDir = -1;
  const limit = w * h * 4 + 16;
  for (let step = 0; step < limit; step += 1) {
    let dirFound = -1;
    for (let k = 1; k <= 8; k += 1) {
      const dir = (back + k) % 8;
      if (inside(cx + MOORE[dir][0], cy + MOORE[dir][1])) {
        dirFound = dir;
        break;
      }
    }
    if (dirFound < 0) break; // 한 화소짜리 조각
    // Jacob 종료 조건: 시작점에서 처음과 같은 방향으로 나갈 때만 끝낸다.
    // 한 화소 폭 다리(팔·다리 연결부)를 두 번 지나는 경우 일찍 끝나지 않게 한다.
    if (cx === sx && cy === sy) {
      if (firstDir < 0) firstDir = dirFound;
      else if (dirFound === firstDir) break;
    }
    cx += MOORE[dirFound][0];
    cy += MOORE[dirFound][1];
    // 다음 탐색은 방금 온 이웃 다음부터(radial sweep)
    back = (dirFound + 4) % 8;
    if (!(cx === sx && cy === sy)) out.push([cx, cy]);
  }
  return out;
}

/* ---------- 4, 6: 호 길이 재표본 · 평활화 ---------- */

function resampleClosed(pts: Array<[number, number]>, n: number): Array<[number, number]> {
  const m = pts.length;
  if (m === 0) return [];
  if (m === 1) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]] as [number, number]);
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[m];
  const out: Array<[number, number]> = [];
  let seg = 0;
  for (let k = 0; k < n; k += 1) {
    const target = (k / n) * total;
    while (seg < m - 1 && cum[seg + 1] < target) seg += 1;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 1e-9 ? (target - cum[seg]) / segLen : 0;
    const a = pts[seg];
    const b = pts[(seg + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function closedLength(pts: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

function gaussianKernel(sigma: number): number[] {
  if (sigma <= 0) return [1];
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k: number[] = [];
  let s = 0;
  for (let i = -r; i <= r; i += 1) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    s += v;
  }
  return k.map((v) => v / s);
}

function smoothClosed(values: Float64Array, sigma: number): Float64Array {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const n = values.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    for (let j = -r; j <= r; j += 1) s += values[(i + j + n) % n] * k[j + r];
    out[i] = s;
  }
  return out;
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/* ---------- 9: 볼록 껍질 (solidity) ---------- */

function convexHullArea(pts: Array<[number, number]>): number {
  if (pts.length < 3) return 0;
  const p = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a = 0;
  for (let i = 0; i < hull.length; i += 1) {
    const s = hull[i];
    const t = hull[(i + 1) % hull.length];
    a += s[0] * t[1] - t[0] * s[1];
  }
  return Math.abs(a) / 2;
}

function nearAny(mask: Uint8Array | null | undefined, w: number, h: number, x: number, y: number, r: number): boolean {
  if (!mask) return false;
  const rr = Math.ceil(r);
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  for (let dy = -rr; dy <= rr; dy += 1) {
    const yy = y0 + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -rr; dx <= rr; dx += 1) {
      const xx = x0 + dx;
      if (xx < 0 || xx >= w) continue;
      if (dx * dx + dy * dy > r * r + 0.5) continue;
      if (mask[yy * w + xx]) return true;
    }
  }
  return false;
}

function regionOf(vFromTop: number): ContourRegion {
  if (vFromTop < 0.3) return 'upper';
  if (vFromTop < 0.6) return 'torso';
  return 'lower';
}

/**
 * 마스크 → 외곽선 특징. 대상이 없거나 너무 작으면 null.
 * null 은 "불일치" 가 아니라 "이번 프레임엔 외곽선 근거가 없다" 는 뜻이다.
 */
export function extractContourFeature(
  mask: ContourMaskInput,
  opts: ContourExtractOptions = {},
): ContourFeature | null {
  const n = Math.max(8, Math.round(opts.sampleCount ?? CONTOUR_FEATURE_DEFAULTS.sampleCount));
  const strength = Math.max(0, opts.smoothingStrength ?? CONTOUR_FEATURE_DEFAULTS.smoothingStrength);
  const minShare = opts.minComponentShare ?? CONTOUR_FEATURE_DEFAULTS.minComponentShare;
  const borderMargin = opts.borderMarginPx ?? CONTOUR_FEATURE_DEFAULTS.borderMarginPx;
  const contactR = opts.contactRadiusPx ?? CONTOUR_FEATURE_DEFAULTS.contactRadiusPx;
  const { width: w, height: h } = mask;
  if (w < 3 || h < 3 || mask.data.length < w * h) return null;

  // 3. 작은 조각 제거 — 가장 큰 조각만 외곽선으로 쓰고, 나머지 큰 조각 수는 품질에 남긴다
  const comps = labelComponents(mask);
  if (comps.areas.length === 0) return null;
  let best = 0;
  for (let i = 1; i < comps.areas.length; i += 1) if (comps.areas[i] > comps.areas[best]) best = i;
  const bestArea = comps.areas[best];
  if (bestArea < 12) return null;
  let componentCount = 0;
  let removedArea = 0;
  for (let i = 0; i < comps.areas.length; i += 1) {
    if (comps.areas[i] >= bestArea * minShare) componentCount += 1;
    if (i !== best) removedArea += comps.areas[i];
  }
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && comps.labels[y * w + x] === best;

  // 1~2. 외부 경계
  const raw = traceOuterBoundary(inside, w, h);
  if (raw.length < 6) return null;
  const rawLen = closedLength(raw);

  // 4. 평활화 — 밀집 재표본 후 원형 가우시안. 한 화소 흔들림이 곡률로 커지지 않게 한다.
  const dense = resampleClosed(raw, CONTOUR_FEATURE_DEFAULTS.denseSamples);
  const m = dense.length;
  const xs = new Float64Array(m);
  const ys = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    xs[i] = dense[i][0];
    ys[i] = dense[i][1];
  }
  const sigma = strength * 2.2;
  const sx = smoothClosed(xs, sigma);
  const sy = smoothClosed(ys, sigma);
  const smooth: Array<[number, number]> = [];
  for (let i = 0; i < m; i += 1) smooth.push([sx[i], sy[i]]);

  // 7~8. 밀집 경계에서 접선·곡률 (곡률은 다시 한 번 평활)
  const theta = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    const a = smooth[(i - 1 + m) % m];
    const b = smooth[(i + 1) % m];
    theta[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  const perimeterPx = closedLength(smooth);
  const ds = perimeterPx / m;
  const kappaRaw = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    const d = wrapAngle(theta[(i + 1) % m] - theta[(i - 1 + m) % m]);
    // 원이면 dθ/ds = 2π/P → 정규화 후 1
    kappaRaw[i] = ds > 1e-9 ? (d / (2 * ds)) * (perimeterPx / (2 * Math.PI)) : 0;
  }
  const kappa = smoothClosed(kappaRaw, Math.max(1, sigma));

  // 9. 전역 기하 (조각 화소 기준 면적·무게중심·상자)
  let area = 0;
  let cxSum = 0;
  let cySum = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (comps.labels[y * w + x] !== best) continue;
      area += 1;
      cxSum += x;
      cySum += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cx = cxSum / area;
  const cy = cySum / area;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const hullArea = convexHullArea(raw.map(([x, y]) => [x + 0.5, y + 0.5] as [number, number]));
  const solidity = hullArea > 0 ? Math.min(1, area / Math.max(area, hullArea)) : 1;

  // 행별 좌우 폭 (중심 기준). 행 끝점이 잘리거나 가려지면 NaN.
  const profile = new Float32Array(WIDTH_PROFILE_ROWS * 2);
  const bandW: [number, number, number] = [0, 0, 0];
  const bandN: [number, number, number] = [0, 0, 0];
  const rowFlag = (x: number, y: number) =>
    x <= borderMargin || x >= w - 1 - borderMargin || y <= borderMargin || y >= h - 1 - borderMargin
    || (mask.frameX + x * mask.scale) <= 0.5
    || (mask.frameX + (x + 1) * mask.scale) >= mask.frameWidth - 0.5
    || nearAny(mask.otherMask, w, h, x, y, contactR)
    || nearAny(mask.occluderMask, w, h, x, y, contactR);
  for (let r = 0; r < WIDTH_PROFILE_ROWS; r += 1) {
    const yy = Math.min(maxY, Math.round(minY + ((r + 0.5) / WIDTH_PROFILE_ROWS) * bh - 0.5));
    let lx = -1;
    let rx = -1;
    for (let x = minX; x <= maxX; x += 1) {
      if (comps.labels[yy * w + x] === best) {
        if (lx < 0) lx = x;
        rx = x;
      }
    }
    if (lx < 0) {
      profile[2 * r] = Number.NaN;
      profile[2 * r + 1] = Number.NaN;
      continue;
    }
    const left = (cx - lx + 0.5) / bh;
    const right = (rx - cx + 0.5) / bh;
    profile[2 * r] = rowFlag(lx, yy) ? Number.NaN : left;
    profile[2 * r + 1] = rowFlag(rx, yy) ? Number.NaN : right;
    const band = r < WIDTH_PROFILE_ROWS * 0.3 ? 0 : r < WIDTH_PROFILE_ROWS * 0.6 ? 1 : 2;
    bandW[band] += (rx - lx + 1) / bh;
    bandN[band] += 1;
  }
  const bandWidths: [number, number, number] = [
    bandN[0] ? bandW[0] / bandN[0] : 0,
    bandN[1] ? bandW[1] / bandN[1] : 0,
    bandN[2] ? bandW[2] / bandN[2] : 0,
  ];
  let asymSum = 0;
  let asymN = 0;
  for (let r = 0; r < WIDTH_PROFILE_ROWS; r += 1) {
    const l = profile[2 * r];
    const rr = profile[2 * r + 1];
    if (!Number.isFinite(l) || !Number.isFinite(rr) || l + rr <= 1e-6) continue;
    asymSum += Math.abs(l - rr) / (l + rr);
    asymN += 1;
  }

  // 6. 정규화 호 길이로 N점 재표본 — 인덱스 간격이 아니다
  const sampled = resampleClosed(smooth, n);
  const step = m / n;
  let maxProtrusion = 0;
  const points: ContourPoint[] = [];
  let visible = 0;
  let cutN = 0;
  let contactN = 0;
  let occN = 0;
  for (let k = 0; k < n; k += 1) {
    const [px, py] = sampled[k];
    const di = Math.min(m - 1, Math.round(k * step));
    const t = theta[di];
    const cut = px <= borderMargin || px >= w - 1 - borderMargin
      || py <= borderMargin || py >= h - 1 - borderMargin
      || (mask.frameX + px * mask.scale) <= 0.5
      || (mask.frameX + (px + 1) * mask.scale) >= mask.frameWidth - 0.5
      || (mask.frameY + py * mask.scale) <= 0.5
      || (mask.frameY + (py + 1) * mask.scale) >= mask.frameHeight - 0.5;
    const contact = !cut && nearAny(mask.otherMask, w, h, px, py, contactR);
    const occluded = !cut && nearAny(mask.occluderMask, w, h, px, py, contactR);
    const vis = !cut && !contact && !occluded;
    if (vis) visible += 1;
    if (cut) cutN += 1;
    if (contact) contactN += 1;
    if (occluded) occN += 1;
    const u = (px - cx) / bh;
    const v = (py - cy) / bh;
    const rad = Math.hypot(u, v);
    if (rad > maxProtrusion) maxProtrusion = rad;
    points.push({
      x: mask.frameX + px * mask.scale,
      y: mask.frameY + py * mask.scale,
      u,
      v,
      sin: Math.sin(t),
      cos: Math.cos(t),
      curvature: kappa[di],
      visible: vis,
      cut,
      contact,
      occluded,
      region: regionOf((py - minY) / bh),
      side: px < cx ? 'left' : 'right',
    });
  }

  const s = mask.scale;
  const visibleRatio = visible / n;
  const cutRatio = cutN / n;
  return {
    family: CONTOUR_FEATURE_FAMILY,
    version: CONTOUR_FEATURE_VERSION,
    identityClaim: false,
    sampleCount: n,
    points,
    global: {
      width: bw * s,
      height: bh * s,
      aspect: bh / bw,
      area: area * s * s,
      extent: area / (bw * bh),
      normPerimeter: perimeterPx / Math.sqrt(area),
      centroidX: mask.frameX + (cx + 0.5) * s,
      centroidY: mask.frameY + (cy + 0.5) * s,
      solidity,
      bandWidths,
      widthProfile: profile,
      asymmetry: asymN ? asymSum / asymN : 0,
      completeness: 1 - cutRatio,
      visibleRatio,
      cutRatio,
      contactRatio: contactN / n,
      occludedRatio: occN / n,
    },
    stats: {
      componentCount,
      keptArea: area,
      removedArea,
      boundaryLength: rawLen,
      maxProtrusion,
    },
    segConfidence: mask.segConfidence ?? null,
  };
}

/**
 * HSV 보조용 crop. 마스크를 안쪽으로 erode 한 화소만 alpha 로 남긴다 —
 * 배경 섞임을 줄이기 위해서다. 원본 화소는 RAM 에서만 쓰고 저장하지 않는다.
 * 돌려주는 RGBA 는 describeHsvAux(rgba, w, h, true) 에 바로 넣는다.
 */
export function erodedMaskCropRgba(
  frameRgb: Uint8Array | Uint8ClampedArray,
  frameWidth: number,
  frameHeight: number,
  mask: ContourMaskInput,
  erodeIters = 1,
): { rgba: Uint8ClampedArray; width: number; height: number; keptPixels: number } | null {
  const { width: mw, height: mh, data } = mask;
  let cur = data.slice(0, mw * mh);
  for (let it = 0; it < erodeIters; it += 1) {
    const next = new Uint8Array(mw * mh);
    for (let y = 1; y < mh - 1; y += 1) {
      for (let x = 1; x < mw - 1; x += 1) {
        const i = y * mw + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - mw] && cur[i + mw]) next[i] = 1;
      }
    }
    cur = next;
  }
  let minX = mw;
  let minY = mh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mh; y += 1) {
    for (let x = 0; x < mw; x += 1) {
      if (!cur[y * mw + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const s = mask.scale;
  const fx0 = Math.max(0, Math.floor(mask.frameX + minX * s));
  const fy0 = Math.max(0, Math.floor(mask.frameY + minY * s));
  const fx1 = Math.min(frameWidth, Math.ceil(mask.frameX + (maxX + 1) * s));
  const fy1 = Math.min(frameHeight, Math.ceil(mask.frameY + (maxY + 1) * s));
  const w = fx1 - fx0;
  const h = fy1 - fy0;
  if (w < 4 || h < 8) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  let kept = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const fx = fx0 + x;
      const fy = fy0 + y;
      const mx = Math.floor((fx - mask.frameX) / s);
      const my = Math.floor((fy - mask.frameY) / s);
      const on = mx >= 0 && my >= 0 && mx < mw && my < mh && cur[my * mw + mx] === 1;
      const si = (fy * frameWidth + fx) * 3;
      const di = (y * w + x) * 4;
      rgba[di] = frameRgb[si];
      rgba[di + 1] = frameRgb[si + 1];
      rgba[di + 2] = frameRgb[si + 2];
      rgba[di + 3] = on ? 255 : 0;
      if (on) kept += 1;
    }
  }
  return { rgba, width: w, height: h, keptPixels: kept };
}

/* ---------- 10: 고정 길이 벡터 ---------- */

/** 지역 특징 6개 × N + 전역 특징. 신원 embedding 과 이어 붙이지 않는다. */
export const CONTOUR_LOCAL_DIMS = 6;
export const CONTOUR_GLOBAL_DIMS = 14 + WIDTH_PROFILE_ROWS * 2;

export function contourVectorLength(sampleCount: number): number {
  return sampleCount * CONTOUR_LOCAL_DIMS + CONTOUR_GLOBAL_DIMS;
}

export interface ContourVector {
  family: typeof CONTOUR_FEATURE_FAMILY;
  identityClaim: false;
  contourVector: Float32Array;
}

export function contourFeatureVector(f: ContourFeature): ContourVector {
  const out = new Float32Array(contourVectorLength(f.sampleCount));
  let o = 0;
  for (const p of f.points) {
    out[o++] = p.u;
    out[o++] = p.v;
    out[o++] = p.sin;
    out[o++] = p.cos;
    out[o++] = p.curvature;
    out[o++] = p.visible ? 1 : 0;
  }
  const g = f.global;
  const globals = [
    g.width, g.height, g.aspect, g.area, g.extent, g.normPerimeter,
    g.centroidX, g.centroidY, g.solidity,
    g.bandWidths[0], g.bandWidths[1], g.bandWidths[2], g.asymmetry, g.visibleRatio,
  ];
  for (const v of globals) out[o++] = v;
  for (let i = 0; i < g.widthProfile.length; i += 1) {
    const v = g.widthProfile[i];
    out[o++] = Number.isFinite(v) ? v : -1;
  }
  return { family: CONTOUR_FEATURE_FAMILY, identityClaim: false, contourVector: out };
}

/**
 * 외곽선과 다른 가족의 벡터를 한 벡터로 합치려는 시도를 막는다.
 * 이어 붙이는 코드를 쓰지 말라는 규칙을 코드로도 남겨 둔다.
 */
export function refuseCrossFamilyConcat(a: { family?: string }, b: { family?: string }): never {
  throw new Error(`contour-feature: ${a.family ?? '?'} 와 ${b.family ?? '?'} 를 한 벡터로 합치지 않는다 (후단 점수 결합만 허용)`);
}

/* ---------- 5장: 종목별 부분 가중치 ---------- */

export interface ContourRegionWeights {
  upper: number;
  torso: number;
  lower: number;
  /** 곡률 가중 배율 (팔다리 자세 변화가 큰 종목은 낮춘다) */
  curvatureScale: number;
}

export const SPORT_CONTOUR_WEIGHTS: Readonly<Record<ContourSport, ContourRegionWeights>> = Object.freeze({
  // 달리기: 몸통·어깨가 믿을 만하고 팔다리는 보폭마다 바뀐다
  running: { upper: 1, torso: 1, lower: 0.35, curvatureScale: 0.5 },
  // 사이클: 사람+자전거가 한 마스크일 수 있다. 바퀴·프레임 반복 구조가 유사도를 부풀리지 않게 하단을 낮춘다
  cycling: { upper: 1, torso: 0.8, lower: 0.2, curvatureScale: 0.4 },
  // 스케이팅: 상체 폭·몸통 기울기 위주, 다리 곡률은 낮게
  skating: { upper: 1, torso: 1, lower: 0.3, curvatureScale: 0.4 },
  generic: { upper: 1, torso: 1, lower: 0.6, curvatureScale: 0.7 },
});

/* ---------- 6장: 마스크 품질 ---------- */

export interface MaskQualityInput {
  detConfidence: number;
  /** 탐지 상자 (화면 좌표) */
  box: { x: number; y: number; width: number; height: number };
  /** 이전 신뢰 외곽선 (시간 안정성) */
  previous?: ContourFeature | null;
  /** 0 = 선명, 1 = 심한 흐림. 모르면 0 */
  blur?: number;
  minObjectSize?: number;
}

export interface MaskQuality {
  quality: number;
  sizeReliability: number;
  temporalStability: number;
  occlusionReliability: number;
  factors: Record<string, number>;
  /** 이 사유가 하나라도 있으면 외곽선 점수를 쓰지 않는다 */
  blockers: string[];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function computeMaskQuality(f: ContourFeature, input: MaskQualityInput): MaskQuality {
  const g = f.global;
  const minSize = input.minObjectSize ?? 32;
  const blockers: string[] = [];
  const factors: Record<string, number> = {};

  factors.detConfidence = clamp01((input.detConfidence - 0.15) / 0.5);
  factors.segConfidence = f.segConfidence == null ? 0.8 : clamp01((f.segConfidence - 0.3) / 0.5);
  const sizeRel = clamp01((g.height - minSize * 0.5) / (minSize * 0.75));
  factors.size = sizeRel;
  factors.extent = g.extent < 0.12 ? 0 : g.extent < 0.28 ? (g.extent - 0.12) / 0.16
    : g.extent > 0.97 ? 0.2 : 1;
  const boxArea = Math.max(1, input.box.width * input.box.height);
  const areaToBox = g.area / boxArea;
  // 마스크가 상자보다 훨씬 크면 여러 사람이 합쳐졌을 가능성이 크다
  factors.merge = areaToBox > 1.35 ? clamp01(1 - (areaToBox - 1.35) * 2)
    : g.width > input.box.width * 1.5 ? 0.3 : 1;
  factors.partial = areaToBox < 0.18 ? clamp01(areaToBox / 0.18) : 1;
  factors.cut = clamp01(1 - g.cutRatio * 1.6);
  factors.contact = clamp01(1 - g.contactRatio * 1.8);
  factors.occlusion = clamp01(1 - g.occludedRatio * 1.6);
  factors.components = f.stats.componentCount <= 1 ? 1 : f.stats.componentCount === 2 ? 0.75 : 0.5;
  factors.protrusion = f.stats.maxProtrusion > 0.95 ? 0.5 : 1;
  factors.solidity = g.solidity < 0.45 ? clamp01(g.solidity / 0.45) : 1;
  factors.blur = clamp01(1 - (input.blur ?? 0));
  const bcx = input.box.x + input.box.width / 2;
  const bcy = input.box.y + input.box.height / 2;
  const centerOff = Math.hypot(g.centroidX - bcx, g.centroidY - bcy) / Math.max(1, input.box.height);
  factors.center = Math.exp(-Math.max(0, centerOff - 0.08) / 0.15);

  let temporal = 1;
  if (input.previous) {
    const pa = input.previous.global.area;
    const areaJump = Math.abs(Math.log(Math.max(1, g.area) / Math.max(1, pa)));
    const aspectJump = Math.abs(Math.log(g.aspect / Math.max(1e-6, input.previous.global.aspect)));
    temporal = Math.exp(-Math.max(0, areaJump - 0.08) / 0.35) * Math.exp(-Math.max(0, aspectJump - 0.08) / 0.4);
  }
  factors.temporal = temporal;
  const occRel = clamp01(1 - (g.occludedRatio + g.contactRatio) * 1.4);

  if (g.height < minSize * 0.5) blockers.push('too-small');
  if (g.cutRatio > 0.45) blockers.push('mostly-cut');
  if (factors.merge < 0.35) blockers.push('merged-mask');
  if (factors.partial < 0.5) blockers.push('partial-mask');
  if ((input.blur ?? 0) > 0.7) blockers.push('motion-blur');
  if (f.segConfidence != null && f.segConfidence < 0.35) blockers.push('seg-confidence-low');

  const keys = ['detConfidence', 'segConfidence', 'extent', 'merge', 'partial', 'cut', 'contact',
    'occlusion', 'components', 'protrusion', 'solidity', 'blur', 'center', 'size'];
  // 기하 평균 — 한 요인이 0 이면 품질도 0 에 가깝다
  let logSum = 0;
  for (const k of keys) logSum += Math.log(Math.max(1e-3, factors[k]));
  const quality = Math.exp(logSum / keys.length) * Math.sqrt(temporal);
  return {
    quality: clamp01(quality),
    sizeReliability: sizeRel,
    temporalStability: temporal,
    occlusionReliability: occRel,
    factors,
    blockers,
  };
}

/** 외곽선 점수의 신뢰도. 식의 결합 방식은 검증 자료로 다시 맞춘다 — 기본값 확정 아님. */
export function contourReliability(f: ContourFeature, q: MaskQuality): number {
  if (q.blockers.length) return 0;
  return clamp01(q.quality * f.global.visibleRatio * q.sizeReliability
    * Math.sqrt(q.temporalStability) * q.occlusionReliability);
}

/* ---------- 7장: 외곽선 거리 ---------- */

export interface ContourDistanceWeights {
  position: number;
  orientation: number;
  curvature: number;
  widthProfile: number;
  global: number;
}

export const CONTOUR_DISTANCE_WEIGHTS: Readonly<ContourDistanceWeights> = Object.freeze({
  position: 0.4,
  orientation: 0.2,
  curvature: 0.05,
  widthProfile: 0.2,
  global: 0.15,
});

export interface ContourDistanceOptions {
  method?: ContourDistanceMethod;
  trimFraction?: number;
  sport?: ContourSport;
  weights?: Partial<ContourDistanceWeights>;
  /** 작은 객체·빠른 자세 변화면 곡률을 끈다 */
  disableCurvature?: boolean;
}

export interface ContourDistance {
  total: number;
  position: number;
  orientation: number;
  curvature: number;
  widthProfile: number;
  global: number;
  /** 비교에 쓰인 점 비율 (가려진 점은 분모에서 뺀다) */
  usedRatio: number;
  score: number;
  method: ContourDistanceMethod;
}

interface Match {
  d: number;
  w: number;
  dAng: number;
  dCurv: number;
}

function directed(a: ContourFeature, b: ContourFeature, rw: ContourRegionWeights): Match[] {
  const out: Match[] = [];
  for (const p of a.points) {
    if (!p.visible) continue;
    let bestD = Infinity;
    let bq: ContourPoint | null = null;
    for (const q of b.points) {
      const d = (p.u - q.u) ** 2 + (p.v - q.v) ** 2;
      if (d < bestD) {
        bestD = d;
        bq = q;
      }
    }
    // 대응점이 상대 쪽에서 가려져 있으면 불일치로 치지 않는다
    if (!bq || !bq.visible) continue;
    const w = rw[p.region];
    if (w <= 0) continue;
    const cosD = p.cos * bq.cos + p.sin * bq.sin;
    out.push({
      d: Math.sqrt(bestD),
      w,
      dAng: (1 - cosD) / 2,
      dCurv: Math.min(1, Math.abs(p.curvature - bq.curvature) / 6),
    });
  }
  return out;
}

function weightedMean(rows: Match[], pick: (m: Match) => number): number {
  let s = 0;
  let ws = 0;
  for (const r of rows) {
    s += pick(r) * r.w;
    ws += r.w;
  }
  return ws > 0 ? s / ws : Number.NaN;
}

function weightedPercentile(rows: Match[], p: number): number {
  if (!rows.length) return Number.NaN;
  const sorted = rows.slice().sort((x, y) => x.d - y.d);
  let total = 0;
  for (const r of sorted) total += r.w;
  let acc = 0;
  for (const r of sorted) {
    acc += r.w;
    if (acc >= total * p) return r.d;
  }
  return sorted[sorted.length - 1].d;
}

function trimmed(rows: Match[], frac: number): Match[] {
  if (rows.length < 4 || frac <= 0) return rows;
  const sorted = rows.slice().sort((x, y) => x.d - y.d);
  const keep = Math.max(1, Math.floor(sorted.length * (1 - frac)));
  return sorted.slice(0, keep);
}

/**
 * 가림·잘림·접촉이 있으면 중심과 키를 보이는 화소로만 재므로 정규화 좌표가 어긋난다.
 * 그때만 보이는 점끼리 평행이동·크기(회전 없음)를 맞춘다. 극단값 20% 는 빼고 3번 반복한다.
 * 크기는 0.7~1.4 로 묶는다 — 다른 사람 모양까지 억지로 맞추지 않게 하려는 것이다.
 */
export const ALIGN_PARTIAL_THRESHOLD = 0.05;

function partialRatio(f: ContourFeature): number {
  const g = f.global;
  return g.occludedRatio + g.contactRatio + g.cutRatio;
}

function alignVisible(a: ContourFeature, b: ContourFeature): ContourFeature {
  const pa = a.points.filter((p) => p.visible);
  const pb = b.points.filter((p) => p.visible);
  if (pa.length < 6 || pb.length < 6) return a;
  let s = 1;
  let tx = 0;
  let ty = 0;
  for (let it = 0; it < 3; it += 1) {
    const pairs: Array<{ x: number; y: number; qx: number; qy: number; d: number }> = [];
    for (const p of pa) {
      const x = s * p.u + tx;
      const y = s * p.v + ty;
      let best = Infinity;
      let bq = pb[0];
      for (const q of pb) {
        const d = (x - q.u) ** 2 + (y - q.v) ** 2;
        if (d < best) {
          best = d;
          bq = q;
        }
      }
      pairs.push({ x: p.u, y: p.v, qx: bq.u, qy: bq.v, d: best });
    }
    pairs.sort((m, n) => m.d - n.d);
    const kept = pairs.slice(0, Math.max(4, Math.floor(pairs.length * 0.8)));
    let mx = 0;
    let my = 0;
    let mqx = 0;
    let mqy = 0;
    for (const k of kept) {
      mx += k.x;
      my += k.y;
      mqx += k.qx;
      mqy += k.qy;
    }
    mx /= kept.length;
    my /= kept.length;
    mqx /= kept.length;
    mqy /= kept.length;
    let num = 0;
    let den = 0;
    for (const k of kept) {
      num += (k.x - mx) * (k.qx - mqx) + (k.y - my) * (k.qy - mqy);
      den += (k.x - mx) ** 2 + (k.y - my) ** 2;
    }
    s = den > 1e-9 ? Math.min(1.4, Math.max(0.7, num / den)) : 1;
    tx = mqx - s * mx;
    ty = mqy - s * my;
  }
  return { ...a, points: a.points.map((p) => ({ ...p, u: s * p.u + tx, v: s * p.v + ty })) };
}

/** 외곽선 거리 → 점수. τ 는 합성 검증 자료로 고른 값이 아니라 시작값이다. */
export const CONTOUR_SCORE_TAU = 0.09;

export function contourDistance(a0: ContourFeature, b: ContourFeature, opts: ContourDistanceOptions = {}): ContourDistance {
  const method = opts.method ?? 'trimmed-chamfer';
  const a = partialRatio(a0) > ALIGN_PARTIAL_THRESHOLD || partialRatio(b) > ALIGN_PARTIAL_THRESHOLD
    ? alignVisible(a0, b)
    : a0;
  const rw0 = SPORT_CONTOUR_WEIGHTS[opts.sport ?? 'generic'];
  const rw: ContourRegionWeights = { ...rw0 };
  const w: ContourDistanceWeights = { ...CONTOUR_DISTANCE_WEIGHTS, ...(opts.weights ?? {}) };
  if (opts.disableCurvature) w.curvature = 0;
  else w.curvature *= rw.curvatureScale / 0.5;

  const ab = directed(a, b, rw);
  const ba = directed(b, a, rw);
  const usedRatio = Math.min(ab.length / a.points.length, ba.length / b.points.length);
  const empty: ContourDistance = {
    total: Number.NaN, position: Number.NaN, orientation: Number.NaN, curvature: Number.NaN,
    widthProfile: Number.NaN, global: Number.NaN, usedRatio, score: Number.NaN, method,
  };
  if (ab.length < 4 || ba.length < 4) return empty;

  const trim = opts.trimFraction ?? 0.15;
  let position: number;
  let setA = ab;
  let setB = ba;
  if (method === 'symmetric-chamfer') {
    position = (weightedMean(ab, (m) => m.d) + weightedMean(ba, (m) => m.d)) / 2;
  } else if (method === 'trimmed-chamfer') {
    setA = trimmed(ab, trim);
    setB = trimmed(ba, trim);
    position = (weightedMean(setA, (m) => m.d) + weightedMean(setB, (m) => m.d)) / 2;
  } else {
    const p = method === 'hausdorff-p90' ? 0.9 : 0.95;
    position = Math.max(weightedPercentile(ab, p), weightedPercentile(ba, p));
  }
  const orientation = (weightedMean(setA, (m) => m.dAng) + weightedMean(setB, (m) => m.dAng)) / 2;
  const curvature = (weightedMean(setA, (m) => m.dCurv) + weightedMean(setB, (m) => m.dCurv)) / 2;

  // 높이별 폭 — 두 쪽 다 보이는 행만. 하단은 종목 가중을 따른다
  let wp = 0;
  let wpW = 0;
  for (let r = 0; r < WIDTH_PROFILE_ROWS; r += 1) {
    const vFrac = (r + 0.5) / WIDTH_PROFILE_ROWS;
    const regW = rw[regionOf(vFrac)];
    for (let s = 0; s < 2; s += 1) {
      const x = a.global.widthProfile[2 * r + s];
      const y = b.global.widthProfile[2 * r + s];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      wp += Math.abs(x - y) * regW;
      wpW += regW;
    }
  }
  const widthProfile = wpW > 0 ? wp / wpW : 0;

  const ga = a.global;
  const gb = b.global;
  const lr = (x: number, y: number) => Math.abs(Math.log(Math.max(1e-6, x) / Math.max(1e-6, y)));
  const global = (
    lr(ga.aspect, gb.aspect) * 0.3
    + lr(ga.extent, gb.extent) * 0.2
    + lr(ga.solidity, gb.solidity) * 0.2
    + lr(ga.normPerimeter, gb.normPerimeter) * 0.2
    + Math.abs(ga.bandWidths[0] - gb.bandWidths[0]) * 0.1
  );

  const wsum = w.position + w.orientation + w.curvature + w.widthProfile + w.global;
  // 항목 단위를 대략 맞춘다: 위치는 키 비율, 방향은 0~1, 곡률 0~1, 폭 키 비율, 전역 log 비
  const total = (
    w.position * position
    + w.orientation * orientation * 0.35
    + w.curvature * curvature * 0.4
    + w.widthProfile * widthProfile
    + w.global * global * 0.5
  ) / wsum;
  return {
    total,
    position,
    orientation,
    curvature,
    widthProfile,
    global,
    usedRatio,
    score: Math.exp(-total / CONTOUR_SCORE_TAU),
    method,
  };
}
