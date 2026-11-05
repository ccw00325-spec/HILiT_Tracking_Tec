// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 가혹 조건을 그려 내는 합성 장면. 가중치와 영상 없이 추적 동작을 재현하려고 만들었다.
// 사람을 단순한 도형으로 그리므로, 여기서 나온 수치를 실사 정확도로 쓰면 안 된다.

export const SCENARIOS = {
  baseline: '기본: 대상이 혼자 걷고 다른 사람은 멀리 있음',
  crowd_occlusion: '군중 가림: 대상이 다른 사람들 뒤를 지나가 잠시 완전히 가려짐',
  same_uniform_crossing: '같은 유니폼 교차: 같은 옷의 두 사람이 겹쳤다 갈라짐',
  light_jump: '조명 급변: 장면 밝기와 색이 갑자기 바뀌었다 돌아옴',
  shake_blur: '흔들림: 카메라가 크게 떨리고 움직임이 번짐',
  reentry: '화면 밖 재등장: 대상이 나갔다 돌아오고 같은 옷의 사람이 화면에 있음',
  dense_crowd: '밀집 군중: 여러 사람이 오가며 대상이 부분·완전 가림을 반복',
};

const PALETTE = [
  [[210, 50, 50], [30, 30, 90]],
  [[40, 120, 220], [40, 40, 40]],
  [[240, 200, 40], [70, 50, 30]],
  [[60, 170, 90], [220, 220, 220]],
  [[160, 70, 190], [40, 70, 60]],
  [[240, 130, 40], [50, 50, 70]],
  [[230, 230, 230], [120, 30, 30]],
];

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, u) => a + (b - a) * u;
const person = (id, colors, path, h, z, pattern = 0) => ({ id, colors, path, h, z, pattern });
/** path: [[시각, x중심, y발끝], ...]. 범위 밖 시각은 화면 밖으로 처리하려면 path 에 화면 밖 좌표를 넣는다. */
function at(path, t) {
  if (t <= path[0][0]) return { x: path[0][1], y: path[0][2] };
  for (let i = 1; i < path.length; i += 1) {
    if (t <= path[i][0]) {
      const u = (t - path[i - 1][0]) / (path[i][0] - path[i - 1][0]);
      return { x: lerp(path[i - 1][1], path[i][1], u), y: lerp(path[i - 1][2], path[i][2], u) };
    }
  }
  const last = path[path.length - 1];
  return { x: last[1], y: last[2] };
}

export function buildScene(name, { width = 480, height = 270, seconds = 8, seed = 1 } = {}) {
  if (!SCENARIOS[name]) throw new Error(`없는 장면입니다: ${name}`);
  const rand = mulberry(seed * 7919 + name.length);
  const W = width, H = height, S = seconds;
  const foot = H * 0.82;
  const h = H * 0.42;
  const wob = () => (rand() - 0.5) * W * 0.04;
  const people = [];
  let light = () => ({ gain: 1, tint: [1, 1, 1] });
  let shake = () => ({ dx: 0, dy: 0 });
  let blur = 0;
  const T = PALETTE[0];
  switch (name) {
    case 'baseline':
      people.push(person('target', T, [[0, W * 0.2, foot], [S, W * 0.75 + wob(), foot]], h, 2));
      people.push(person('a', PALETTE[1], [[0, W * 0.9, foot - 18], [S, W * 0.82, foot - 18]], h * 0.9, 1));
      break;
    case 'crowd_occlusion':
      people.push(person('target', T, [[0, W * 0.12, foot], [S, W * 0.88 + wob(), foot]], h, 1));
      people.push(person('a', PALETTE[1], [[0, W * 0.45, foot + 8], [S, W * 0.47, foot + 8]], h * 1.15, 3));
      people.push(person('b', PALETTE[2], [[0, W * 0.52, foot + 10], [S, W * 0.51, foot + 10]], h * 1.15, 4));
      people.push(person('c', PALETTE[3], [[0, W * 0.8, foot - 10], [S, W * 0.7, foot - 10]], h * 0.9, 0));
      break;
    case 'same_uniform_crossing':
      people.push(person('target', T, [[0, W * 0.2, foot], [S, W * 0.8 + wob(), foot]], h, 1));
      people.push(person('twin', T, [[0, W * 0.8, foot + 4], [S, W * 0.2 + wob(), foot + 4]], h * 1.02, 2));
      people.push(person('a', PALETTE[3], [[0, W * 0.92, foot - 16], [S, W * 0.9, foot - 16]], h * 0.85, 0));
      break;
    case 'light_jump':
      people.push(person('target', T, [[0, W * 0.2, foot], [S, W * 0.72 + wob(), foot]], h, 2));
      people.push(person('a', PALETTE[1], [[0, W * 0.85, foot - 8], [S, W * 0.62, foot - 8]], h * 0.95, 1));
      light = (t) => (t >= S * 0.35 && t < S * 0.6 ? { gain: 0.32, tint: [0.75, 0.85, 1.25] } : { gain: 1, tint: [1, 1, 1] });
      break;
    case 'shake_blur':
      people.push(person('target', T, [[0, W * 0.25, foot], [S, W * 0.7 + wob(), foot]], h, 2));
      people.push(person('a', PALETTE[2], [[0, W * 0.8, foot - 8], [S, W * 0.86, foot - 8]], h * 0.92, 1));
      shake = (t) => ({ dx: Math.round(Math.sin(t * 19) * W * 0.035), dy: Math.round(Math.cos(t * 23) * H * 0.03) });
      blur = 4;
      break;
    case 'reentry':
      people.push(person('target', T, [[0, W * 0.5, foot], [S * 0.33, W * 1.14, foot], [S * 0.62, W * 1.14, foot], [S, W * 0.68 + wob(), foot]], h, 2));
      people.push(person('twin', T, [[0, W * 0.16, foot - 6], [S, W * 0.3, foot - 6]], h * 0.98, 1));
      break;
    case 'dense_crowd':
      people.push(person('target', T, [[0, W * 0.1, foot], [S * 0.5, W * 0.55, foot - 6], [S, W * 0.9 + wob(), foot]], h, 2));
      for (let i = 1; i < 7; i += 1) {
        const dir = i % 2 ? 1 : -1;
        const x0 = W * (0.15 + rand() * 0.7);
        const z = i % 3 === 0 ? 0 : 3 + i;
        people.push(person(`p${i}`, PALETTE[i], [[0, x0, foot + (z > 2 ? 8 : -8)], [S, x0 + dir * W * (0.15 + rand() * 0.2), foot + (z > 2 ? 8 : -8)]], h * (0.9 + rand() * 0.25), z, i));
      }
      break;
    default:
  }
  return { name, width: W, height: H, seconds: S, seed, people, light, shake, blur, noiseSeed: seed * 131 };
}

function boxOf(p, t) {
  const c = at(p.path, t);
  const w = p.h * 0.36;
  return { x: c.x - w / 2, y: c.y - p.h, width: w, height: p.h };
}

function clip(b, W, H) {
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(W, b.x + b.width), y1 = Math.min(H, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 시각 t 의 정답. 사람마다 화면 좌표 상자와 보이는 비율. 앞사람에 가린 부분과 화면 밖 부분을 뺀다. */
export function truthAt(scene, t) {
  const { dx, dy } = scene.shake(t);
  const list = scene.people.map((p) => {
    const raw = boxOf(p, t);
    const moved = { ...raw, x: raw.x + dx, y: raw.y + dy };
    return { id: p.id, z: p.z, full: moved, box: clip(moved, scene.width, scene.height), area: moved.width * moved.height };
  });
  for (const a of list) {
    if (!a.box) { a.visible = 0; continue; }
    let hidden = 0;
    for (const b of list) if (b !== a && b.box && b.z > a.z) hidden += overlapArea(a.box, b.box);
    a.visible = Math.max(0, (a.box.width * a.box.height - Math.min(hidden, a.box.width * a.box.height)) / a.area);
  }
  return list;
}

export function renderFrame(scene, t) {
  const { width: W, height: H } = scene;
  const data = new Uint8ClampedArray(W * H * 4);
  const { gain, tint } = scene.light(t);
  const { dx, dy } = scene.shake(t);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const bx = x - dx, by = y - dy;
      const ground = by > H * 0.6;
      const tile = ((Math.floor(bx / 24) + Math.floor(by / 24)) & 1) * 10;
      const grain = ((bx * 73 + by * 151) % 17) - 8;
      const p = (y * W + x) * 4;
      data[p] = ((ground ? 70 : 95) + tile + grain) * gain * tint[0];
      data[p + 1] = ((ground ? 105 : 110) + tile + grain) * gain * tint[1];
      data[p + 2] = ((ground ? 70 : 130) + tile + grain) * gain * tint[2];
      data[p + 3] = 255;
    }
  }
  const order = [...scene.people].sort((a, b) => a.z - b.z);
  for (const person2 of order) {
    const b = boxOf(person2, t);
    const x0 = Math.max(0, Math.round(b.x + dx)), x1 = Math.min(W, Math.round(b.x + b.width + dx));
    const y0 = Math.max(0, Math.round(b.y + dy)), y1 = Math.min(H, Math.round(b.y + b.height + dy));
    const midY = b.y + dy + b.height * 0.58;
    const headY = b.y + dy + b.height * 0.17;
    const [shirt, pants] = person2.colors;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const u = (x - (b.x + dx)) / b.width;
        const isHead = y < headY;
        if (isHead && Math.abs(u - 0.5) > 0.24) continue;
        if (!isHead && y >= midY && Math.abs(u - 0.5) < 0.05) continue;
        const color = isHead ? [225, 185, 155] : y < midY ? shirt : pants;
        const stripe = person2.pattern && !isHead && y < midY && Math.floor((y - y0) / 5) % (person2.pattern + 1) === 0 ? 0.7 : 1;
        const shade = 0.82 + 0.18 * Math.sin(u * Math.PI);
        const p = (y * W + x) * 4;
        data[p] = color[0] * shade * stripe * gain * tint[0];
        data[p + 1] = color[1] * shade * stripe * gain * tint[1];
        data[p + 2] = color[2] * shade * stripe * gain * tint[2];
      }
    }
  }
  if (scene.blur > 0) horizontalBlur(data, W, H, scene.blur);
  return { data, width: W, height: H, ox: 0, oy: 0, frameWidth: W, frameHeight: H };
}

function horizontalBlur(data, W, H, radius) {
  const row = new Float32Array(W * 3);
  for (let y = 0; y < H; y += 1) {
    const base = y * W * 4;
    for (let x = 0; x < W; x += 1) for (let c = 0; c < 3; c += 1) row[x * 3 + c] = data[base + x * 4 + c];
    for (let x = 0; x < W; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        let s = 0, n = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const q = x + k;
          if (q >= 0 && q < W) { s += row[q * 3 + c]; n += 1; }
        }
        data[base + x * 4 + c] = s / n;
      }
    }
  }
}

/** 검출기를 흉내 낸다. 많이 가려졌거나 화면 밖이면 나오지 않고, 위치 오차와 놓침을 일정하게 넣는다. */
export function detectionsAt(scene, t, { missRate = 0.05, jitter = 0.02, minVisible = 0.45 } = {}) {
  const rand = mulberry(Math.round(t * 1000) * 31 + scene.seed * 97 + scene.name.length);
  const out = [];
  for (const p of truthAt(scene, t)) {
    if (!p.box || p.visible < minVisible) continue;
    if (rand() < missRate) continue;
    const j = () => (rand() - 0.5) * 2 * jitter * p.box.height;
    out.push({
      x: p.box.x + j(), y: p.box.y + j(), width: Math.max(4, p.box.width + j()), height: Math.max(8, p.box.height + j()),
      score: 0.55 + rand() * 0.4,
    });
  }
  return out;
}
