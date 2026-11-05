/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·0333c4d4 @license @preserve */
/* One Euro Filter.
 *
 * Casiez, Roussel, Vogel (CHI 2012), "1€ Filter: A Simple Speed-based
 * Low-pass Filter for Noisy Input in Interactive Systems".
 * 저자 참조 구현: https://github.com/casiez/OneEuroFilter
 *
 * 여기서는 논문에 공개된 알고리즘을 그대로 옮겼다. 40줄이 안 되고
 * 의존성이 없어서 라이브러리를 끌어올 이유가 없다.
 *
 * 왜 이걸 쓰는가
 * --------------
 * 고정 계수 저역통과 필터는 하나를 고르면 다른 하나를 잃는다.
 *   세게 걸면  떨림은 잡히는데 따라가는 게 늦다
 *   약하게 걸면 반응은 빠른데 계속 떨린다
 *
 * One Euro 는 **속도에 따라 차단 주파수를 바꾼다.**
 *   느릴 때 (미세한 떨림)  세게 걸어 떨림을 죽인다
 *   빠를 때 (실제 이동)    약하게 걸어 지연을 없앤다
 *
 * 사람이 멈춰 있을 때 화면이 미끄러지는 것과, 뛸 때 화면이 늦는 것을
 * 동시에 없앤다. 우리가 겪던 게 정확히 그 둘이다.
 *
 * 오프라인 궤적에는 trajectory.ts 의 지연 없는 평활을 쓴다. 그쪽이 더
 * 낫다 — 미래를 알기 때문이다. 이 필터는 **추적이 도는 중** 화면
 * (미래를 모르는 구간)에 쓴다.
 */

export interface OneEuroOptions {
  /** 최소 차단 주파수(Hz). 낮출수록 정지 상태에서 더 매끄럽다. */
  minCutoff?: number;
  /** 속도 계수. 높일수록 빠른 움직임에서 지연이 줄어든다. */
  beta?: number;
  /** 속도 추정용 차단 주파수. 보통 1.0 이면 충분하다. */
  dCutoff?: number;
}

function alphaFor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class LowPass {
  private y: number | null = null;
  filter(value: number, alpha: number): number {
    this.y = this.y === null ? value : alpha * value + (1 - alpha) * this.y;
    return this.y;
  }
  reset() { this.y = null; }
  get value() { return this.y; }
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private lastTime: number | null = null;
  private lastValue: number | null = null;

  constructor({ minCutoff = 0.9, beta = 0.02, dCutoff = 1.0 }: OneEuroOptions = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() { this.x.reset(); this.dx.reset(); this.lastTime = null; this.lastValue = null; }

  /** value 를 시각 t(초)에 넣고 걸러진 값을 받는다. */
  filter(value: number, t: number): number {
    if (this.lastTime === null || t <= this.lastTime) {
      this.lastTime = t; this.lastValue = value;
      return this.x.filter(value, 1);
    }
    const dt = t - this.lastTime;
    this.lastTime = t;

    // 속도 추정 자체도 걸러야 한다. 안 그러면 노이즈가 차단 주파수를 흔든다.
    const rawSpeed = (value - (this.lastValue ?? value)) / dt;
    this.lastValue = value;
    const speed = this.dx.filter(rawSpeed, alphaFor(this.dCutoff, dt));

    // 핵심 한 줄: 빠를수록 차단 주파수를 올려 덜 거른다.
    const cutoff = this.minCutoff + this.beta * Math.abs(speed);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }
}

/** 2차원용 묶음. 축마다 따로 걸어야 대각 이동에서 왜곡이 없다. */
export class OneEuroPoint {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  constructor(options?: OneEuroOptions) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
  }
  reset() { this.fx.reset(); this.fy.reset(); }
  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
}
