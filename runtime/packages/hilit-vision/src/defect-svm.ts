/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·a1ffb35a @license @preserve */
/* 결함별 이진 분류기. 외부 라이브러리·사전학습 모델 없이 이 파일 안에서 학습한다.

모바일 기본안은 선형 SVM 이다: 추론이 표준화 + 내적 한 번이라 의존성이 없다.
비교용으로 로지스틱 회귀, 단일 특징 규칙, RBF SVM(품질 상한 확인용)을 둔다.

결정 점수는 확률이 아니다. 확률로 쓰려면 검증 세트에서 Platt 보정을 한다.
*/

export interface Scaler {
  mean: number[];
  std: number[];
}

/** train 행으로만 평균·표준편차를 잰다. NaN 은 건너뛴다. */
export function fitScaler(rows: ReadonlyArray<ArrayLike<number>>, dim: number): Scaler {
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(1);
  for (let j = 0; j < dim; j += 1) {
    let s = 0;
    let n = 0;
    for (const r of rows) if (Number.isFinite(r[j])) {
      s += r[j];
      n += 1;
    }
    const m = n ? s / n : 0;
    let v = 0;
    for (const r of rows) if (Number.isFinite(r[j])) v += (r[j] - m) ** 2;
    mean[j] = m;
    std[j] = n > 1 && v > 1e-18 ? Math.sqrt(v / (n - 1)) : 1;
  }
  return { mean, std };
}

/** 표준화. 결측(NaN)은 평균 = 0 으로 채우고, 극단값은 ±6 으로 자른다. */
export function applyScaler(x: ArrayLike<number>, s: Scaler): Float64Array {
  const out = new Float64Array(s.mean.length);
  for (let j = 0; j < out.length; j += 1) {
    const v = x[j];
    const z = Number.isFinite(v) ? (v - s.mean[j]) / s.std[j] : 0;
    out[j] = Math.max(-6, Math.min(6, z));
  }
  return out;
}

export function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LinearModel {
  kind: 'linear-svm' | 'logistic';
  w: number[];
  b: number;
}

/**
 * L2 정규화 · hinge loss 선형 SVM. 쌍대 좌표 하강(liblinear 방식).
 * cPos/cNeg 로 클래스 가중을 준다. 편향은 상수 특징 1 로 붙여 함께 푼다.
 */
export function trainLinearSvm(X: ReadonlyArray<Float64Array>, y: ReadonlyArray<number>, opts: {
  c?: number; classWeight?: 'balanced' | 'none'; epochs?: number; seed?: number;
} = {}): LinearModel {
  const n = X.length;
  const d = n ? X[0].length : 0;
  const C = opts.c ?? 0.5;
  let pos = 0;
  for (const v of y) if (v > 0) pos += 1;
  const neg = n - pos;
  const balanced = opts.classWeight === 'balanced' && pos > 0 && neg > 0;
  const cPos = balanced ? C * n / (2 * pos) : C;
  const cNeg = balanced ? C * n / (2 * neg) : C;
  const w = new Float64Array(d + 1);
  const alpha = new Float64Array(n);
  const qd = X.map((x) => x.reduce((s, v) => s + v * v, 0) + 1);
  const order = Array.from({ length: n }, (_, i) => i);
  const rng = makeRng(opts.seed ?? 1);
  const epochs = opts.epochs ?? 30;
  for (let ep = 0; ep < epochs; ep += 1) {
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let maxPg = 0;
    for (const i of order) {
      const yi = y[i] > 0 ? 1 : -1;
      const x = X[i];
      let g = w[d];
      for (let k = 0; k < d; k += 1) g += w[k] * x[k];
      g = yi * g - 1;
      const U = yi > 0 ? cPos : cNeg;
      let pg = g;
      if (alpha[i] === 0) pg = Math.min(g, 0);
      else if (alpha[i] === U) pg = Math.max(g, 0);
      maxPg = Math.max(maxPg, Math.abs(pg));
      if (Math.abs(pg) < 1e-12) continue;
      const old = alpha[i];
      alpha[i] = Math.min(Math.max(old - g / qd[i], 0), U);
      const delta = (alpha[i] - old) * yi;
      if (delta === 0) continue;
      for (let k = 0; k < d; k += 1) w[k] += delta * x[k];
      w[d] += delta;
    }
    if (maxPg < 1e-3) break;
  }
  return { kind: 'linear-svm', w: Array.from(w.subarray(0, d)), b: w[d] };
}

/** L2 로지스틱 회귀. 전체 배치 경사 하강(작은 데이터용). */
export function trainLogistic(X: ReadonlyArray<Float64Array>, y: ReadonlyArray<number>, opts: {
  l2?: number; iters?: number; lr?: number; classWeight?: 'balanced' | 'none';
} = {}): LinearModel {
  const n = X.length;
  const d = n ? X[0].length : 0;
  let pos = 0;
  for (const v of y) if (v > 0) pos += 1;
  const wPos = opts.classWeight === 'balanced' && pos > 0 ? n / (2 * pos) : 1;
  const wNeg = opts.classWeight === 'balanced' && pos < n ? n / (2 * (n - pos)) : 1;
  const w = new Float64Array(d);
  let b = 0;
  const l2 = opts.l2 ?? 1e-3;
  const lr = opts.lr ?? 0.5;
  for (let it = 0; it < (opts.iters ?? 200); it += 1) {
    const gw = new Float64Array(d);
    let gb = 0;
    let wsum = 0;
    for (let i = 0; i < n; i += 1) {
      let z = b;
      for (let k = 0; k < d; k += 1) z += w[k] * X[i][k];
      const p = 1 / (1 + Math.exp(-z));
      const t = y[i] > 0 ? 1 : 0;
      const sw = t ? wPos : wNeg;
      const e = (p - t) * sw;
      for (let k = 0; k < d; k += 1) gw[k] += e * X[i][k];
      gb += e;
      wsum += sw;
    }
    for (let k = 0; k < d; k += 1) w[k] -= lr * (gw[k] / wsum + l2 * w[k]);
    b -= lr * gb / wsum;
  }
  return { kind: 'logistic', w: Array.from(w), b };
}

export function linearScore(m: { w: ArrayLike<number>; b: number }, x: ArrayLike<number>): number {
  let s = m.b;
  for (let k = 0; k < m.w.length; k += 1) s += m.w[k] * x[k];
  return s;
}

/* ---------- Platt 보정 ---------- */

export interface Platt {
  a: number;
  b: number;
}

/** Platt(1999) + Lin 등(2007) 의 안정화 뉴턴법. 검증 세트의 점수로만 맞춘다. */
export function fitPlatt(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>): Platt {
  const n = scores.length;
  let prior1 = 0;
  for (const l of labels) if (l > 0) prior1 += 1;
  const prior0 = n - prior1;
  const hi = (prior1 + 1) / (prior1 + 2);
  const lo = 1 / (prior0 + 2);
  const t = labels.map((l) => (l > 0 ? hi : lo));
  let A = 0;
  let B = Math.log((prior0 + 1) / (prior1 + 1));
  const fval = (a: number, b: number) => {
    let f = 0;
    for (let i = 0; i < n; i += 1) {
      const fApB = scores[i] * a + b;
      f += fApB >= 0 ? t[i] * fApB + Math.log(1 + Math.exp(-fApB)) : (t[i] - 1) * fApB + Math.log(1 + Math.exp(fApB));
    }
    return f;
  };
  let f = fval(A, B);
  for (let it = 0; it < 100; it += 1) {
    let h11 = 1e-12;
    let h22 = 1e-12;
    let h21 = 0;
    let g1 = 0;
    let g2 = 0;
    for (let i = 0; i < n; i += 1) {
      const fApB = scores[i] * A + B;
      const p = fApB >= 0 ? Math.exp(-fApB) / (1 + Math.exp(-fApB)) : 1 / (1 + Math.exp(fApB));
      const q = 1 - p;
      const d2 = p * q;
      h11 += scores[i] * scores[i] * d2;
      h22 += d2;
      h21 += scores[i] * d2;
      const d1 = t[i] - p;
      g1 += scores[i] * d1;
      g2 += d1;
    }
    if (Math.abs(g1) < 1e-5 && Math.abs(g2) < 1e-5) break;
    const det = h11 * h22 - h21 * h21;
    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;
    const gd = g1 * dA + g2 * dB;
    let step = 1;
    let moved = false;
    while (step >= 1e-10) {
      const nA = A + step * dA;
      const nB = B + step * dB;
      const nf = fval(nA, nB);
      if (nf < f + 1e-4 * step * gd) {
        A = nA;
        B = nB;
        f = nf;
        moved = true;
        break;
      }
      step /= 2;
    }
    if (!moved) break;
  }
  return { a: A, b: B };
}

/** P(결함 | 점수). 보정이 없으면 null — 점수를 확률로 쓰지 않는다. */
export function plattProb(p: Platt | null, score: number): number | null {
  if (!p || !Number.isFinite(score)) return null;
  const z = p.a * score + p.b;
  return z >= 0 ? Math.exp(-z) / (1 + Math.exp(-z)) : 1 / (1 + Math.exp(z));
}

/* ---------- RBF SVM (품질 상한 확인용, 오프라인) ---------- */

export interface RbfModel {
  kind: 'rbf-svm';
  gamma: number;
  sv: Float64Array[];
  coef: number[];
  b: number;
}

/** 단순화 SMO (Platt 1998 의 간이판). 표본 수가 수백일 때만 쓴다. */
export function trainRbfSvm(X: ReadonlyArray<Float64Array>, y: ReadonlyArray<number>, opts: {
  c?: number; gamma?: number; maxPasses?: number; seed?: number; classWeight?: 'balanced' | 'none';
} = {}): RbfModel {
  const n = X.length;
  const d = n ? X[0].length : 1;
  const gamma = opts.gamma ?? 1 / d;
  const C = opts.c ?? 1;
  let pos = 0;
  for (const v of y) if (v > 0) pos += 1;
  const bal = opts.classWeight === 'balanced' && pos > 0 && pos < n;
  const Ci = (i: number) => (bal ? (y[i] > 0 ? C * n / (2 * pos) : C * n / (2 * (n - pos))) : C);
  const Y = y.map((v) => (v > 0 ? 1 : -1));
  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) for (let j = i; j < n; j += 1) {
    let s = 0;
    for (let k = 0; k < d; k += 1) s += (X[i][k] - X[j][k]) ** 2;
    const v = Math.exp(-gamma * s);
    K[i * n + j] = v;
    K[j * n + i] = v;
  }
  const alpha = new Float64Array(n);
  let b = 0;
  const rng = makeRng(opts.seed ?? 1);
  const f = (i: number) => {
    let s = b;
    for (let j = 0; j < n; j += 1) if (alpha[j] > 0) s += alpha[j] * Y[j] * K[j * n + i];
    return s;
  };
  let passes = 0;
  const tol = 1e-3;
  let guard = 0;
  while (passes < (opts.maxPasses ?? 5) && guard < 200) {
    guard += 1;
    let changed = 0;
    for (let i = 0; i < n; i += 1) {
      const Ei = f(i) - Y[i];
      if ((Y[i] * Ei < -tol && alpha[i] < Ci(i)) || (Y[i] * Ei > tol && alpha[i] > 0)) {
        let j = Math.floor(rng() * (n - 1));
        if (j >= i) j += 1;
        const Ej = f(j) - Y[j];
        const ai = alpha[i];
        const aj = alpha[j];
        let L: number;
        let H: number;
        if (Y[i] !== Y[j]) {
          L = Math.max(0, aj - ai);
          H = Math.min(Ci(j), Ci(i) + aj - ai);
        } else {
          L = Math.max(0, ai + aj - Ci(i));
          H = Math.min(Ci(j), ai + aj);
        }
        if (L >= H) continue;
        const eta = 2 * K[i * n + j] - K[i * n + i] - K[j * n + j];
        if (eta >= 0) continue;
        let nj = aj - Y[j] * (Ei - Ej) / eta;
        nj = Math.min(H, Math.max(L, nj));
        if (Math.abs(nj - aj) < 1e-5) continue;
        const ni = ai + Y[i] * Y[j] * (aj - nj);
        const b1 = b - Ei - Y[i] * (ni - ai) * K[i * n + i] - Y[j] * (nj - aj) * K[i * n + j];
        const b2 = b - Ej - Y[i] * (ni - ai) * K[i * n + j] - Y[j] * (nj - aj) * K[j * n + j];
        alpha[i] = ni;
        alpha[j] = nj;
        b = ni > 0 && ni < Ci(i) ? b1 : nj > 0 && nj < Ci(j) ? b2 : (b1 + b2) / 2;
        changed += 1;
      }
    }
    passes = changed === 0 ? passes + 1 : 0;
  }
  const sv: Float64Array[] = [];
  const coef: number[] = [];
  for (let i = 0; i < n; i += 1) if (alpha[i] > 1e-8) {
    sv.push(X[i]);
    coef.push(alpha[i] * Y[i]);
  }
  return { kind: 'rbf-svm', gamma, sv, coef, b };
}

export function rbfScore(m: RbfModel, x: ArrayLike<number>): number {
  let s = m.b;
  for (let i = 0; i < m.sv.length; i += 1) {
    let d = 0;
    const v = m.sv[i];
    for (let k = 0; k < v.length; k += 1) d += (v[k] - x[k]) ** 2;
    s += m.coef[i] * Math.exp(-m.gamma * d);
  }
  return s;
}

/* ---------- 단일 특징 규칙 기준선 ---------- */

export interface RuleModel {
  kind: 'rule';
  feature: number;
  sign: 1 | -1;
  threshold: number;
}

/** 표준화된 특징 하나 · 부호 · 문턱을 train F1 최대로 고른다. */
export function trainRule(X: ReadonlyArray<Float64Array>, y: ReadonlyArray<number>): RuleModel {
  const d = X.length ? X[0].length : 0;
  let best: RuleModel = { kind: 'rule', feature: 0, sign: 1, threshold: 0 };
  let bestF = -1;
  const qs = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];
  for (let j = 0; j < d; j += 1) {
    for (const sign of [1, -1] as const) {
      for (const thr of qs) {
        let tp = 0;
        let fp = 0;
        let fn = 0;
        for (let i = 0; i < X.length; i += 1) {
          const p = sign * X[i][j] > thr;
          if (p && y[i] > 0) tp += 1;
          else if (p) fp += 1;
          else if (y[i] > 0) fn += 1;
        }
        const f1 = tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
        if (f1 > bestF) {
          bestF = f1;
          best = { kind: 'rule', feature: j, sign, threshold: thr };
        }
      }
    }
  }
  return best;
}

export function ruleScore(m: RuleModel, x: ArrayLike<number>): number {
  return m.sign * x[m.feature] - m.threshold;
}
