/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·02b77ca5 @license @preserve */
package app.hilit.mobile;

/**
 * 검출 연결 추적(linked-v1)의 겉모습 단서 — 웹 apps/web/public/tracking/linked-cues.js 를 옮긴 것(2026-10-27).
 *
 * 2026-10-27 사용자 승인(추적 제안 2번, D-04 웹 엔진 통째로 이식): 색만이 아니라 밝기·윤곽까지 세고, 사용자가 고른 직후
 * 대상과 「대상 둘레 배경」·「같은 화면의 다른 사람」을 단서마다 비교해 배경·남과 갈리는 단서에 무게를 더 준다.
 * 생각은 Collins·Liu·Leordeanu(TPAMI 2005)의 것을 빌렸고 코드는 직접 썼다. 학습된 가중치·외부 데이터는 없다.
 *
 * 🔴 점수는 같은 영상 안에서 사용자가 고른 사람이 맞는지 가르는 보조 근거다. 신원 확률이 아니다. 단서는 그 영상 분석 동안
 *    메모리에만 있다. 체형 비율 같은 생체 특징은 쓰지 않는다. 웹과 값이 같아야 한다 — LinkedCoreParityTest 가 대조한다.
 */
final class LinkedCues {
    static final float[] BANDS = {0.25f, 0.45f, 0.30f};
    static final int HUE_BINS = 12, GRAY_BINS = 4, LUM_BINS = 4, TEX_DIRS = 4, TEX_BINS = 5;
    static final float GRAY_SAT = 0.18f;
    static final int HUE_LEN = HUE_BINS + GRAY_BINS, BAND_LEN = HUE_LEN + LUM_BINS + TEX_BINS;
    static final int SIZE = BANDS.length * BAND_LEN, GROUPS = BANDS.length * 3;
    static final double[] BASE = {0.8, 2.0, 1.0, 0.3, 0.6, 0.3, 0.3, 0.6, 0.3};
    static final double[] DEFAULT = normalize(BASE.clone());

    /** 웹 CUE_POLICY. */
    static final class Policy {
        double gain = 3, minFactor = 0.35, maxFactor = 2.5, selfPrior = 0.75;
        int minSamples = 60;
    }
    static final Policy POLICY = new Policy();

    static final class Cue {
        final float[] v; final int n; final boolean fg;
        Cue(float[] v, int n, boolean fg) { this.v = v; this.n = n; this.fg = fg; }
    }

    static final class Choice {
        final double[] w; final Double[] disc; final boolean adapted;
        Choice(double[] w, Double[] disc, boolean adapted) { this.w = w; this.disc = disc; this.adapted = adapted; }
    }

    private LinkedCues() {}

    private static float[] hsv(int r, int g, int b) {
        float rr = r / 255f, gg = g / 255f, bb = b / 255f;
        float max = Math.max(rr, Math.max(gg, bb)), min = Math.min(rr, Math.min(gg, bb)), d = max - min;
        float h = 0;
        if (d > 1e-6f) {
            if (max == rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6f;
            else if (max == gg) h = ((bb - rr) / d + 2) / 6f;
            else h = ((rr - gg) / d + 4) / 6f;
        }
        return new float[]{h, max > 1e-6f ? d / max : 0, max};
    }

    /**
     * rgba(바이트 4개씩, 0~255) w×h 조각의 단서. mask 는 w×h 의 0~1(없으면 null), uniform 은 가운데 가중 없이(배경 띠).
     * 웹 describeCues 와 같은 계산이다(부동소수 차이만).
     */
    static Cue describe(int[] rgba, int w, int h, float[] mask, boolean uniform) {
        float[] v = new float[SIZE];
        if (w < 4 || h < 8) return new Cue(v, 0, false);
        boolean useMask = mask != null && mask.length == w * h;
        float[] gray = new float[w * h];
        for (int i = 0; i < w * h; i++) {
            int p = i * 4;
            gray[i] = 0.299f * rgba[p] + 0.587f * rgba[p + 1] + 0.114f * rgba[p + 2];
        }
        int x0 = useMask || uniform ? 0 : (int) Math.floor(w * 0.12);
        int x1 = useMask || uniform ? w : (int) Math.ceil(w * 0.88);
        double cxm = (x0 + x1) / 2.0, halfW = Math.max(1, (x1 - x0) / 2.0), cym = h / 2.0, halfH = Math.max(1, h / 2.0);
        double n = 0;
        int y0 = 0;
        for (int band = 0; band < BANDS.length; band++) {
            int y1 = band == BANDS.length - 1 ? h : Math.min(h, y0 + (int) Math.round(h * (double) BANDS[band]));
            int base = band * BAND_LEN;
            for (int y = y0; y < y1; y++) {
                for (int x = x0; x < x1; x++) {
                    int i = y * w + x, p = i * 4;
                    if (rgba[p + 3] < 8) continue;
                    double k;
                    if (useMask) k = mask[i];
                    else if (uniform) k = 1;
                    else {
                        double dx = (x - cxm) / halfW, dy = (y - cym) / halfH;
                        double r2 = dx * dx + dy * dy * 0.35;
                        k = r2 >= 1 ? 0 : 1 - r2;
                    }
                    if (!(k > 0.02)) continue;
                    float[] hs = hsv(rgba[p], rgba[p + 1], rgba[p + 2]);
                    if (hs[1] < GRAY_SAT) v[base + HUE_BINS + Math.min(GRAY_BINS - 1, (int) Math.floor(hs[2] * GRAY_BINS))] += (float) k;
                    else v[base + Math.min(HUE_BINS - 1, (int) Math.floor(hs[0] * HUE_BINS))] += (float) (hs[1] * k);
                    v[base + HUE_LEN + Math.min(LUM_BINS - 1, (int) Math.floor(hs[2] * LUM_BINS))] += (float) k;
                    if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
                        double gx = gray[i + 1] - gray[i - 1];
                        double gy = gray[i + w] - gray[i - w];
                        double mag = Math.hypot(gx, gy);
                        int bin = TEX_DIRS;
                        if (mag > 12) {
                            double ang = Math.atan2(gy, gx);
                            if (ang < 0) ang += Math.PI;
                            bin = ((int) Math.floor((ang / Math.PI) * TEX_DIRS + 0.5)) % TEX_DIRS;
                        }
                        v[base + HUE_LEN + LUM_BINS + bin] += (float) k;
                    }
                    n += k;
                }
            }
            y0 = y1;
        }
        int[][] groups = {{0, HUE_LEN}, {HUE_LEN, LUM_BINS}, {HUE_LEN + LUM_BINS, TEX_BINS}};
        for (int band = 0; band < BANDS.length; band++) {
            int base = band * BAND_LEN;
            for (int[] g : groups) {
                double s = 0;
                for (int k = 0; k < g[1]; k++) s += v[base + g[0] + k];
                if (s > 0) for (int k = 0; k < g[1]; k++) v[base + g[0] + k] /= (float) s;
            }
        }
        return new Cue(v, (int) Math.round(n), useMask);
    }

    private static Double groupSim(float[] a, float[] b, int off, int len) {
        double sa = 0, sb = 0, inter = 0;
        for (int k = 0; k < len; k++) { sa += a[off + k]; sb += b[off + k]; inter += Math.min(a[off + k], b[off + k]); }
        return sa > 0.5 && sb > 0.5 ? inter : null;
    }

    /** 무리별 닮음(GROUPS 개, 0~1, 잴 수 없으면 null). 순서: 색조0..2, 밝기0..2, 윤곽0..2. */
    static Double[] sims(Cue a, Cue b) {
        Double[] out = new Double[GROUPS];
        if (a == null || b == null) return out;
        for (int band = 0; band < BANDS.length; band++) {
            int base = band * BAND_LEN;
            out[band] = groupSim(a.v, b.v, base, HUE_LEN);
            out[BANDS.length + band] = groupSim(a.v, b.v, base + HUE_LEN, LUM_BINS);
            out[2 * BANDS.length + band] = groupSim(a.v, b.v, base + HUE_LEN + LUM_BINS, TEX_BINS);
        }
        return out;
    }

    static Double weighted(Cue a, Cue b, double[] w) {
        Double[] s = sims(a, b);
        double t = 0, ws = 0;
        for (int g = 0; g < GROUPS; g++) { if (s[g] == null) continue; t += w[g] * s[g]; ws += w[g]; }
        return ws > 0 ? t / ws : null;
    }

    static double[] normalize(double[] w) {
        double s = 0;
        for (double x : w) s += x;
        if (s > 0) for (int i = 0; i < w.length; i++) w[i] /= s;
        return w;
    }

    private static Double mean(java.util.List<Double> list) {
        double s = 0; int n = 0;
        for (Double x : list) if (x != null && !Double.isNaN(x)) { s += x; n++; }
        return n > 0 ? s / n : null;
    }

    private static Double[] groupMean(java.util.List<Cue[]> pairs) {
        java.util.List<java.util.List<Double>> acc = new java.util.ArrayList<>();
        for (int g = 0; g < GROUPS; g++) acc.add(new java.util.ArrayList<>());
        for (Cue[] p : pairs) { Double[] s = sims(p[0], p[1]); for (int g = 0; g < GROUPS; g++) if (s[g] != null) acc.get(g).add(s[g]); }
        Double[] out = new Double[GROUPS];
        for (int g = 0; g < GROUPS; g++) out[g] = mean(acc.get(g));
        return out;
    }

    private static java.util.List<Cue> usable(java.util.List<Cue> in, int min, int cap) {
        java.util.List<Cue> out = new java.util.ArrayList<>();
        for (Cue c : in) if (c != null && c.n >= min && out.size() < cap) out.add(c);
        return out;
    }

    /** 웹 chooseCueWeights. */
    static Choice choose(java.util.List<Cue> self, java.util.List<Cue> ring, java.util.List<Cue> others, Policy p) {
        java.util.List<Cue> me = usable(self, p.minSamples, Integer.MAX_VALUE);
        if (me.isEmpty()) return new Choice(DEFAULT.clone(), null, false);
        java.util.List<Cue> rg = usable(ring, p.minSamples, Integer.MAX_VALUE);
        java.util.List<Cue> ot = usable(others, p.minSamples, 40);
        if (rg.isEmpty() && ot.isEmpty()) return new Choice(DEFAULT.clone(), null, false);
        java.util.List<Cue[]> selfPairs = new java.util.ArrayList<>();
        for (int i = 0; i < me.size(); i++) for (int j = i + 1; j < me.size(); j++) selfPairs.add(new Cue[]{me.get(i), me.get(j)});
        Double[] selfSim = new Double[GROUPS];
        if (!selfPairs.isEmpty()) selfSim = groupMean(selfPairs); else java.util.Arrays.fill(selfSim, p.selfPrior);
        Double[] bgSim = new Double[GROUPS], otSim = new Double[GROUPS];
        if (!rg.isEmpty()) { java.util.List<Cue[]> pairs = new java.util.ArrayList<>(); for (Cue a : me) for (Cue b : rg) pairs.add(new Cue[]{a, b}); bgSim = groupMean(pairs); }
        if (!ot.isEmpty()) { java.util.List<Cue[]> pairs = new java.util.ArrayList<>(); for (Cue a : me.subList(0, Math.min(4, me.size()))) for (Cue b : ot) pairs.add(new Cue[]{a, b}); otSim = groupMean(pairs); }
        Double[] disc = new Double[GROUPS];
        for (int g = 0; g < GROUPS; g++) {
            Double d = null;
            if (bgSim[g] != null) d = bgSim[g];
            if (otSim[g] != null) d = d == null ? otSim[g] : Math.max(d, otSim[g]);
            double s = selfSim[g] != null ? selfSim[g] : p.selfPrior;
            disc[g] = d == null ? null : s - d;
        }
        double dm = 0, dw = 0;
        for (int g = 0; g < GROUPS; g++) if (disc[g] != null) { dm += BASE[g] * disc[g]; dw += BASE[g]; }
        if (dw <= 0) return new Choice(DEFAULT.clone(), disc, false);
        dm /= dw;
        double[] raw = new double[GROUPS];
        for (int g = 0; g < GROUPS; g++) {
            if (disc[g] == null) { raw[g] = BASE[g]; continue; }
            double f = Math.max(p.minFactor, Math.min(p.maxFactor, 1 + p.gain * (disc[g] - dm)));
            raw[g] = BASE[g] * f;
        }
        return new Choice(normalize(raw), disc, true);
    }

    /** 잇기에서 쓰는 고친 닮음 — 웹 adjustSimilarity. */
    static Double adjust(Double base, LinkedCore.Desc a, LinkedCore.Desc b, double[] w, double gain, boolean useFg) {
        if (base == null || a == null || b == null || a.cues == null || b.cues == null) return base;
        Double ref = weighted(a.cues, b.cues, DEFAULT);
        if (ref == null) return base;
        boolean fgPair = useFg && a.cuesFg != null && b.cuesFg != null;
        Double now = fgPair ? weighted(a.cuesFg, b.cuesFg, w) : weighted(a.cues, b.cues, w);
        if (now == null) return base;
        return Math.max(0, Math.min(1, base + gain * (now - ref)));
    }
}
