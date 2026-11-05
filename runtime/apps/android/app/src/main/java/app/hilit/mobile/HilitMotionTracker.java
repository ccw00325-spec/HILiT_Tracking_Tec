/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e04f83fa @license @preserve */
package app.hilit.mobile;

import android.graphics.Bitmap;
import android.graphics.Color;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 프레임 사이 위치 추적. 가중치 없음.
 * 정본: packages/hilit-vision/src/motion-tracker.ts
 * 웹 런타임 사본: apps/web/public/tracking/hilit-motion-tracker.js
 */
final class HilitMotionTracker {
    static final float SIZE_MIN_RATIO = 0.7f;
    static final float SIZE_MAX_RATIO = 1.9f;
    static final float SIZE_UPDATE_MIN_QUALITY = 0.45f;
    static final int PYRAMID_LEVELS = 3;
    static final int SAD_COARSE_RANGE = 8;
    static final int SAD_FINE_RANGE = 2;

    static int sadCoarseRange(Float dtSec) {
        if (dtSec == null || !(dtSec > 0)) return SAD_COARSE_RANGE;
        float steps = dtSec * 12f;
        if (steps <= 1.05f) return SAD_COARSE_RANGE;
        return Math.min(16, Math.round(SAD_COARSE_RANGE * Math.min(2f, steps)));
    }
    static final int LK_WINDOW = 5;
    static final int LK_ITERS = 8;
    static final int MAX_POINTS = 40;
    static final int MIN_KEEP = 6;
    static final float MIN_CORNER_EIGEN = 0.5f;
    static final int QUALITY_FULL_KEEP = 12;
    static final float FB_PIXELS = 1.8f;
    static final float ROI_PAD = 0.6f;
    static final float ROI_MIN_PAD = 24f;

    static final class Update {
        final NativeTrackingEngine.Box box;
        final float confidence;
        final String status;
        final boolean observed;
        final int pointsUsed;
        final int pointsKept;
        final Float fbError;
        final Float scaleEvidence;
        final String reason;
        final Double frameTimestamp;
        final Double referenceTimestamp;
        Update(NativeTrackingEngine.Box box, float confidence) {
            this(box, confidence, "lost", false, 0, 0, null, null, null, null, null);
        }
        Update(NativeTrackingEngine.Box box, float confidence, String status, boolean observed,
               int pointsUsed, int pointsKept, Float fbError, Float scaleEvidence, String reason,
               Double frameTimestamp, Double referenceTimestamp) {
            this.box = box;
            this.confidence = confidence;
            this.status = status;
            this.observed = observed;
            this.pointsUsed = pointsUsed;
            this.pointsKept = pointsKept;
            this.fbError = fbError;
            this.scaleEvidence = scaleEvidence;
            this.reason = reason;
            this.frameTimestamp = frameTimestamp;
            this.referenceTimestamp = referenceTimestamp;
        }
    }

    static final class Gray {
        final float[] data;
        final int width, height;
        Gray(float[] data, int width, int height) {
            this.data = data; this.width = width; this.height = height;
        }
    }

    static final class Pt {
        float x, y;
        Pt(float x, float y) { this.x = x; this.y = y; }
    }

    static final class Pair {
        final float px, py, nx, ny, fb;
        Pair(float px, float py, float nx, float ny, float fb) {
            this.px = px; this.py = py; this.nx = nx; this.ny = ny; this.fb = fb;
        }
    }

    static final class Rect {
        final int ox, oy, width, height;
        Rect(int ox, int oy, int width, int height) {
            this.ox = ox; this.oy = oy; this.width = width; this.height = height;
        }
    }

    private Gray prev;
    private final List<Pt> points = new ArrayList<>();
    private NativeTrackingEngine.Box box;
    float w0, h0;
    private float lastSig;
    private Double refTime;

    void init(Bitmap bitmap, NativeTrackingEngine.Box start) {
        init(toGray(bitmap), start, 0d);
    }

    void init(Gray gray, NativeTrackingEngine.Box start, Double timeSec) {
        this.prev = gray;
        this.box = start.copy();
        this.w0 = start.w;
        this.h0 = start.h;
        this.points.clear();
        this.points.addAll(selectPoints(gray, start));
        this.lastSig = signature(gray);
        this.refTime = timeSec;
    }

    void adoptFrame(Gray gray, Double timeSec) {
        this.prev = gray;
        this.lastSig = signature(gray);
        this.refTime = timeSec;
        if (this.box != null) {
            this.points.clear();
            this.points.addAll(selectPoints(gray, this.box));
        }
    }

    void reset() {
        this.prev = null;
        this.points.clear();
        this.box = null;
        this.w0 = 0;
        this.h0 = 0;
        this.lastSig = 0;
        this.refTime = null;
    }

    Update update(Bitmap bitmap) {
        return update(toGray(bitmap), null);
    }

    Update update(Bitmap bitmap, Double timeSec) {
        return update(toGray(bitmap), timeSec);
    }

    Update update(Gray gray, Double timeSec) {
        if (box == null) {
            return empty("not_initialized", timeSec, new NativeTrackingEngine.Box(0, 0, 1, 1), 0, "lost", false, 0, 0, null, null);
        }
        if (prev == null) {
            adoptFrame(gray, timeSec);
            return empty("reference_adopted", timeSec, box.copy(), 0.35f, "degraded", false, points.size(), points.size(), null, null);
        }
        float sig = signature(gray);
        if (sig == lastSig) {
            return empty("duplicate_frame", timeSec, box.copy(), 0.35f, "degraded", false, points.size(), points.size(), 0f, null);
        }
        Float dt = (timeSec != null && refTime != null) ? Math.max(0f, (float)(timeSec - refTime)) : null;
        if (points.size() < 4) {
            points.clear();
            points.addAll(selectPoints(prev, box));
        }
        int selected = points.size();
        Rect region = roiRect(prev, box);
        Gray prevRoi = cropGray(prev, region);
        Gray nextRoi = cropGray(gray, region);
        List<Pt> local = new ArrayList<>();
        for (Pt p : points) local.add(new Pt(p.x - region.ox, p.y - region.oy));
        List<Gray> prevPyr = buildPyramid(prevRoi);
        List<Gray> nextPyr = buildPyramid(nextRoi);
        List<Pair> localPairs = trackForwardBack(prevPyr, nextPyr, local, dt);
        List<Pair> pairs = new ArrayList<>();
        for (Pair p : localPairs) {
            pairs.add(new Pair(p.px + region.ox, p.py + region.oy, p.nx + region.ox, p.ny + region.oy, p.fb));
        }
        Motion motion = estimateMotion(pairs, box);
        float quality = motionQuality(selected, motion.kept.size(), motion.fb);
        String status = "tracked";
        boolean observed = true;
        String reason = null;
        NativeTrackingEngine.Box nextBox = box;
        if (motion.kept.size() < 1) {
            status = "lost";
            observed = false;
            reason = "too_few_points";
        } else if (quality < 0.22f || motion.kept.size() < MIN_KEEP) {
            status = "degraded";
            nextBox = applyMotion(box, motion, quality, w0, h0, gray.width, gray.height, dt);
            reason = "weak_observation";
        } else {
            nextBox = applyMotion(box, motion, quality, w0, h0, gray.width, gray.height, dt);
        }
        if (!"lost".equals(status)) {
            box = nextBox;
            prev = gray;
            lastSig = sig;
            refTime = timeSec;
            points.clear();
            for (Pair p : motion.kept) points.add(new Pt(p.nx, p.ny));
            if (points.size() < 12) {
                List<Pt> extra = selectPoints(gray, box);
                if (!extra.isEmpty()) {
                    points.clear();
                    points.addAll(extra);
                }
            }
        } else {
            prev = gray;
            lastSig = sig;
            refTime = timeSec;
            points.clear();
            points.addAll(selectPoints(gray, box));
        }
        float conf = "lost".equals(status) ? Math.min(quality, 0.12f) : quality;
        NativeTrackingEngine.Box out = "lost".equals(status) ? box : nextBox;
        return new Update(
            new NativeTrackingEngine.Box(Math.round(out.x), Math.round(out.y), Math.round(out.w), Math.round(out.h)),
            conf, status, observed, selected, motion.kept.size(), motion.fb, motion.scale, reason, timeSec, refTime);
    }

    private Update empty(String reason, Double timeSec, NativeTrackingEngine.Box out,
                         float confidence, String status, boolean observed,
                         int pointsUsed, int pointsKept, Float fbError, Float scaleEvidence) {
        return new Update(out, confidence, status, observed, pointsUsed, pointsKept,
            fbError, scaleEvidence, reason, timeSec, this.refTime);
    }

    void reposition(NativeTrackingEngine.Box next) {
        reposition(next, false);
    }

    void reposition(NativeTrackingEngine.Box next, boolean trustSize) {
        float baseW = w0 > 0 ? w0 : next.w;
        float baseH = h0 > 0 ? h0 : next.h;
        if (w0 <= 0) w0 = next.w;
        if (h0 <= 0) h0 = next.h;
        float w = trustSize ? clampSize(next.w, baseW) : next.w;
        float h = trustSize ? clampSize(next.h, baseH) : next.h;
        box = new NativeTrackingEngine.Box(next.x, next.y, w, h);
        points.clear();
        if (prev != null) points.addAll(selectPoints(prev, box));
    }

    static Gray toGray(Bitmap bitmap) {
        int w = bitmap.getWidth(), h = bitmap.getHeight();
        int[] px = new int[w * h];
        bitmap.getPixels(px, 0, w, 0, 0, w, h);
        float[] data = new float[w * h];
        for (int i = 0; i < px.length; i++) {
            int v = px[i];
            data[i] = 0.299f * Color.red(v) + 0.587f * Color.green(v) + 0.114f * Color.blue(v);
        }
        return new Gray(data, w, h);
    }

    static float sample(Gray img, float x, float y) {
        if (x < 0 || y < 0 || x >= img.width - 1 || y >= img.height - 1) return Float.NaN;
        int x0 = (int) Math.floor(x), y0 = (int) Math.floor(y);
        float dx = x - x0, dy = y - y0;
        int i = y0 * img.width + x0;
        return (1 - dx) * (1 - dy) * img.data[i]
            + dx * (1 - dy) * img.data[i + 1]
            + (1 - dx) * dy * img.data[i + img.width]
            + dx * dy * img.data[i + img.width + 1];
    }

    static Gray downsample(Gray src) {
        int w = Math.max(2, src.width / 2), h = Math.max(2, src.height / 2);
        float[] data = new float[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int x0 = x * 2, y0 = y * 2, i = y0 * src.width + x0;
                float s = src.data[i]; int n = 1;
                if (x0 + 1 < src.width) { s += src.data[i + 1]; n++; }
                if (y0 + 1 < src.height) { s += src.data[i + src.width]; n++; }
                if (x0 + 1 < src.width && y0 + 1 < src.height) { s += src.data[i + src.width + 1]; n++; }
                data[y * w + x] = s / n;
            }
        }
        return new Gray(data, w, h);
    }

    static List<Gray> buildPyramid(Gray src) {
        List<Gray> pyr = new ArrayList<>();
        pyr.add(src);
        for (int i = 1; i < PYRAMID_LEVELS; i++) {
            Gray cur = pyr.get(i - 1);
            if (cur.width < 64 || cur.height < 64) break;
            pyr.add(downsample(cur));
        }
        return pyr;
    }

    static float minEigen(Gray img, float x, float y) {
        int r = 2; float ixx = 0, iyy = 0, ixy = 0; int n = 0;
        for (int dy = -r; dy <= r; dy++) {
            for (int dx = -r; dx <= r; dx++) {
                float gx = sample(img, x + dx + 1, y + dy) - sample(img, x + dx - 1, y + dy);
                float gy = sample(img, x + dx, y + dy + 1) - sample(img, x + dx, y + dy - 1);
                if (!Float.isFinite(gx) || !Float.isFinite(gy)) continue;
                ixx += gx * gx; iyy += gy * gy; ixy += gx * gy; n++;
            }
        }
        if (n < 8) return 0;
        float tr = ixx + iyy, det = ixx * iyy - ixy * ixy;
        float disc = Math.max(0, tr * tr - 4 * det);
        return 0.5f * (tr - (float) Math.sqrt(disc));
    }

    static Rect roiRect(Gray img, NativeTrackingEngine.Box box) {
        float px = Math.max(ROI_MIN_PAD, box.w * ROI_PAD);
        float py = Math.max(ROI_MIN_PAD, box.h * ROI_PAD);
        int x0 = Math.max(0, (int) Math.floor(box.x - px));
        int y0 = Math.max(0, (int) Math.floor(box.y - py));
        int x1 = Math.min(img.width, (int) Math.ceil(box.x + box.w + px));
        int y1 = Math.min(img.height, (int) Math.ceil(box.y + box.h + py));
        return new Rect(x0, y0, Math.max(8, x1 - x0), Math.max(8, y1 - y0));
    }

    static Gray cropGray(Gray img, Rect r) {
        float[] data = new float[r.width * r.height];
        for (int y = 0; y < r.height; y++) {
            int srcY = r.oy + y;
            if (srcY < 0 || srcY >= img.height) continue;
            int srcX = Math.max(0, r.ox);
            int copy = Math.min(r.width, img.width - srcX);
            if (copy <= 0) continue;
            System.arraycopy(img.data, srcY * img.width + srcX, data, y * r.width + (srcX - r.ox), copy);
        }
        return new Gray(data, r.width, r.height);
    }

    static List<Pt> selectPoints(Gray img, NativeTrackingEngine.Box box) {
        float inner = 0.16f;
        float x0 = box.x + box.w * inner, y0 = box.y + box.h * inner;
        float x1 = box.x + box.w * (1 - inner), y1 = box.y + box.h * (1 - inner);
        int gw = 8, gh = 6;
        List<Pt> pts = new ArrayList<>();
        List<Float> scores = new ArrayList<>();
        for (int gy = 0; gy < gh; gy++) {
            for (int gx = 0; gx < gw; gx++) {
                float cx0 = x0 + (x1 - x0) * gx / gw;
                float cy0 = y0 + (y1 - y0) * gy / gh;
                float cx1 = x0 + (x1 - x0) * (gx + 1) / gw;
                float cy1 = y0 + (y1 - y0) * (gy + 1) / gh;
                float best = 0, bx = (cx0 + cx1) / 2, by = (cy0 + cy1) / 2;
                for (int s = 0; s < 4; s++) {
                    float x = cx0 + (cx1 - cx0) * ((s % 2) + 0.5f) / 2;
                    float y = cy0 + (cy1 - cy0) * (s / 2 + 0.5f) / 2;
                    float e = minEigen(img, x, y);
                    if (e > best) { best = e; bx = x; by = y; }
                }
                if (best > MIN_CORNER_EIGEN) { pts.add(new Pt(bx, by)); scores.add(best); }
            }
        }
        Integer[] order = new Integer[pts.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> Float.compare(scores.get(b), scores.get(a)));
        List<Pt> out = new ArrayList<>();
        for (int i = 0; i < Math.min(MAX_POINTS, order.length); i++) out.add(pts.get(order[i]));
        return out;
    }

    static float patchSad(Gray a, Gray b, float x0, float y0, float x1, float y1, int half) {
        float s = 0; int n = 0;
        for (int dy = -half; dy <= half; dy++) {
            for (int dx = -half; dx <= half; dx++) {
                float va = sample(a, x0 + dx, y0 + dy);
                float vb = sample(b, x1 + dx, y1 + dy);
                if (!Float.isFinite(va) || !Float.isFinite(vb)) continue;
                s += Math.abs(va - vb); n++;
            }
        }
        return n < 8 ? Float.POSITIVE_INFINITY : s / n;
    }

    static Pt trackPoint(List<Gray> prev, List<Gray> next, float px, float py) {
        return trackPoint(prev, next, px, py, SAD_COARSE_RANGE);
    }

    static Pt trackPoint(List<Gray> prev, List<Gray> next, float px, float py, int coarseRange) {
        float x = (float) (px / Math.pow(2, prev.size() - 1));
        float y = (float) (py / Math.pow(2, prev.size() - 1));
        int half = LK_WINDOW / 2;
        boolean finestOk = false;
        for (int level = prev.size() - 1; level >= 0; level--) {
            Gray a = prev.get(level), b = next.get(level);
            float referenceX = (float) (px / Math.pow(2, level));
            float referenceY = (float) (py / Math.pow(2, level));
            if (level < prev.size() - 1) { x *= 2; y *= 2; }
            int range = level == prev.size() - 1 ? coarseRange : SAD_FINE_RANGE;
            float best = patchSad(a, b, referenceX, referenceY, x, y, half);
            float bx = x, by = y;
            for (int dy = -range; dy <= range; dy++) {
                for (int dx = -range; dx <= range; dx++) {
                    if (dx == 0 && dy == 0) continue;
                    float s = patchSad(a, b, referenceX, referenceY, x + dx, y + dy, half);
                    if (s < best) { best = s; bx = x + dx; by = y + dy; }
                }
            }
            if (!Float.isFinite(best)) continue;
            x = bx; y = by;
            for (int iter = 0; iter < 3; iter++) {
                float ixx = 0, iyy = 0, ixy = 0, ixt = 0, iyt = 0; int n = 0;
                for (int dy = -half; dy <= half; dy++) {
                    for (int dx = -half; dx <= half; dx++) {
                        float sx = referenceX + dx, sy = referenceY + dy;
                        float ia = sample(a, sx, sy), ib = sample(b, x + dx, y + dy);
                        float gx = 0.5f * (sample(a, sx + 1, sy) - sample(a, sx - 1, sy));
                        float gy = 0.5f * (sample(a, sx, sy + 1) - sample(a, sx, sy - 1));
                        if (!Float.isFinite(ia) || !Float.isFinite(ib) || !Float.isFinite(gx) || !Float.isFinite(gy)) continue;
                        float it = ib - ia;
                        ixx += gx * gx; iyy += gy * gy; ixy += gx * gy;
                        ixt += gx * it; iyt += gy * it; n++;
                    }
                }
                float det = ixx * iyy - ixy * ixy;
                if (n < 8 || Math.abs(det) < 1e-2f) break;
                float dx = (iyy * -ixt - ixy * -iyt) / det;
                float dy = (ixx * -iyt - ixy * -ixt) / det;
                if (!Float.isFinite(dx) || dx * dx + dy * dy > 2.25f) break;
                dx = Math.max(-0.6f, Math.min(0.6f, dx));
                dy = Math.max(-0.6f, Math.min(0.6f, dy));
                x += dx; y += dy;
                if (dx * dx + dy * dy < 0.0004f) break;
            }
            if (level == 0) finestOk = true;
        }
        if (!finestOk || !Float.isFinite(x) || !Float.isFinite(y)) return null;
        return new Pt(x, y);
    }

    static List<Pair> trackForwardBack(List<Gray> prev, List<Gray> next, List<Pt> points) {
        return trackForwardBack(prev, next, points, null);
    }

    static List<Pair> trackForwardBack(List<Gray> prev, List<Gray> next, List<Pt> points, Float dtSec) {
        int coarse = sadCoarseRange(dtSec);
        List<Pair> out = new ArrayList<>();
        for (Pt p : points) {
            Pt f = trackPoint(prev, next, p.x, p.y, coarse);
            if (f == null) continue;
            Pt b = trackPoint(next, prev, f.x, f.y, coarse);
            if (b == null) continue;
            float fb = (float) Math.hypot(b.x - p.x, b.y - p.y);
            out.add(new Pair(p.x, p.y, f.x, f.y, fb));
        }
        return out;
    }

    static Float median(List<Float> values) {
        if (values.isEmpty()) return null;
        List<Float> s = new ArrayList<>(values);
        Collections.sort(s);
        int m = s.size() / 2;
        return s.size() % 2 == 1 ? s.get(m) : 0.5f * (s.get(m - 1) + s.get(m));
    }

    static final class Motion {
        final float dx, dy; final Float scale; final List<Pair> kept; final Float fb;
        Motion(float dx, float dy, Float scale, List<Pair> kept, Float fb) {
            this.dx = dx; this.dy = dy; this.scale = scale; this.kept = kept; this.fb = fb;
        }
    }

    static Motion estimateMotion(List<Pair> pairs) {
        return estimateMotion(pairs, null);
    }

    static Motion estimateMotion(List<Pair> pairs, NativeTrackingEngine.Box box) {
        List<Pair> ok = new ArrayList<>();
        for (Pair p : pairs) if (p.fb <= FB_PIXELS) ok.add(p);
        List<Float> dxs = new ArrayList<>(), dys = new ArrayList<>();
        for (Pair p : ok) { dxs.add(p.nx - p.px); dys.add(p.ny - p.py); }
        float dx = median(dxs) == null ? 0 : median(dxs);
        float dy = median(dys) == null ? 0 : median(dys);
        List<Pair> resid = new ArrayList<>();
        for (Pair p : ok) {
            if (Math.hypot((p.nx - p.px) - dx, (p.ny - p.py) - dy) < 3.5) resid.add(p);
        }
        List<Pair> use = resid.isEmpty() ? ok : resid;
        if (box != null && use.size() >= 6) {
            float cx = box.x + box.w / 2f, cy = box.y + box.h / 2f;
            float hx = Math.max(1f, box.w / 2f), hy = Math.max(1f, box.h / 2f);
            List<Pair> inner = new ArrayList<>();
            for (Pair p : use) {
                float nx = Math.abs(p.px - cx) / hx;
                float ny = Math.abs(p.py - cy) / hy;
                if (Math.max(nx, ny) <= 0.62f) inner.add(p);
            }
            if (inner.size() >= 4) use = inner;
        }
        List<Float> dx2s = new ArrayList<>(), dy2s = new ArrayList<>();
        for (Pair p : use) { dx2s.add(p.nx - p.px); dy2s.add(p.ny - p.py); }
        float dx2 = median(dx2s) == null ? dx : median(dx2s);
        float dy2 = median(dy2s) == null ? dy : median(dy2s);
        Float scale = null;
        if (use.size() >= 10) {
            List<Float> ratios = new ArrayList<>();
            for (int i = 0; i < use.size(); i++) {
                for (int j = i + 1; j < Math.min(use.size(), i + 6); j++) {
                    float d0 = (float) Math.hypot(use.get(i).px - use.get(j).px, use.get(i).py - use.get(j).py);
                    float d1 = (float) Math.hypot(use.get(i).nx - use.get(j).nx, use.get(i).ny - use.get(j).ny);
                    if (d0 > 8) ratios.add(d1 / d0);
                }
            }
            Float s = median(ratios);
            if (s != null && s > 0.85f && s < 1.18f) scale = s;
        }
        List<Float> fbs = new ArrayList<>();
        for (Pair p : use) fbs.add(p.fb);
        return new Motion(dx2, dy2, scale, use, median(fbs));
    }

    static float clampSize(float v, float base) {
        return Math.min(Math.max(v, base * SIZE_MIN_RATIO), base * SIZE_MAX_RATIO);
    }

    static NativeTrackingEngine.Box applyMotion(NativeTrackingEngine.Box box, Motion motion,
            float quality, float w0, float h0, int frameW, int frameH) {
        return applyMotion(box, motion, quality, w0, h0, frameW, frameH, null);
    }

    static NativeTrackingEngine.Box applyMotion(NativeTrackingEngine.Box box, Motion motion,
            float quality, float w0, float h0, int frameW, int frameH, Float dtSec) {
        float w = box.w, h = box.h;
        if (motion.scale != null && quality >= SIZE_UPDATE_MIN_QUALITY) {
            float frames = (dtSec != null && dtSec > 0) ? Math.min(4f, Math.max(0.25f, dtSec * 12f)) : 1f;
            float s = Math.min((float) Math.pow(1.03, frames), Math.max((float) Math.pow(0.97, frames), motion.scale));
            w = clampSize(w * s, w0);
            h = clampSize(h * s, h0);
        }
        float cx = box.x + box.w / 2 + motion.dx;
        float cy = box.y + box.h / 2 + motion.dy;
        float x = Math.min(Math.max(cx - w / 2, -w * 0.45f), frameW - w * 0.55f);
        float y = Math.min(Math.max(cy - h / 2, -h * 0.45f), frameH - h * 0.55f);
        return new NativeTrackingEngine.Box(
            x, y, Math.min(Math.max(w, 8), frameW), Math.min(Math.max(h, 8), frameH));
    }

    static float motionQuality(int selected, int kept, Float fb) {
        if (selected <= 0) return 0;
        float support = Math.min(1f, kept / (float) QUALITY_FULL_KEEP);
        float fbTerm = fb == null ? 0 : (float) Math.exp(-fb / 2);
        float q = 0.55f * support + 0.45f * fbTerm;
        if (kept < 4) q = Math.min(q, 0.12f);
        else if (kept < MIN_KEEP) q = Math.min(q, 0.28f);
        return Math.max(0, Math.min(1, q));
    }

    static float signature(Gray gray) {
        float s = gray.width * 1e6f + gray.height;
        int stepX = Math.max(1, gray.width / 48);
        int stepY = Math.max(1, gray.height / 48);
        for (int y = 0; y < gray.height; y += stepY) {
            for (int x = 0; x < gray.width; x += stepX) {
                s += gray.data[y * gray.width + x] * (x + 1) + (y + 1) * 0.013f;
            }
        }
        return s;
    }
}
