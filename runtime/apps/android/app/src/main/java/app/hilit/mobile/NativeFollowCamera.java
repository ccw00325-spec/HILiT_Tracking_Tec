/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c927fb09 @license @preserve */
package app.hilit.mobile;

import java.util.List;

/**
 * Source-aspect, normalized crop plan. No Android dependency: tested on JVM.
 *
 * 구도 v2 (2026-09-27, 웹 정본 packages/tracking-core/src/follow-camera.ts 와 같은 규칙):
 *  - 가로: 멈추면 50%, 달려도 앞을 크롭 폭의 5% 만 비운다(45%). 추종 폭 ±8%.
 *  - 세로: 몸(상자) 중심을 크롭 위에서 52% 에 둔다. 머리 위 10%, 발 아래 5% 여백을 제약으로 지킨다.
 *  - 크기: 정지 목표 0.52, 이동 목표 0.46 (크롭 = 상자 높이 / 목표). 전신 여유 하한, 1.0 상한.
 *  - 줌 경로: 0.6초 중앙값(0.3초 미만 순간 변화 무시) → ±8% 데드밴드 → 0.3초 앞서 보기 →
 *    줌인 느리게(τ 1.0초) · 줌아웃 빠르게(τ 0.4초). 모두 시간 간격 기반이라 프레임률과 무관하다.
 *  - 놓침: TARGET_LOST·REACQUIRING·USER_CONFIRMATION·빈 상자와, 놓치기 직전 0.6초의 정상 아닌 점은 믿지 않는다.
 *    마지막 믿은 상자를 붙잡고 1.2초에 걸쳐 1.25배까지 넓힌다. 다시 찾은 자리가 멀면 그 점에서 끊는다(컷).
 *  - 원본 가장자리(2026-09-28): 사람이 원본 끝에 걸리면 크롭을 끝에 붙인다(edgePin, 5% 안 붙임 · 8% 밖 뗌).
 *  - 직캠 마무리(2026-10-28, 웹 정본 웹 정본 #57 과 같은 함수·값): 계획 점 사이는 단조 3차(pchipAt),
 *    가운데 묶음 기준은 몸 중심 0.4초 중앙값(steadyCentreX), 마지막에 시간 기준 가우시안 σ 0.2초
 *    (gaussianInTime) + 구간 되돌리기. 데드존(holdAim)은 Android 에서 끈다(DEAD_ZONE 0): 웹은 반복마다
 *    겨누는 자리로 30% 되당겨 잔떨림이 살아나서 데드존이 필요했지만, 여기는 되당김이 없어 잔떨림이 이미
 *    평활에서 지워진다. 켜면 떨림이 느린 계단으로 바뀌어 평활 뒤에 남는다(실사 22편은 차이 없음,
 *    합성 제자리 춤은 이동이 늘었다 — NativeFollowCameraFancamTest, 연구 저장소 2026-10-28 기록).
 */
final class NativeFollowCamera {
    static final double LEAD = 0.05, TETHER = 0.08, BODY_Y = 0.52, HEAD = 0.10, FOOT = 0.05, SIDE = 0.10;
    static final double STILL_SHARE = 0.52, MOVING_SHARE = 0.46, STILL_SPEED = 0.38;
    static final double MIN_SHARE = 0.40, HOLD_WIDEN = 1.25, DEADBAND = 0.08;
    static final double ZOOM_IN_TAU = 1.0, ZOOM_OUT_TAU = 0.4, LOOK_AHEAD = 0.3, PERSIST = 0.6;
    /** 직캠 마무리. 셋을 모두 0 으로 두면 2026-10-27 까지의 경로와 같다(보간만 3차 곡선). 데드존을 끈 이유는 위 주석. */
    static final double DEAD_ZONE = 0, SETTLE_SEC = 0.2, TETHER_MEDIAN_SEC = 0.4;

    private final double[] times, x, y, share;

    NativeFollowCamera(List<NativeTrackingEngine.Point> points) {
        this(points, DEAD_ZONE, SETTLE_SEC, TETHER_MEDIAN_SEC);
    }

    NativeFollowCamera(List<NativeTrackingEngine.Point> points, double deadZone, double settleSec, double tetherMedianSec) {
        if (points.isEmpty()) throw new IllegalArgumentException("추적 경로가 없습니다.");
        int n = points.size();
        times = new double[n]; x = new double[n]; y = new double[n]; share = new double[n];
        for (int i = 0; i < n; i++) {
            times[i] = points.get(i).timestamp;
            if (i > 0 && times[i] <= times[i - 1]) throw new IllegalArgumentException("추적 시각 순서가 잘못되었습니다.");
        }

        /* 믿을 점. 놓친 상자는 다른 사람이거나 빈 값(0,0)이라 따라가지 않는다. */
        boolean[] reliable = new boolean[n];
        for (int i = 0; i < n; i++) reliable[i] = isReliable(points.get(i));
        for (int i = 1; i < n; i++) {
            if (reliable[i] || !reliable[i - 1]) continue;
            for (int j = i - 1; j >= 0 && reliable[j] && !"TRACKING_OK".equals(points.get(j).state)
                && times[i] - times[j] <= 0.6; j--) reliable[j] = false;
        }
        int firstReliable = -1;
        for (int i = 0; i < n; i++) if (reliable[i]) { firstReliable = i; break; }
        if (firstReliable < 0) {
            for (int i = 0; i < n; i++) { x[i] = .5; y[i] = .5; share[i] = 1; }
            return;
        }

        /* 믿지 않는 점은 마지막 믿은 상자(앞에 없으면 다음 것)를 붙잡고 넓힌다. */
        NativeTrackingEngine.Box[] box = new NativeTrackingEngine.Box[n];
        double[] widen = new double[n];
        int last = -1;
        for (int i = 0; i < n; i++) {
            widen[i] = 1;
            if (reliable[i]) { last = i; box[i] = points.get(i).box; continue; }
            int src = last;
            if (src < 0) { src = i + 1; while (src < n && !reliable[src]) src++; }
            box[i] = points.get(src).box;
            if (last >= 0) widen[i] = 1 + (HOLD_WIDEN - 1) * smoothstep(0, 1.2, times[i] - times[last]);
        }
        boolean[] broken = new boolean[n];
        for (int i = 1; i < n; i++) {
            if (!reliable[i] || reliable[i - 1]) continue;
            NativeTrackingEngine.Box a = box[i - 1], b = box[i];
            double d = Math.hypot(a.cx() - b.cx(), a.cy() - b.cy());
            broken[i] = d > Math.max(0.04, 0.6 * Math.max(a.h, b.h));
        }

        double[] vx = new double[n], speed = new double[n], want = new double[n], floor = new double[n];
        for (int i = 0; i < n; i++) {
            int a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
            double span = Math.max(1e-3, times[b] - times[a]);
            vx[i] = (box[b].cx() - box[a].cx()) / span;
            double vy = (box[b].cy() - box[a].cy()) / span;
            speed[i] = Math.hypot(vx[i], vy) / Math.max(0.05, box[i].h);
            double target = speed[i] < STILL_SPEED ? STILL_SHARE : MOVING_SHARE;
            double raw = Math.max(MIN_SHARE, box[i].h / target * widen[i]);
            SportsTrack.OcclusionResult occ = SportsTrack.applyOcclusionCrop(
                (float) Math.min(1, raw), 0.95f, new SportsTrack.Box(box[i].x, box[i].y, box[i].w, box[i].h), null);
            want[i] = occ.cropShare;
            floor[i] = Math.min(1, Math.max(box[i].h / (1 - HEAD - FOOT), box[i].w / (1 - 2 * SIDE)) * widen[i]);
        }

        /* 줌 경로. 한 프레임 상자 크기 흔들림에 반응하지 않는다. */
        double[] stable = medianOver(want, PERSIST / 2, broken);
        double[] level = new double[n];
        for (int i = 0; i < n; i++) {
            if (i == 0 || broken[i]) { level[i] = stable[i]; continue; }
            level[i] = Math.abs(stable[i] / level[i - 1] - 1) > DEADBAND ? stable[i] : level[i - 1];
        }
        double[] ahead = new double[n];
        for (int i = 0; i < n; i++) {
            double m = level[i];
            for (int j = i + 1; j < n && times[j] - times[i] <= LOOK_AHEAD && !broken[j]; j++) m = Math.max(m, level[j]);
            ahead[i] = m;
        }
        double cur = ahead[0];
        for (int i = 0; i < n; i++) {
            if (i > 0 && !broken[i]) {
                double dt = times[i] - times[i - 1];
                double tau = ahead[i] > cur ? ZOOM_OUT_TAU : ZOOM_IN_TAU;
                cur += (1 - Math.exp(-dt / tau)) * (ahead[i] - cur);
            } else cur = ahead[i];
            share[i] = cur;
        }
        /* 전신 하한은 평활 뒤에 다시 — 미리 넓히고 천천히 풀리게 앞뒤로 감쇠시킨 값으로. */
        double[] env = floor.clone();
        for (int i = 1; i < n; i++) if (!broken[i]) env[i] = Math.max(env[i], env[i - 1] * Math.exp(-(times[i] - times[i - 1]) / ZOOM_IN_TAU));
        for (int i = n - 2; i >= 0; i--) if (!broken[i + 1]) env[i] = Math.max(env[i], env[i + 1] * Math.exp(-(times[i + 1] - times[i]) / ZOOM_OUT_TAU));
        for (int i = 0; i < n; i++) share[i] = Math.min(1, Math.max(share[i], Math.max(env[i], floor[i])));

        for (int i = 0; i < n; i++) {
            double moving = smoothstep(0.22, 1.05, speed[i]);
            double dir = vx[i] > 1e-5 ? 1 : vx[i] < -1e-5 ? -1 : 0;
            x[i] = box[i].cx() + dir * LEAD * moving * share[i];
            y[i] = box[i].cy() - (BODY_Y - 0.5) * share[i];
        }
        /* 원본 가장자리 고정(2026-09-28, 웹 follow-camera.ts edgePin 과 같은 규칙) — 사람이 원본 끝에 걸리면
         * 가운데에 둘 수 없으니 크롭을 끝에 붙여 둔다. 평활 전에 겨누는 자리(x)에 건다. */
        edgePin(x, share, 1, broken, EDGE_PIN_IN, EDGE_PIN_OUT);
        /* 직캠 데드존 — 제자리 흔들림만큼은 겨누는 자리를 붙잡는다. 달리는 사람에게는 걸지 않는다
         * (걸면 그 폭만큼 뒤처져 앞 비움이 사라진다). 움직임 판정은 위 겨누는 자리와 같은 식이다. */
        double dz = Math.max(0, deadZone);
        if (dz > 0) {
            double[] bandX = new double[n], bandY = new double[n];
            for (int i = 0; i < n; i++) {
                double still = 1 - smoothstep(0.22, 1.05, speed[i]);
                bandX[i] = share[i] * dz * still; bandY[i] = share[i] * dz * 1.5 * still;
            }
            double[] hx = holdAim(x, bandX, broken), hy = holdAim(y, bandY, broken);
            System.arraycopy(hx, 0, x, 0, n); System.arraycopy(hy, 0, y, 0, n);
        }
        /* 안전 구간. 가운데 묶음은 상자 가운데가 아니라 몸 자리(이동 중앙값) 기준 — 팔을 뻗어도 출렁이지 않게. */
        double[] cxs = new double[n];
        for (int i = 0; i < n; i++) cxs[i] = box[i].cx();
        double[] bodyX = steadyCentreX(times, cxs, broken, tetherMedianSec);
        double[] loX = new double[n], hiX = new double[n], loY = new double[n], hiY = new double[n];
        for (int i = 0; i < n; i++) {
            NativeTrackingEngine.Box b = box[i];
            double s = share[i];
            double lx = Math.max(s / 2, Math.max(b.x + b.w - (0.5 - SIDE) * s, bodyX[i] - TETHER * s));
            double hx = Math.min(1 - s / 2, Math.min(b.x + (0.5 - SIDE) * s, bodyX[i] + TETHER * s));
            double ly = Math.max(s / 2, b.y + b.h - (0.5 - FOOT) * s);
            double hy = Math.min(1 - s / 2, b.y + (0.5 - HEAD) * s);
            if (lx <= hx) { loX[i] = lx; hiX[i] = hx; }
            else loX[i] = hiX[i] = clamp(b.cx(), s / 2, 1 - s / 2);
            /* 세로 제약이 부딪히면 머리를 먼저 지킨다. */
            if (ly <= hy) { loY[i] = ly; hiY[i] = hy; }
            else loY[i] = hiY[i] = clamp(Math.min(b.cy(), hy), s / 2, 1 - s / 2);
        }
        for (int pass = 0; pass < 12; pass++) {
            smooth(x, broken); smooth(y, broken);
            clampInto(x, loX, hiX); clampInto(y, loY, hiY);
        }
        /* 시간 기준 마무리 다듬기 — 가우시안으로 펴고 안전 구간으로 되돌리기를 반복한다. 등속 팬과
         * 부드러운 가감속만 남는다. 컷은 넘지 않는다. */
        if (settleSec > 0) {
            for (int pass = 0; pass < 6; pass++) {
                double[] gx = gaussianInTime(times, x, broken, settleSec), gy = gaussianInTime(times, y, broken, settleSec);
                System.arraycopy(gx, 0, x, 0, n); System.arraycopy(gy, 0, y, 0, n);
                clampInto(x, loX, hiX); clampInto(y, loY, hiY);
            }
        }
    }

    private static void clampInto(double[] v, double[] lo, double[] hi) {
        for (int i = 0; i < v.length; i++) v[i] = clamp(v[i], lo[i], hi[i]);
    }

    /**
     * 겨누는 자리 데드존(hysteresis). 붙잡은 자리에서 band[i] 안이면 그대로, 벗어나면 벗어난 만큼만 따라간다.
     * 컷(broken)에서는 새로 잡는다. 앞에서 한 번·뒤에서 한 번 돌려 평균한다 — 등속 이동에서는 두 뒤처짐이
     * 서로 지워지고, band 안의 제자리 흔들림은 두 방향 모두 붙잡혀 멈춘다. 웹 follow-camera.ts holdAim 과 같다.
     */
    static double[] holdAim(double[] aim, double[] band, boolean[] broken) {
        int n = aim.length;
        double[] fwd = new double[n], bwd = new double[n];
        double held = 0;
        for (int i = 0; i < n; i++) {
            if (i == 0 || broken[i]) { held = aim[i]; fwd[i] = held; continue; }
            double d = aim[i] - held;
            if (d > band[i]) held = aim[i] - band[i]; else if (d < -band[i]) held = aim[i] + band[i];
            fwd[i] = held;
        }
        for (int i = n - 1; i >= 0; i--) {
            /* 컷은 i 에서 시작하는 새 구간이다 — 뒤 방향은 i-1 에서 새로 잡는다. */
            if (i == n - 1 || broken[i + 1]) { held = aim[i]; bwd[i] = held; continue; }
            double d = aim[i] - held;
            if (d > band[i]) held = aim[i] - band[i]; else if (d < -band[i]) held = aim[i] + band[i];
            bwd[i] = held;
        }
        double[] out = new double[n];
        for (int i = 0; i < n; i++) out[i] = (fwd[i] + bwd[i]) / 2;
        return out;
    }

    /** 몸 가로 중심의 이동 중앙값(창 win 초). 컷을 넘지 않는다. win 0 이면 그대로. 웹 steadyCentreX 와 같다. */
    static double[] steadyCentreX(double[] times, double[] cx, boolean[] broken, double win) {
        if (!(win > 0)) return cx.clone();
        int n = cx.length;
        double half = win / 2;
        double[] out = new double[n];
        for (int i = 0; i < n; i++) {
            int a = i, b = i;
            while (a > 0 && !broken[a] && times[i] - times[a - 1] <= half + 1e-9) a--;
            while (b < n - 1 && !broken[b + 1] && times[b + 1] - times[i] <= half + 1e-9) b++;
            double[] w = java.util.Arrays.copyOfRange(cx, a, b + 1);
            java.util.Arrays.sort(w);
            out[i] = w[w.length >> 1];
        }
        return out;
    }

    /** 시간축 가우시안 평활(σ 초). 컷(broken)을 넘지 않는다. 점 간격이 고르지 않아도 된다. 웹 gaussianInTime 과 같다. */
    static double[] gaussianInTime(double[] times, double[] v, boolean[] broken, double sigma) {
        int n = v.length;
        int[] seg = new int[n];
        for (int i = 0, s = 0; i < n; i++) { if (broken[i]) s++; seg[i] = s; }
        double reach = 3 * sigma;
        double[] out = new double[n];
        for (int i = 0; i < n; i++) {
            double sw = 0, sv = 0;
            for (int j = i; j >= 0 && seg[j] == seg[i] && times[i] - times[j] <= reach; j--) {
                double r = (times[i] - times[j]) / sigma, w = Math.exp(-0.5 * r * r); sw += w; sv += w * v[j];
            }
            for (int j = i + 1; j < n && seg[j] == seg[i] && times[j] - times[i] <= reach; j++) {
                double r = (times[j] - times[i]) / sigma, w = Math.exp(-0.5 * r * r); sw += w; sv += w * v[j];
            }
            out[i] = sw > 0 ? sv / sw : v[i];
        }
        return out;
    }

    /**
     * 단조 3차 보간(Fritsch–Carlson PCHIP)에서 점 i 의 기울기. 고르지 않은 시간 간격을 그대로 쓴다.
     * 이웃 기울기의 부호가 다르거나 한쪽이 0 이면 0 — 그래서 곡선이 이웃 점 값 밖으로 넘치지 않는다.
     */
    private static double pchipSlope(double[] t, double[] v, int i) {
        int n = v.length;
        if (n < 2) return 0;
        if (i <= 0) return n > 2 && Math.signum(slope(t, v, 0)) == Math.signum(slope(t, v, 1)) ? slope(t, v, 0) : (n > 2 ? 0 : slope(t, v, 0));
        if (i >= n - 1) return n > 2 && Math.signum(slope(t, v, n - 2)) == Math.signum(slope(t, v, n - 3)) ? slope(t, v, n - 2) : (n > 2 ? 0 : slope(t, v, n - 2));
        double d0 = slope(t, v, i - 1), d1 = slope(t, v, i);
        if (d0 == 0 || d1 == 0 || Math.signum(d0) != Math.signum(d1)) return 0;
        double h0 = t[i] - t[i - 1], h1 = t[i + 1] - t[i];
        double w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
        return (w1 + w2) / (w1 / d0 + w2 / d1);
    }
    private static double slope(double[] t, double[] v, int a) { return (v[a + 1] - v[a]) / Math.max(1e-6, t[a + 1] - t[a]); }

    /** 계획 점 lo·hi 사이 시각 at 의 값 — 단조 3차 에르미트. lo == hi 면 그 점 값. 웹 pchipAt 과 같다. */
    static double pchipAt(double[] t, double[] v, int lo, int hi, double at) {
        if (hi == lo) return v[lo];
        double h = Math.max(1e-6, t[hi] - t[lo]);
        double s = clamp((at - t[lo]) / h, 0, 1), s2 = s * s, s3 = s2 * s;
        double m0 = pchipSlope(t, v, lo) * h, m1 = pchipSlope(t, v, hi) * h;
        return (2 * s3 - 3 * s2 + 1) * v[lo] + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * v[hi] + (s3 - s2) * m1;
    }

    /** 끝에서 크롭 폭의 이만큼 안으로 들어오면 붙이고(IN), 이만큼 밖으로 나가야 뗀다(OUT). 0 이면 끈다. */
    static final double EDGE_PIN_IN = 0.05, EDGE_PIN_OUT = 0.08;

    /**
     * 겨누는 자리(크롭 중심 x)를 원본 끝에 붙인다 — 두 문턱. 제자리에서 고친다. 끝 쪽으로만 옮기고,
     * 이미 원본 밖을 겨누는 값은 그대로 둔다. 컷(broken)에서는 붙임 상태를 새로 시작한다.
     */
    static void edgePin(double[] aim, double[] cropW, double sw, boolean[] broken, double pinIn, double pinOut) {
        if (!(pinIn > 0)) return;
        double out = Math.max(pinIn, pinOut);
        int side = 0;
        for (int i = 0; i < aim.length; i++) {
            if (broken[i]) side = 0;
            double w = Math.min(sw, cropW[i]);
            double leftGap = (aim[i] - w / 2) / w;
            double rightGap = (sw - (aim[i] + w / 2)) / w;
            if (side == -1 && leftGap > out) side = 0;
            if (side == 1 && rightGap > out) side = 0;
            if (side == 0) side = leftGap < pinIn ? -1 : rightGap < pinIn ? 1 : 0;
            if (side == -1) aim[i] = Math.min(aim[i], w / 2);
            else if (side == 1) aim[i] = Math.max(aim[i], sw - w / 2);
        }
    }

    static boolean isReliable(NativeTrackingEngine.Point p) {
        String s = p.state == null ? "" : p.state.toUpperCase(java.util.Locale.ROOT);
        if (s.equals("TARGET_LOST") || s.equals("REACQUIRING") || s.contains("USER") || s.contains("CONFIRM")) return false;
        return p.box.w > 0.002f && p.box.h > 0.002f;
    }

    /** 시각 ±half 안 중앙값. 끊긴 곳(broken)을 넘어가지 않는다. */
    private double[] medianOver(double[] v, double half, boolean[] broken) {
        int n = v.length;
        double[] out = new double[n];
        for (int i = 0; i < n; i++) {
            int a = i, b = i;
            while (a > 0 && !broken[a] && times[i] - times[a - 1] <= half) a--;
            while (b < n - 1 && !broken[b + 1] && times[b + 1] - times[i] <= half) b++;
            double[] w = java.util.Arrays.copyOfRange(v, a, b + 1);
            java.util.Arrays.sort(w);
            out[i] = w[w.length / 2];
        }
        return out;
    }

    private void smooth(double[] v, boolean[] broken) {
        for (int i = 1; i < v.length; i++) {
            if (broken[i]) continue;
            double a = 1 - Math.exp(-2.4 * (times[i] - times[i - 1])); v[i] = v[i - 1] + a * (v[i] - v[i - 1]);
        }
        for (int i = v.length - 2; i >= 0; i--) {
            if (broken[i + 1]) continue;
            double a = 1 - Math.exp(-2.4 * (times[i + 1] - times[i])); v[i] = v[i + 1] + a * (v[i] - v[i + 1]);
        }
    }

    /** cx, cy, crop width/height share in the source-aspect frame. */
    double[] at(double time) {
        int lo = 0, hi = times.length - 1;
        if (time <= times[0]) hi = 0;
        else if (time >= times[hi]) lo = hi;
        else while (hi - lo > 1) { int m = (lo + hi) / 2; if (times[m] <= time) lo = m; else hi = m; }
        /* 점 사이는 단조 3차 곡선(2026-10-28). 직선으로 이으면 분석 점마다 카메라 속도가 꺾여 팬이 끊겨 보였다.
         * 단조 곡선은 점을 그대로 지나고 이웃 두 점 사이를 넘지 않아 계획이 지킨 안전 구간을 깨지 않는다. */
        return new double[]{pchipAt(times, x, lo, hi, time), pchipAt(times, y, lo, hi, time), pchipAt(times, share, lo, hi, time)};
    }

    private static double smoothstep(double e0, double e1, double v) {
        double t = clamp((v - e0) / Math.max(1e-6, e1 - e0), 0, 1);
        return t * t * (3 - 2 * t);
    }
    private static double clamp(double v, double lo, double hi) { return Math.max(lo, Math.min(hi, v)); }
}
