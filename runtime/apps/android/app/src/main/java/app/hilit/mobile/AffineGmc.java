/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b61f37f6 @license @preserve */
package app.hilit.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * HILIT Affine GMC — packages/hilit-vision/src/affine-gmc.ts 의 Java 사본.
 * OpenCV·BoT-SORT 코드를 가져오지 않았다. 가중치가 없다.
 * 예측 상자만 배경 좌표로 옮긴다. 동일인을 확정하지 않는다.
 */
final class AffineGmc {
    static final String METHOD_ID = "hilit-affine-gmc-v1";
    static final int GRID_W = 80;
    static final int GRID_H = 48;
    static final int SEARCH = 6;
    static final int MIN_INLIERS = 8;
    static final float FB_PX = 1.6f;
    static final float MAX_SCALE = 1.18f;
    static final float MIN_SCALE = 0.84f;
    static final float MAX_ROT_RAD = 0.18f;

    /* 근거 게이트 — packages/hilit-vision/src/gmc-verification.ts 와 같은 값이다.
       세 사본(TS·브라우저 JS·여기)을 scripts/check-android-tracking-parity.mjs 가 맞춘다. */
    static final float MAX_RESIDUAL_P90 = 0.08f;
    static final int MIN_GRID_CELLS = 9;
    static final float MIN_INLIER_RATIO = 0.9f;
    static final int MIN_INLIER_COUNT = 12;
    static final float MAX_RIVAL_SUPPORT = 0.6f;
    static final float MIN_BACKGROUND_SHARE = 0.42f;

    /** 변환을 믿어도 되는지 판단할 때 쓰는 근거. 동일인 판정 근거가 아니다. */
    static final class Diagnostics {
        final int inlierCount, candidatePairs, gridCells, gridCellsTotal;
        final float inlierRatio, residualP50, residualP90, rivalSupportRatio, backgroundShare;
        Diagnostics(int inlierCount, int candidatePairs, float inlierRatio, int gridCells,
                    int gridCellsTotal, float residualP50, float residualP90,
                    float rivalSupportRatio, float backgroundShare) {
            this.inlierCount = inlierCount;
            this.candidatePairs = candidatePairs;
            this.inlierRatio = inlierRatio;
            this.gridCells = gridCells;
            this.gridCellsTotal = gridCellsTotal;
            this.residualP50 = residualP50;
            this.residualP90 = residualP90;
            this.rivalSupportRatio = rivalSupportRatio;
            this.backgroundShare = backgroundShare;
        }
        static Diagnostics empty(float share) {
            return new Diagnostics(0, 0, 0, 0, 12, Float.POSITIVE_INFINITY,
                    Float.POSITIVE_INFINITY, 1, share);
        }
    }

    static final class Affine {
        final float a, b, tx, c, d, ty;
        Affine(float a, float b, float tx, float c, float d, float ty) {
            this.a = a; this.b = b; this.tx = tx; this.c = c; this.d = d; this.ty = ty;
        }
        static Affine identity() { return new Affine(1, 0, 0, 0, 1, 0); }
        boolean isFinite() {
            return finite(a) && finite(b) && finite(tx) && finite(c) && finite(d) && finite(ty);
        }
        boolean isIdentity() {
            return a == 1 && b == 0 && c == 0 && d == 1 && tx == 0 && ty == 0;
        }
    }

    static final class Box {
        final float x, y, width, height;
        Box(float x, float y, float width, float height) {
            this.x = x; this.y = y; this.width = width; this.height = height;
        }
    }

    static final class Result {
        final String method;
        final boolean usable;
        final float quality;
        final String reason;
        final Affine affine;
        final float dxPx, dyPx, scale, rotationRad;
        /** RANSAC 인라이어가 아니라 왕복 검사를 통과한 후보 대응 수다.
            인라이어 수는 diagnostics.inlierCount 를 쓴다. */
        final int inliers;
        final float backgroundShare;
        final Diagnostics diagnostics;
        Result(boolean usable, float quality, String reason, Affine affine,
               float dxPx, float dyPx, float scale, float rotationRad,
               int inliers, float backgroundShare) {
            this(usable, quality, reason, affine, dxPx, dyPx, scale, rotationRad,
                    inliers, backgroundShare, Diagnostics.empty(backgroundShare));
        }
        Result(boolean usable, float quality, String reason, Affine affine,
               float dxPx, float dyPx, float scale, float rotationRad,
               int inliers, float backgroundShare, Diagnostics diagnostics) {
            this.diagnostics = diagnostics;
            this.method = METHOD_ID;
            this.usable = usable;
            this.quality = quality;
            this.reason = reason;
            this.affine = affine;
            this.dxPx = dxPx;
            this.dyPx = dyPx;
            this.scale = scale;
            this.rotationRad = rotationRad;
            this.inliers = inliers;
            this.backgroundShare = backgroundShare;
        }
    }

    static Result identity(String reason, float backgroundShare) {
        return new Result(false, 0, reason, Affine.identity(), 0, 0, 1, 0, 0, backgroundShare);
    }

    static int[] fromFloatGray(float[] data) {
        int[] out = new int[data.length];
        for (int i = 0; i < data.length; i++) {
            out[i] = Math.round(Math.max(0, Math.min(255, data[i])));
        }
        return out;
    }

    static int[] downsampleGray(int[] gray, int srcW, int srcH, int dstW, int dstH) {
        int[] out = new int[dstW * dstH];
        for (int y = 0; y < dstH; y++) {
            int y0 = (int) Math.floor((y * (double) srcH) / dstH);
            int y1 = Math.max(y0 + 1, (int) Math.floor(((y + 1) * (double) srcH) / dstH));
            for (int x = 0; x < dstW; x++) {
                int x0 = (int) Math.floor((x * (double) srcW) / dstW);
                int x1 = Math.max(x0 + 1, (int) Math.floor(((x + 1) * (double) srcW) / dstW));
                int sum = 0, n = 0;
                for (int sy = y0; sy < y1 && sy < srcH; sy++) {
                    int row = sy * srcW;
                    for (int sx = x0; sx < x1 && sx < srcW; sx++) {
                        sum += gray[row + sx];
                        n++;
                    }
                }
                out[y * dstW + x] = n == 0 ? 0 : Math.round(sum / (float) n);
            }
        }
        return out;
    }

    static byte[] personMask(Box[] boxes, int srcW, int srcH, int dstW, int dstH) {
        byte[] mask = new byte[dstW * dstH];
        java.util.Arrays.fill(mask, (byte) 1);
        if (boxes == null) return mask;
        for (Box box : boxes) {
            if (box == null || !finite(box.x) || !finite(box.y) || !finite(box.width) || !finite(box.height)) continue;
            int x0 = Math.max(0, (int) Math.floor((box.x / srcW) * dstW));
            int y0 = Math.max(0, (int) Math.floor((box.y / srcH) * dstH));
            int x1 = Math.min(dstW, (int) Math.ceil(((box.x + box.width) / srcW) * dstW));
            int y1 = Math.min(dstH, (int) Math.ceil(((box.y + box.height) / srcH) * dstH));
            for (int y = y0; y < y1; y++) {
                for (int x = x0; x < x1; x++) mask[y * dstW + x] = 0;
            }
        }
        return mask;
    }

    private static float sample(int[] img, int w, int h, float x, float y) {
        if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return Float.NaN;
        int x0 = (int) Math.floor(x), y0 = (int) Math.floor(y);
        float dx = x - x0, dy = y - y0;
        int i = y0 * w + x0;
        return (1 - dx) * (1 - dy) * img[i]
            + dx * (1 - dy) * img[i + 1]
            + (1 - dx) * dy * img[i + w]
            + dx * dy * img[i + w + 1];
    }

    private static float minEigen(int[] img, int w, int h, float x, float y) {
        float ixx = 0, iyy = 0, ixy = 0;
        int n = 0;
        for (int dy = -2; dy <= 2; dy++) {
            for (int dx = -2; dx <= 2; dx++) {
                float gx = sample(img, w, h, x + dx + 1, y + dy) - sample(img, w, h, x + dx - 1, y + dy);
                float gy = sample(img, w, h, x + dx, y + dy + 1) - sample(img, w, h, x + dx, y + dy - 1);
                if (!finite(gx) || !finite(gy)) continue;
                ixx += gx * gx;
                iyy += gy * gy;
                ixy += gx * gy;
                n++;
            }
        }
        if (n < 8) return 0;
        float tr = ixx + iyy;
        float det = ixx * iyy - ixy * ixy;
        return 0.5f * (tr - (float) Math.sqrt(Math.max(0, tr * tr - 4 * det)));
    }

    private static float patchSad(int[] a, int[] b, int w, int h, float ax, float ay, float bx, float by, int rad) {
        float sum = 0;
        int n = 0;
        for (int dy = -rad; dy <= rad; dy++) {
            for (int dx = -rad; dx <= rad; dx++) {
                float va = sample(a, w, h, ax + dx, ay + dy);
                float vb = sample(b, w, h, bx + dx, by + dy);
                if (!finite(va) || !finite(vb)) continue;
                sum += Math.abs(va - vb);
                n++;
            }
        }
        return n < 9 ? Float.POSITIVE_INFINITY : sum / n;
    }

    private static float[] trackPoint(int[] prev, int[] next, int w, int h, float x, float y) {
        float bestX = x, bestY = y, best = Float.POSITIVE_INFINITY;
        for (int oy = -SEARCH; oy <= SEARCH; oy++) {
            for (int ox = -SEARCH; ox <= SEARCH; ox++) {
                float sad = patchSad(prev, next, w, h, x, y, x + ox, y + oy, 2);
                if (sad < best) {
                    best = sad;
                    bestX = x + ox;
                    bestY = y + oy;
                }
            }
        }
        if (!finite(best) || best > 48) return null;
        return new float[]{bestX, bestY, best};
    }

    private static Affine solveAffine(List<float[]> pairs) {
        if (pairs.size() < 3) return null;
        double sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = pairs.size();
        double sux = 0, suy = 0, su = 0, svx = 0, svy = 0, sv = 0;
        for (float[] p : pairs) {
            sxx += p[0] * p[0];
            sxy += p[0] * p[1];
            sx += p[0];
            syy += p[1] * p[1];
            sy += p[1];
            sux += p[2] * p[0];
            suy += p[2] * p[1];
            su += p[2];
            svx += p[3] * p[0];
            svy += p[3] * p[1];
            sv += p[3];
        }
        double[] rowX = solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n, sux, suy, su);
        double[] rowY = solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n, svx, svy, sv);
        if (rowX == null || rowY == null) return null;
        return new Affine((float) rowX[0], (float) rowX[1], (float) rowX[2],
            (float) rowY[0], (float) rowY[1], (float) rowY[2]);
    }

    private static double[] solve3(
        double a00, double a01, double a02,
        double a10, double a11, double a12,
        double a20, double a21, double a22,
        double b0, double b1, double b2
    ) {
        double det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
        if (!Double.isFinite(det) || Math.abs(det) < 1e-8) return null;
        double inv = 1 / det;
        double c00 = (a11 * a22 - a12 * a21) * inv;
        double c01 = (a02 * a21 - a01 * a22) * inv;
        double c02 = (a01 * a12 - a02 * a11) * inv;
        double c10 = (a12 * a20 - a10 * a22) * inv;
        double c11 = (a00 * a22 - a02 * a20) * inv;
        double c12 = (a02 * a10 - a00 * a12) * inv;
        double c20 = (a10 * a21 - a11 * a20) * inv;
        double c21 = (a01 * a20 - a00 * a21) * inv;
        double c22 = (a00 * a11 - a01 * a10) * inv;
        return new double[]{
            c00 * b0 + c01 * b1 + c02 * b2,
            c10 * b0 + c11 * b1 + c12 * b2,
            c20 * b0 + c21 * b1 + c22 * b2,
        };
    }

    static float[] applyPt(Affine A, float x, float y) {
        return new float[]{A.a * x + A.b * y + A.tx, A.c * x + A.d * y + A.ty};
    }

    private static float residual(Affine A, List<float[]> pairs) {
        float s = 0;
        for (float[] p : pairs) {
            float[] q = applyPt(A, p[0], p[1]);
            s += (float) Math.hypot(q[0] - p[2], q[1] - p[3]);
        }
        return s / Math.max(1, pairs.size());
    }

    static Box applyToBox(Box box, Affine A) {
        float[] c = applyPt(A, box.x + box.width / 2, box.y + box.height / 2);
        float scale = (float) Math.sqrt(Math.abs(A.a * A.d - A.b * A.c));
        float s = finite(scale) && scale > 0.2f ? scale : 1;
        return new Box(c[0] - (box.width * s) / 2, c[1] - (box.height * s) / 2, box.width * s, box.height * s);
    }

    static float[] affineToMotion(Affine A, int width, int height) {
        float[] mid = applyPt(A, width / 2f, height / 2f);
        float scale = (float) Math.sqrt(Math.abs(A.a * A.d - A.b * A.c));
        float rotationRad = (float) Math.atan2(A.c, A.a);
        return new float[]{
            mid[0] - width / 2f,
            mid[1] - height / 2f,
            finite(scale) && scale > 0.2f ? scale : 1,
            finite(rotationRad) ? rotationRad : 0,
        };
    }

    static Result estimate(int[] prevGray, int[] nextGray, int width, int height, Box[] excludeBoxes) {
        if (width < 16 || height < 16) return identity("frame-too-small", 1);
        int[] prev = downsampleGray(prevGray, width, height, GRID_W, GRID_H);
        int[] next = downsampleGray(nextGray, width, height, GRID_W, GRID_H);
        byte[] mask = excludeBoxes != null && excludeBoxes.length > 0
            ? personMask(excludeBoxes, width, height, GRID_W, GRID_H)
            : null;
        int bg = 0;
        for (int i = 0; i < prev.length; i++) if (mask == null || mask[i] != 0) bg++;
        float share = bg / (float) prev.length;
        if (share < 0.42f) return identity("person_fills", share);

        List<float[]> pts = new ArrayList<>();
        for (int y = 6; y < GRID_H - 6; y += 5) {
            for (int x = 6; x < GRID_W - 6; x += 5) {
                if (mask != null && mask[y * GRID_W + x] == 0) continue;
                float score = minEigen(prev, GRID_W, GRID_H, x, y);
                if (score < 18) continue;
                pts.add(new float[]{x, y, score});
            }
        }
        Collections.sort(pts, new Comparator<float[]>() {
            @Override public int compare(float[] a, float[] b) { return Float.compare(b[2], a[2]); }
        });
        if (pts.size() > 48) pts = pts.subList(0, 48);
        if (pts.size() < MIN_INLIERS) return identity("too-few-corners", share);

        List<float[]> pairs = new ArrayList<>();
        for (float[] p : pts) {
            float[] fwd = trackPoint(prev, next, GRID_W, GRID_H, p[0], p[1]);
            if (fwd == null) continue;
            float[] back = trackPoint(next, prev, GRID_W, GRID_H, fwd[0], fwd[1]);
            if (back == null) continue;
            if (Math.hypot(back[0] - p[0], back[1] - p[1]) > FB_PX) continue;
            pairs.add(new float[]{p[0], p[1], fwd[0], fwd[1]});
        }
        if (pairs.size() < MIN_INLIERS) return identity("too-few-inliers", share);

        Affine bestA = null;
        float bestRes = Float.POSITIVE_INFINITY;
        List<float[]> bestKept = new ArrayList<>();
        /* 채택된 모델 말고 지지를 받은 후보도 남긴다. 반복 무늬에서는 서로 다른
           변환이 비슷한 지지를 받는데, 그걸 보지 않으면 "잔차가 작으니 맞다" 로
           넘어간다. */
        List<Affine> candA = new ArrayList<>();
        List<Integer> candSupport = new ArrayList<>();
        int trials = Math.min(24, pairs.size());
        for (int t = 0; t < trials; t++) {
            List<float[]> sample3 = new ArrayList<>();
            for (int k = 0; k < 3; k++) sample3.add(pairs.get((t * 3 + k * 7) % pairs.size()));
            Affine A = solveAffine(sample3);
            if (A == null) continue;
            List<float[]> kept = new ArrayList<>();
            for (float[] p : pairs) {
                float[] q = applyPt(A, p[0], p[1]);
                if (Math.hypot(q[0] - p[2], q[1] - p[3]) < 2.2) kept.add(p);
            }
            if (kept.size() < MIN_INLIERS) continue;
            Affine refined = solveAffine(kept);
            if (refined == null) continue;
            candA.add(refined);
            candSupport.add(kept.size());
            float res = residual(refined, kept);
            if (res < bestRes) {
                bestRes = res;
                bestA = refined;
                bestKept = kept;
            }
        }
        if (bestA == null) return identity("affine-unstable", share);
        Diagnostics diagnostics = describeEvidence(bestA, bestKept, pairs.size(), candA, candSupport, share);

        float sx = width / (float) GRID_W;
        float sy = height / (float) GRID_H;
        Affine full = new Affine(
            bestA.a,
            bestA.b * (sx / sy),
            bestA.tx * sx,
            bestA.c * (sy / sx),
            bestA.d,
            bestA.ty * sy
        );
        float[] motion = affineToMotion(full, width, height);
        if (motion[2] < MIN_SCALE || motion[2] > MAX_SCALE) return identity("scale-out-of-range", share);
        if (Math.abs(motion[3]) > MAX_ROT_RAD) return identity("rotation-out-of-range", share);
        float quality = Math.max(0, Math.min(1, 1 - bestRes / 3));
        if (quality < 0.18f) return identity("low-quality", share);
        return new Result(true, quality, "affine-background", full,
            motion[0], motion[1], motion[2], motion[3], pairs.size(), share, diagnostics);
    }

    /** 격자 9점에서 두 변환의 예측 차이(축소 좌표계 px). */
    private static float transformGap(Affine a, Affine b) {
        float worst = 0;
        for (int gy = 0; gy < 3; gy++) {
            for (int gx = 0; gx < 3; gx++) {
                float x = (GRID_W * (gx + 0.5f)) / 3f;
                float y = (GRID_H * (gy + 0.5f)) / 3f;
                float[] p = applyPt(a, x, y);
                float[] q = applyPt(b, x, y);
                worst = Math.max(worst, (float) Math.hypot(p[0] - q[0], p[1] - q[1]));
            }
        }
        return worst;
    }

    private static Diagnostics describeEvidence(Affine best, List<float[]> kept, int pairCount,
                                                List<Affine> candA, List<Integer> candSupport,
                                                float share) {
        float[] errs = new float[kept.size()];
        for (int i = 0; i < kept.size(); i++) {
            float[] p = kept.get(i);
            float[] q = applyPt(best, p[0], p[1]);
            errs[i] = (float) Math.hypot(q[0] - p[2], q[1] - p[3]);
        }
        java.util.Arrays.sort(errs);
        float p50 = errs.length == 0 ? Float.POSITIVE_INFINITY
                : errs[Math.min(errs.length - 1, Math.max(0, (int) Math.ceil(0.5 * (errs.length - 1))))];
        float p90 = errs.length == 0 ? Float.POSITIVE_INFINITY
                : errs[Math.min(errs.length - 1, Math.max(0, (int) Math.ceil(0.9 * (errs.length - 1))))];

        int cellsW = 4, cellsH = 3;
        boolean[] seen = new boolean[cellsW * cellsH];
        int cells = 0;
        for (float[] p : kept) {
            int cx = Math.min(cellsW - 1, (int) Math.floor((p[0] / GRID_W) * cellsW));
            int cy = Math.min(cellsH - 1, (int) Math.floor((p[1] / GRID_H) * cellsH));
            int idx = cy * cellsW + cx;
            if (idx >= 0 && idx < seen.length && !seen[idx]) { seen[idx] = true; cells++; }
        }

        int rivalSupport = 0;
        for (int i = 0; i < candA.size(); i++) {
            if (transformGap(best, candA.get(i)) <= 2f) continue;
            if (candSupport.get(i) > rivalSupport) rivalSupport = candSupport.get(i);
        }
        float bestSupport = Math.max(1, kept.size());
        return new Diagnostics(kept.size(), pairCount,
                pairCount > 0 ? kept.size() / (float) pairCount : 0f,
                cells, cellsW * cellsH, p50, p90,
                Math.min(1f, rivalSupport / bestSupport), share);
    }

    /** 잔차가 작다는 것만으로 변환을 믿지 않는다. TS 쪽 assessGmcEvidence 와 같은 규칙. */
    static boolean evidenceOk(Result r) {
        if (!r.usable) return false;
        Diagnostics d = r.diagnostics;
        if (d.backgroundShare < MIN_BACKGROUND_SHARE) return false;
        if (!(d.residualP90 <= MAX_RESIDUAL_P90)) return false;
        if (d.gridCells < MIN_GRID_CELLS) return false;
        if (d.inlierRatio < MIN_INLIER_RATIO) return false;
        if (d.inlierCount < MIN_INLIER_COUNT) return false;
        if (d.rivalSupportRatio > MAX_RIVAL_SUPPORT) return false;
        return true;
    }

    private static boolean finite(float v) { return !Float.isNaN(v) && !Float.isInfinite(v); }
}
