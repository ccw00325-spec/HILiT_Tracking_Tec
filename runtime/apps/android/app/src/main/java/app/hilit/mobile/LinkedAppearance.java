/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e2925e1d @license @preserve */
package app.hilit.mobile;

/**
 * 검출 연결 추적이 쓰는 겉모습(세 띠 HSV 색조) — 웹 apps/web/public/tracking/hilit-appearance.js 의 describeRgba(배경 인자 없이)와
 * appearanceSimilarity 를 그대로 옮긴 것(2026-10-27, D-04). NativeTrackingEngine.HilitAppearance 는 상자 둘레를 8% 넓혀 세는 다른 계산이라
 * 웹 문턱값과 맞지 않아 따로 둔다. 점수는 신원 확률이 아니다.
 */
final class LinkedAppearance {
    static final int HUE_BINS = 12, GRAY_BINS = 4, BAND_BINS = HUE_BINS + GRAY_BINS, CROP_W = 48, CROP_H = 96;
    static final float GRAY_SAT = 0.18f;
    static final float[] BANDS = {0.25f, 0.45f, 0.30f};
    static final float[] BAND_WEIGHT = {0.8f, 2.0f, 1.0f};
    static final int SIZE = BANDS.length * BAND_BINS + BANDS.length * 2;

    private LinkedAppearance() {}

    /** rgba(0~255, 4개씩) w×h → {values, samples}. 웹 describeRgba(data, w, h) 와 같다. */
    static LinkedCore.Desc describe(int[] data, int w, int h) {
        float[] values = new float[SIZE];
        LinkedCore.Desc out = new LinkedCore.Desc();
        out.values = values; out.trust = 1;
        if (w < 4 || h < 8) { out.samples = 0; return out; }
        int x0 = (int) Math.floor(w * 0.12), x1 = (int) Math.ceil(w * 0.88);
        double cx = (x0 + x1) / 2.0, halfW = Math.max(1, (x1 - x0) / 2.0), cy = h / 2.0, halfH = Math.max(1, h / 2.0);
        double samples = 0;
        int y0 = 0;
        for (int band = 0; band < BANDS.length; band++) {
            int y1 = band == BANDS.length - 1 ? h : Math.min(h, y0 + (int) Math.round(h * (double) BANDS[band]));
            int base = band * BAND_BINS;
            double sum = 0, sumSq = 0, n = 0;
            for (int y = y0; y < y1; y++) {
                double dy = (y - cy) / halfH;
                for (int x = x0; x < x1; x++) {
                    int p = (y * w + x) * 4;
                    if (data[p + 3] < 8) continue;
                    double dx = (x - cx) / halfW;
                    double r2 = dx * dx + dy * dy * 0.35;
                    double k = r2 >= 1 ? 0 : 1 - r2;
                    if (k <= 0) continue;
                    double rr = data[p] / 255.0, gg = data[p + 1] / 255.0, bb = data[p + 2] / 255.0;
                    double max = Math.max(rr, Math.max(gg, bb)), min = Math.min(rr, Math.min(gg, bb)), d = max - min;
                    double hue = 0;
                    if (d > 1e-6) {
                        if (max == rr) hue = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
                        else if (max == gg) hue = ((bb - rr) / d + 2) / 6;
                        else hue = ((rr - gg) / d + 4) / 6;
                    }
                    double sat = max > 1e-6 ? d / max : 0;
                    if (sat < GRAY_SAT) values[base + HUE_BINS + Math.min(GRAY_BINS - 1, (int) Math.floor(max * GRAY_BINS))] += (float) k;
                    else values[base + Math.min(HUE_BINS - 1, (int) Math.floor(hue * HUE_BINS))] += (float) (sat * k);
                    sum += max * k; sumSq += max * max * k; n += k;
                }
            }
            if (n > 0) {
                double mean = sum / n;
                int stat = BANDS.length * BAND_BINS + band * 2;
                values[stat] = (float) mean;
                values[stat + 1] = (float) Math.sqrt(Math.max(0, sumSq / n - mean * mean));
                samples += n;
            }
            y0 = y1;
        }
        for (int band = 0; band < BANDS.length; band++) {
            int base = band * BAND_BINS;
            double sum = 0;
            for (int k = 0; k < BAND_BINS; k++) sum += values[base + k];
            if (sum > 0) for (int k = 0; k < BAND_BINS; k++) values[base + k] /= (float) sum;
        }
        out.samples = (int) Math.round(samples);
        return out;
    }

    /** 웹 appearanceSimilarity. 한쪽이 없으면 null, 표본이 적으면 0.5(모르겠다). */
    static Double similarity(LinkedCore.Desc a, LinkedCore.Desc b) {
        if (a == null || b == null) return null;
        if (a.samples < 60 || b.samples < 60) return 0.5;
        double total = 0, weight = 0;
        for (int band = 0; band < BANDS.length; band++) {
            int base = band * BAND_BINS;
            double inter = 0;
            for (int k = 0; k < BAND_BINS; k++) inter += Math.min(a.values[base + k], b.values[base + k]);
            total += inter * BAND_WEIGHT[band];
            weight += BAND_WEIGHT[band];
        }
        double colour = weight > 0 ? total / weight : 0;
        int statBase = BANDS.length * BAND_BINS;
        double statDiff = 0;
        for (int k = 0; k < BANDS.length * 2; k++) statDiff += Math.abs(a.values[statBase + k] - b.values[statBase + k]);
        double stat = Math.max(0, 1 - statDiff / (BANDS.length * 2));
        return Math.max(0, Math.min(1, colour * 0.9 + stat * 0.1));
    }
}
