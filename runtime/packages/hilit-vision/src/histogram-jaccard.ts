/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·9f986da0 @license @preserve */
/* 가시 히스토그램 Jaccard.

색 속성 집합 Jaccard(`colorAttributeAgreement`)와 다른 식이다.
그 함수를 여기서 다시 만들지 않는다.

L1 합이 1인 두 분포에서 교집합 I 와 Jaccard J 는 J = I/(2-I) 이다.
이 변환만으로 새로운 식별 정보가 생기지는 않는다. 독립 인증으로
더하지 않는다. 1-J 를 또 하나의 검증으로 쓰지 않는다.
*/

export interface HistogramJaccardCompare {
  score: number | null;
  intersection: number | null;
  usedBins: number;
  usedParts: number;
  evidenceMass: number;
  quality: number;
  unknownParts: number;
  independentAuth: false;
}

export function histogramIntersection(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  const n = Math.min(a.length, b.length);
  if (n <= 0) return null;
  let sum = 0;
  let mass = 0;
  for (let i = 0; i < n; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv) || av < 0 || bv < 0) return null;
    sum += Math.min(av, bv);
    mass += av + bv;
  }
  if (mass <= 0) return null;
  return sum;
}

/** J(a,b) = sum min / sum max. 빈 분포는 unknown 이다. 0점 불일치가 아니다. */
export function histogramJaccard(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  const n = Math.min(a.length, b.length);
  if (n <= 0) return null;
  let numer = 0;
  let denom = 0;
  let used = 0;
  for (let i = 0; i < n; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv) || av < 0 || bv < 0) return null;
    numer += Math.min(av, bv);
    denom += Math.max(av, bv);
    if (av > 0 || bv > 0) used += 1;
  }
  if (denom <= 0 || used <= 0) return null;
  return numer / denom;
}

/** L1=1 일 때 교집합 I → Jaccard. 변환일 뿐 새 증거가 아니다. */
export function jaccardFromIntersection(intersection: number): number | null {
  if (!Number.isFinite(intersection) || intersection < 0 || intersection > 1) return null;
  const denom = 2 - intersection;
  if (denom <= 1e-12) return 1;
  return intersection / denom;
}

/**
 * 부위 히스토그램을 가시 마스크로 비교한다.
 * 한쪽이라도 unknown/비가시면 그 부위를 분자·분모에서 뺀다.
 * 보이는 부위 하나만 1이어도 확정하지 않는다 — usedParts 를 같이 돌려준다.
 */
export function compareVisibleHistograms(input: {
  partsA: readonly (ArrayLike<number> | null | undefined)[];
  partsB: readonly (ArrayLike<number> | null | undefined)[];
  visible: readonly boolean[];
  quality?: number;
}): HistogramJaccardCompare {
  const n = Math.min(input.partsA.length, input.partsB.length, input.visible.length);
  let scoreSum = 0;
  let interSum = 0;
  let usedParts = 0;
  let unknownParts = 0;
  let usedBins = 0;
  let evidenceMass = 0;
  for (let i = 0; i < n; i += 1) {
    if (!input.visible[i]) {
      unknownParts += 1;
      continue;
    }
    const a = input.partsA[i];
    const b = input.partsB[i];
    if (!a || !b) {
      unknownParts += 1;
      continue;
    }
    const j = histogramJaccard(a, b);
    const inter = histogramIntersection(a, b);
    if (j == null || inter == null) {
      unknownParts += 1;
      continue;
    }
    scoreSum += j;
    interSum += inter;
    usedParts += 1;
    usedBins += Math.min(a.length, b.length);
    for (let k = 0; k < Math.min(a.length, b.length); k += 1) {
      evidenceMass += Math.min(a[k], b[k]);
    }
  }
  if (usedParts === 0) {
    return {
      score: null,
      intersection: null,
      usedBins: 0,
      usedParts: 0,
      evidenceMass: 0,
      quality: input.quality ?? 0,
      unknownParts,
      independentAuth: false,
    };
  }
  return {
    score: scoreSum / usedParts,
    intersection: interSum / usedParts,
    usedBins,
    usedParts,
    evidenceMass,
    quality: input.quality ?? 1,
    unknownParts,
    independentAuth: false,
  };
}
