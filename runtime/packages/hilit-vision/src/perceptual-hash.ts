/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·a39fb4a5 @license @preserve */
/* 표본 중복용 지각 해시.

신원 판정에 쓰지 않는다. 같은 트랙으로 이미 검증된 크롭이 거의 같은
그림인지 볼 때만 쓴다. Hamming 거리가 가깝다고 사람을 합치지 않고,
멀다고 후보를 지우지 않는다.

구현은 8×8 평균 해시(aHash)다. DCT pHash 논문 성능을 인용하지 않는다.
*/

export const HASH_SIZE = 8;
export const HASH_BITS = HASH_SIZE * HASH_SIZE;
/** 같은 트랙 안 거의-동일 그림. 64비트 중 이하면 중복 후보. */
export const NEAR_DUPLICATE_HAMMING = 8;

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x !== 0n) {
    x &= x - 1n;
    n += 1;
  }
  return n;
}

function grayAt(
  rgb: ArrayLike<number>,
  w: number,
  h: number,
  hasAlpha: boolean,
  x: number,
  y: number,
): number {
  const stride = hasAlpha ? 4 : 3;
  const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * stride;
  return (rgb[i] * 77 + rgb[i + 1] * 150 + rgb[i + 2] * 29) / 256;
}

/** 8×8 평균 해시. 생성 비용을 재려면 호출 쪽 시계를 쓴다. */
export function averageHash64(
  rgb: ArrayLike<number>,
  w: number,
  h: number,
  hasAlpha = false,
): bigint | null {
  if (w < 4 || h < 4 || rgb.length < w * h * (hasAlpha ? 4 : 3)) return null;
  const cells = new Float64Array(HASH_BITS);
  for (let gy = 0; gy < HASH_SIZE; gy += 1) {
    const y0 = Math.floor((gy * h) / HASH_SIZE);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / HASH_SIZE));
    for (let gx = 0; gx < HASH_SIZE; gx += 1) {
      const x0 = Math.floor((gx * w) / HASH_SIZE);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / HASH_SIZE));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += grayAt(rgb, w, h, hasAlpha, x, y);
          n += 1;
        }
      }
      cells[gy * HASH_SIZE + gx] = n ? sum / n : 0;
    }
  }
  let mean = 0;
  for (let i = 0; i < HASH_BITS; i += 1) mean += cells[i];
  mean /= HASH_BITS;
  let bits = 0n;
  for (let i = 0; i < HASH_BITS; i += 1) {
    if (cells[i] >= mean) bits |= 1n << BigInt(i);
  }
  return bits;
}

export function isNearDuplicate(a: bigint | null, b: bigint | null, maxHamming = NEAR_DUPLICATE_HAMMING): boolean {
  if (a == null || b == null) return false;
  return hammingDistance(a, b) <= maxHamming;
}
