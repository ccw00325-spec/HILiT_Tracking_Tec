/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d9f37803 @license @preserve */
package app.hilit.mobile;

/**
 * 추적 영역 예측 — 웹 `track-region-prediction.ts` 의 Java 판.
 *
 * <p>웹과 앱이 다른 추적을 쓰면 같은 영상에서 다른 결과가 나온다. 사용자는
 * 그걸 "앱이 이상하다" 로 겪는다. 그래서 값과 규칙을 그대로 옮긴다.
 *
 * <p>예측한다 — 위치(중심)·크기(상자)·가시성, 그리고 그 결과로 나오는
 * 프레이밍 영역. 예측하지 않는다 — <b>누구인지</b>. 여기서 나온 상자는
 * "대상이 여기 있을 것 같다" 이지 "여기 있는 사람이 대상이다" 가 아니다.
 * 그 둘을 섞는 순간 예측이 강제 매칭이 된다.
 *
 * <p>속도를 여러 갈래로 재고 믿을 수 있는 것만 섞는다. 못 잰 갈래는 0으로
 * 채우지 않고 분모에서 뺀다. 가림이 길어지면 스스로 손을 든다.
 */
final class HilitTrackRegionPrediction {

    /* 웹과 같은 값이어야 한다. 한쪽만 고치면 두 화면이 갈라진다. */
    static final double HORIZON_SEC = 0.05;
    static final double MAX_COAST_SEC = 1.2;
    static final double MAX_SPEED_BODIES = 6;
    static final double EMA_ALPHA = 0.45;
    static final double PROCESS_ACCEL = 900;
    static final double MEASURE_NOISE_PX = 3;
    static final double OCCLUDED_NOISE_SCALE = 8;
    static final double COAST_DECAY_PER_SEC = 0.6;
    static final double SUBJECT_SHARE = 0.42;
    static final double LEAD_ROOM = 0.12;
    static final double SIZE_GAIN = 0.25;
    static final double UNCERTAINTY_FULL_BODIES = 1.2;
    static final double MAX_WIDEN = 1.65;
    static final double MAX_FRAMING_SPEED = 2.2;
    static final double MAX_FRAMING_ZOOM_RATE = 1.1;
    static final double MIN_FILL_CONFIDENCE = 0.35;
    static final double MAX_FILL_SEC = 0.4;
    /** 관측이 이만큼 끊겼다 가면 쌓인 예측 오차를 버리고 직선으로 다시 잰다. */
    static final double OBSERVATION_CENTRIC_GAP_SEC = 0.4;

    static final String OCC_VISIBLE = "visible";
    static final String OCC_PARTIAL = "partial";
    static final String OCC_OCCLUDED = "occluded";
    static final String OCC_UNKNOWN = "unknown";

    static final class Rect {
        double x, y, w, h;
        Rect(double x, double y, double w, double h) { this.x = x; this.y = y; this.w = w; this.h = h; }
        double cx() { return x + w / 2; }
        double cy() { return y + h / 2; }
    }

    static final class Prediction {
        double tSec, horizonSec;
        double centerX, centerY;
        Rect box, framing;
        double vx, vy, speedBodies, uncertaintyPx, widenFactor;
        String visibility;
        double confidence;
        boolean usable, reconciling, mayFillGap;
        boolean sourceKalman, sourceEma, sourcePose;
        String reason;
        /** 이 상자는 위치 예측이지 동일인 판정이 아니다. 늘 false 다. */
        final boolean identityClaim = false;
    }

    /** 축 하나짜리 등속 칼만. 상태는 [위치, 속도]. */
    private static final class Axis {
        double pos, vel, pp = 1e3, pv, vv = 1e4;
        boolean started;

        void start(double p) { pos = p; vel = 0; pp = 1e3; pv = 0; vv = 1e4; started = true; }

        void predict(double dt) {
            if (!started || dt <= 0) return;
            pos += vel * dt;
            double q = PROCESS_ACCEL * PROCESS_ACCEL;
            double dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt2 * dt2;
            pp += 2 * pv * dt + vv * dt2 + (q * dt4) / 4;
            pv += vv * dt + (q * dt3) / 2;
            vv += q * dt2;
        }

        void update(double z, double r) {
            if (!started) { start(z); return; }
            double s = pp + r;
            if (!(s > 0)) return;
            double kp = pp / s, kv = pv / s, innovation = z - pos;
            pos += kp * innovation;
            vel += kv * innovation;
            double pp0 = pp, pv0 = pv;
            pp = pp0 - kp * pp0;
            pv = pv0 - kp * pv0;
            vv -= kv * pv0;
            if (vv < 1e-6) vv = 1e-6;
            if (pp < 1e-6) pp = 1e-6;
        }

        double std() { return Math.sqrt(Math.max(0, pp)); }
    }

    private final Axis ax = new Axis();
    private final Axis ay = new Axis();
    private double width, height;
    private double lastT = Double.NaN;
    private double lastObservedT = Double.NaN;
    private double lastCx, lastCy;
    private boolean hasLastCenter;
    private double emaVx, emaVy;
    private boolean emaReady;
    private double lastFrameDt = 0.05;
    private double smoothX, smoothY, smoothW, smoothH;
    private boolean hasSmoothed;
    private int observationCentricUpdates;

    /** 사용자가 대상을 고른 순간. 속도는 0 으로 두고 관측으로 배운다. */
    void start(Rect box, double tSec) {
        ax.start(box.cx());
        ay.start(box.cy());
        width = box.w;
        height = box.h;
        lastT = tSec;
        lastObservedT = tSec;
        lastCx = box.cx();
        lastCy = box.cy();
        hasLastCenter = true;
        emaVx = 0; emaVy = 0; emaReady = false;
        hasSmoothed = false;
        observationCentricUpdates = 0;
    }

    boolean started() { return ax.started; }

    int observationCentricUpdates() { return observationCentricUpdates; }

    private static double clamp(double v, double lo, double hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    /**
     * 관측 하나를 넣고 다음 자리를 받는다.
     *
     * @param box        이번 관측 상자. 못 봤으면 null — 그때는 예측만 한다.
     * @param confidence 검출·추적 신뢰도 0~1. 못 쟀으면 음수.
     * @param joints     몸통 관절 중심 [x, y]. 없으면 null.
     */
    Prediction observe(double tSec, Rect box, double confidence, String occlusion,
                       double frameW, double frameH, double[] joints, double horizonSec) {
        if (!ax.started) {
            if (box != null) start(box, tSec);
            else return compose(tSec, horizonSec, frameW, frameH, false, "not-started", confidence, occlusion);
        }

        double dt = Double.isNaN(lastT) ? 0 : Math.max(0, tSec - lastT);
        if (dt > 0) { ax.predict(dt); ay.predict(dt); }

        boolean usedPose = false;
        if (box != null) {
            double trust = confidence < 0 ? 0.5 : clamp(confidence, 0, 1);
            double occScale = OCC_OCCLUDED.equals(occlusion) ? OCCLUDED_NOISE_SCALE
                    : (OCC_PARTIAL.equals(occlusion) ? 3 : 1);
            double noise = MEASURE_NOISE_PX * occScale * (1 + 3 * (1 - trust));
            double r = noise * noise;
            double mx = box.cx(), my = box.cy();
            ax.update(mx, r);
            ay.update(my, r);

            double gap = Double.isNaN(lastObservedT) ? dt : tSec - lastObservedT;

            /* 관측 중심 갱신. 오래 못 보다 돌아오면 그동안 쌓인 예측 오차를
             * 버리고, 사라지기 직전 관측과 지금 관측을 직선으로 이어
             * 그 사이 실제 속도로 바꾼다. 사람은 등속으로 안 움직인다. */
            if (hasLastCenter && gap >= OBSERVATION_CENTRIC_GAP_SEC) {
                emaVx = (mx - lastCx) / gap;
                emaVy = (my - lastCy) / gap;
                emaReady = true;
                ax.vel = emaVx;
                ay.vel = emaVy;
                observationCentricUpdates++;
            }

            /* 속도를 여러 갈래로 재고 잰 것만 섞는다. */
            double sumVx = ax.vel, sumVy = ay.vel, weight = 1;
            if (hasLastCenter && gap > 1e-3) {
                double w = 0.8 * trust;
                sumVx += ((mx - lastCx) / gap) * w;
                sumVy += ((my - lastCy) / gap) * w;
                weight += w;
            }
            if (joints != null && joints.length >= 2 && hasLastCenter && gap > 1e-3) {
                /* 몸통 관절 중심. 상자 중심은 팔다리에 흔들리지만 골반은 덜 흔들린다. */
                sumVx += ((joints[0] - lastCx) / gap) * 1.1;
                sumVy += ((joints[1] - lastCy) / gap) * 1.1;
                weight += 1.1;
                usedPose = true;
            }
            double fusedVx = sumVx / weight, fusedVy = sumVy / weight;
            if (emaReady) {
                emaVx = emaVx * (1 - EMA_ALPHA) + fusedVx * EMA_ALPHA;
                emaVy = emaVy * (1 - EMA_ALPHA) + fusedVy * EMA_ALPHA;
            } else {
                emaVx = fusedVx; emaVy = fusedVy; emaReady = true;
            }
            /* 사람이 갈 수 있는 속도로 자른다. 상한이 없으면 한 번 튄 관측이
             * 예측을 화면 밖으로 던진다. */
            double cap = MAX_SPEED_BODIES * Math.max(1, height);
            double speed = Math.hypot(emaVx, emaVy);
            if (speed > cap && speed > 0) { emaVx *= cap / speed; emaVy *= cap / speed; }
            ax.vel = emaVx;
            ay.vel = emaVy;

            width += (box.w - width) * SIZE_GAIN;
            height += (box.h - height) * SIZE_GAIN;
            lastCx = mx; lastCy = my; hasLastCenter = true;
            lastObservedT = tSec;
        } else if (dt > 0) {
            /* 관측이 없다. 속도를 줄인다 — 오래 못 본 상태에서 멀리까지
             * 예측하면 그 예측이 해롭다. */
            double decay = Math.pow(COAST_DECAY_PER_SEC, dt);
            emaVx *= decay; emaVy *= decay;
            ax.vel = emaVx; ay.vel = emaVy;
        }

        if (dt > 0) lastFrameDt = dt;
        lastT = tSec;
        double coast = Double.isNaN(lastObservedT) ? 0 : tSec - lastObservedT;
        boolean usable = coast <= MAX_COAST_SEC;
        String reason = usable ? (box != null ? "observed" : "coasting") : "coast-limit-exceeded";
        Prediction out = compose(tSec, horizonSec, frameW, frameH, usable, reason, confidence, occlusion);
        out.sourcePose = usedPose;
        return out;
    }

    private Prediction compose(double tSec, double horizon, double frameW, double frameH,
                               boolean usable, String reason, double confidence, String occlusion) {
        Prediction p = new Prediction();
        p.tSec = tSec;
        p.horizonSec = horizon;
        double h = Math.max(1, height), w = Math.max(1, width);
        double vx = ax.started ? ax.vel : 0, vy = ay.started ? ay.vel : 0;
        double cx = clamp((ax.started ? ax.pos : frameW / 2) + vx * horizon, 0, frameW);
        double cy = clamp((ay.started ? ay.pos : frameH / 2) + vy * horizon, 0, frameH);
        p.centerX = cx; p.centerY = cy;
        p.box = new Rect(cx - w / 2, cy - h / 2, w, h);
        p.vx = vx; p.vy = vy;
        p.speedBodies = Math.hypot(vx, vy) / h;
        p.uncertaintyPx = ax.started ? Math.hypot(ax.std(), ay.std()) : Double.POSITIVE_INFINITY;
        p.sourceKalman = true;
        p.sourceEma = emaReady;

        double framingH = clamp(h / SUBJECT_SHARE, h, frameH);
        double framingW = clamp(framingH * (frameW / Math.max(1, frameH)), w, frameW);
        double coast = (Double.isNaN(lastObservedT) || Double.isNaN(lastT))
                ? 0 : Math.max(0, lastT - lastObservedT);
        /* 오래 못 봤으면 앞서 보지 않는다. 틀린 방향으로 달려가면
         * 사용자가 화면에서 대상을 잃는다. */
        double leadScale = coast > 0 ? Math.max(0, 1 - coast / MAX_COAST_SEC) : 1;
        double leadX = clamp(vx * horizon * 4, -framingW * LEAD_ROOM, framingW * LEAD_ROOM) * leadScale;
        double leadY = clamp(vy * horizon * 4, -framingH * LEAD_ROOM, framingH * LEAD_ROOM) * leadScale;

        /* 불확실할수록 넓게 잡는다. 틀려도 대상이 화면 안에 남는다. */
        double uncertaintyBodies = Double.isInfinite(p.uncertaintyPx)
                ? UNCERTAINTY_FULL_BODIES : p.uncertaintyPx / h;
        double widen = 1 + (MAX_WIDEN - 1) * clamp(uncertaintyBodies / UNCERTAINTY_FULL_BODIES, 0, 1);
        p.widenFactor = widen;
        double wantW = clamp(framingW * widen, w, frameW);
        double wantH = clamp(framingH * widen, h, frameH);
        double targetX = clamp(cx + leadX - wantW / 2, 0, Math.max(0, frameW - wantW));
        double targetY = clamp(cy + leadY - wantH / 2, 0, Math.max(0, frameH - wantH));

        /* 되돌릴 때는 속도 한계 안에서 되돌린다. 순간이동이 없으면 끊겨 보이지 않는다. */
        double step = Math.max(1e-3, lastFrameDt);
        boolean reconciling = false;
        if (!hasSmoothed) {
            smoothX = targetX; smoothY = targetY; smoothW = wantW; smoothH = wantH;
            hasSmoothed = true;
        } else {
            double maxMove = MAX_FRAMING_SPEED * smoothW * step;
            double dx = targetX - smoothX, dy = targetY - smoothY, dist = Math.hypot(dx, dy);
            if (dist > maxMove && dist > 0) {
                smoothX += (dx / dist) * maxMove;
                smoothY += (dy / dist) * maxMove;
                reconciling = true;
            } else { smoothX = targetX; smoothY = targetY; }
            double zoomCap = Math.pow(1 + MAX_FRAMING_ZOOM_RATE, step);
            double nextW = clamp(wantW, smoothW / zoomCap, smoothW * zoomCap);
            double nextH = clamp(wantH, smoothH / zoomCap, smoothH * zoomCap);
            if (Math.abs(nextW - wantW) > 1e-6) reconciling = true;
            smoothW = nextW; smoothH = nextH;
        }
        p.framing = new Rect(
                clamp(smoothX, 0, Math.max(0, frameW - smoothW)),
                clamp(smoothY, 0, Math.max(0, frameH - smoothH)),
                smoothW, smoothH);
        p.reconciling = reconciling;

        double detect = confidence < 0 ? 0.5 : clamp(confidence, 0, 1);
        String predicted = occlusion == null ? OCC_UNKNOWN : occlusion;
        double conf = detect;
        if (coast > 0) {
            predicted = coast > MAX_COAST_SEC ? OCC_UNKNOWN : OCC_OCCLUDED;
            conf = clamp(detect * Math.max(0, 1 - coast / MAX_COAST_SEC), 0, 1);
        } else if (OCC_UNKNOWN.equals(predicted)) {
            conf = clamp(detect * 0.6, 0, 1);
        }
        p.visibility = predicted;
        p.confidence = conf;
        p.usable = usable;
        p.reason = reason;
        /* 검출 공백을 예측으로 메워도 되는 조건. 신원과는 무관하다. */
        p.mayFillGap = usable && coast > 0 && coast <= MAX_FILL_SEC && conf >= MIN_FILL_CONFIDENCE;
        return p;
    }

    /** 그 시각의 예상 중심. 버틸 수 있는 한계를 넘으면 null. */
    double[] predictAt(double tSec) {
        if (!ax.started || Double.isNaN(lastT)) return null;
        double coast = Double.isNaN(lastObservedT) ? 0 : tSec - lastObservedT;
        if (coast > MAX_COAST_SEC) return null;
        double dt = tSec - lastT;
        return new double[] { ax.pos + ax.vel * dt, ay.pos + ay.vel * dt };
    }

    /** 예상 자리에서 얼마나 벗어났나 — 몸 높이 배수. */
    double errorOf(double cx, double cy, double tSec) {
        double[] guess = predictAt(tSec);
        if (guess == null) return Double.POSITIVE_INFINITY;
        return Math.hypot(cx - guess[0], cy - guess[1]) / Math.max(1, height);
    }

    void reset() {
        lastT = Double.NaN;
        lastObservedT = Double.NaN;
        hasLastCenter = false;
        emaReady = false;
        hasSmoothed = false;
    }
}
