/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·6ed07003 @license @preserve */
package app.hilit.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.net.Uri;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 검출 연결 추적(linked-v1)의 Android 부분 — 웹 apps/web/public/tracking/linked-tracker.js 를 옮긴 것(2026-10-27 사용자 결정 D-04).
 * 영상을 0.2초 간격으로 읽어 사람 검출기(NativePersonDetector, 웹과 같은 EfficientDet-Lite0)로 화면 전체 + 정사각 조각 두 번을 보고,
 * 겉모습(LinkedAppearance)·단서(LinkedCues)·둘레 배경 단서·1초마다 사람 마스크(NativePersonMask)를 붙여 LinkedCore 로 잇는다.
 * 대상 줄이 끊기면 내다본 자리만 확대해 한 번 더 검출하고 다시 잇는다(D-05 「네이티브에서도 켜기」).
 *
 * 검출기를 못 열거나 고른 상자를 검출로 확인하지 못하면 null — 부르는 쪽이 예전 NativeTrackingEngine 으로 돌린다(D-11).
 * 검출 결과는 이 객체가 살아 있는 동안(영상 하나를 편집하는 동안)만 메모리에 있다. 기기 밖으로 보내지 않는다.
 */
final class LinkedNativeTracker implements AutoCloseable {
    static final String ENGINE = "linked-v1";

    /** 웹 LINKED_REFINE 과 같은 값. */
    static final class Refine {
        boolean fgMask = true; double fgMaskEverySec = 1; int fgMaskMax = 8; double fgMaskMinH = 48;
        boolean zoom = true; double zoomWindowSec = 1.2, zoomSide = 2.6, zoomMinSide = 96, zoomScoreMin = 0.6;
        int zoomBudget = 90, zoomRounds = 2; double zoomNear = 1.2, zoomRatioMin = 0.55, zoomRatioMax = 1.8;
    }
    static final Refine REFINE = new Refine();

    /** 사용자가 고르거나 아니라고 한 장면(정규화 상자). */
    static final class View { final double t; final float[] box; View(double t, float[] box) { this.t = t; this.box = box; } }

    static final class Options {
        double startT, endT = Double.NaN;
        boolean stopOnAsk, followThrough; Double askNotBefore;
        final List<View> confirmed = new ArrayList<>(), rejected = new ArrayList<>();
    }

    static final class AskInfo {
        double t, proposalT; String reason; float[] proposal, lastBox;
        /** 묻는 장면의 사람 상자들(정규화) — 「아니에요」 뒤 다시 고를 후보. */
        final List<float[]> candidates = new ArrayList<>();
    }

    static final class Run { NativeTrackingEngine.Result result; AskInfo ask; }

    interface Progress { void onProgress(int percent, String state, float fps); }

    private final Context context;
    private final NativePersonDetector detector;
    private NativePersonMask mask;
    private boolean maskTried;
    private Uri openedUri;
    private MediaMetadataRetriever retriever;
    private int sourceW, sourceH, width, height; private double duration;
    private final Map<Long, LinkedCore.Sample> cache = new HashMap<>();
    private final Map<String, List<LinkedCore.Det>> zoomCache = new HashMap<>();

    private LinkedNativeTracker(Context context, NativePersonDetector detector) { this.context = context.getApplicationContext(); this.detector = detector; }

    /** 검출기를 못 열면 null. 작업 스레드에서 부른다. */
    static LinkedNativeTracker open(Context context) {
        NativePersonDetector d = NativePersonDetector.open(context);
        return d == null ? null : new LinkedNativeTracker(context, d);
    }

    private static long key(double t) { return Math.round(t * 1000); }

    private void openVideo(Uri uri) {
        if (uri.equals(openedUri)) return;
        closeVideo();
        retriever = new MediaMetadataRetriever();
        retriever.setDataSource(context, uri);
        sourceW = Integer.parseInt(meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH, "1"));
        sourceH = Integer.parseInt(meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT, "1"));
        int rotation = Integer.parseInt(meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION, "0"));
        if (rotation == 90 || rotation == 270) { int s = sourceW; sourceW = sourceH; sourceH = s; }
        duration = Long.parseLong(meta(MediaMetadataRetriever.METADATA_KEY_DURATION, "0")) / 1000.0;
        float scale = Math.min(1f, 720f / Math.max(1, Math.min(sourceW, sourceH)));
        width = even(sourceW * scale); height = even(sourceH * scale);
        openedUri = uri;
        cache.clear(); zoomCache.clear();
    }

    private String meta(int k, String fallback) { String v = retriever.extractMetadata(k); return v == null ? fallback : v; }
    private static int even(float v) { return Math.max(2, Math.round(v / 2) * 2); }

    private Bitmap frame(double t) {
        Bitmap raw = retriever.getFrameAtTime(Math.round(t * 1_000_000L), MediaMetadataRetriever.OPTION_CLOSEST);
        if (raw == null) return null;
        Bitmap scaled = raw.getWidth() == width && raw.getHeight() == height ? raw : Bitmap.createScaledBitmap(raw, width, height, true);
        if (scaled != raw) raw.recycle();
        return scaled.getConfig() == Bitmap.Config.ARGB_8888 ? scaled : scaled.copy(Bitmap.Config.ARGB_8888, false);
    }

    /* ── 검출 ─────────────────────────────────────────────────────── */

    /** 조각 자리 — 웹 tileRegions. {x, y, side}. */
    static List<int[]> tileRegions(int w, int h) {
        List<int[]> out = new ArrayList<>();
        int lng = Math.max(w, h), sht = Math.min(w, h);
        if (lng / (double) sht < 1.25) return out;
        if (w >= h) { out.add(new int[]{0, 0, sht}); out.add(new int[]{w - sht, 0, sht}); }
        else { out.add(new int[]{0, 0, sht}); out.add(new int[]{0, h - sht, sht}); }
        return out;
    }

    /** 조각 안쪽 경계에 닿은 상자(잘린 사람일 수 있음) — 웹 cutAtSeam. 상자는 조각 화소. */
    static boolean cutAtSeam(double hx, double hy, double hw, double hh, int rx, int ry, int rw, int rh, int fw, int fh) {
        int m = 3;
        boolean left = hx <= m && rx > 0;
        boolean right = hx + hw >= rw - m && rx + rw < fw;
        boolean top = hy <= m && ry > 0;
        boolean bottom = hy + hh >= rh - m && ry + rh < fh;
        return left || right || top || bottom;
    }

    private static LinkedCore.Box clamp(LinkedCore.Box b, int fw, int fh) {
        double x = Math.max(0, b.x), y = Math.max(0, b.y);
        return new LinkedCore.Box(x, y, Math.min(fw, b.x + b.width) - x, Math.min(fh, b.y + b.height) - y);
    }

    private List<LinkedCore.Det> detectAll(Bitmap frame) {
        List<LinkedCore.Det> all = new ArrayList<>();
        for (FollowRefine.Person p : detector.detect(frame)) all.add(new LinkedCore.Det(new LinkedCore.Box(p.x * width, p.y * height, p.w * width, p.h * height), p.score));
        for (int[] r : tileRegions(width, height)) {
            Bitmap tile = Bitmap.createBitmap(frame, r[0], r[1], r[2], r[2]);
            for (FollowRefine.Person p : detector.detect(tile)) {
                double hx = p.x * r[2], hy = p.y * r[2], hw = p.w * r[2], hh = p.h * r[2];
                if (cutAtSeam(hx, hy, hw, hh, r[0], r[1], r[2], r[2], width, height)) continue;
                all.add(new LinkedCore.Det(new LinkedCore.Box(hx + r[0], hy + r[1], hw, hh), p.score));
            }
            if (tile != frame) tile.recycle();
        }
        List<LinkedCore.Det> clamped = new ArrayList<>();
        for (LinkedCore.Det d : all) { LinkedCore.Box b = clamp(d.box, width, height); if (b.width > 2 && b.height > 2) clamped.add(new LinkedCore.Det(b, d.score)); }
        return LinkedCore.mergeDetections(clamped, LinkedCore.POLICY.nmsIou);
    }

    /* ── 겉모습 ───────────────────────────────────────────────────── */

    /** ARGB 화소 [x0,x1)×[y0,y1) → 48×96 rgba(4개씩). 웹 resampleRect 와 같은 표본 자리. */
    static int[] resample(int[] argb, int fw, int x0, int y0, int x1, int y1) {
        int sw = x1 - x0, sh = y1 - y0;
        if (sw < 1 || sh < 1) return null;
        int cw = LinkedAppearance.CROP_W, ch = LinkedAppearance.CROP_H;
        int[] out = new int[cw * ch * 4];
        for (int j = 0; j < ch; j++) {
            int yy = y0 + Math.min(sh - 1, (int) Math.floor(j * sh / (double) ch));
            for (int i = 0; i < cw; i++) {
                int xx = x0 + Math.min(sw - 1, (int) Math.floor(i * sw / (double) cw));
                int v = argb[yy * fw + xx], di = (j * cw + i) * 4;
                out[di] = (v >> 16) & 0xFF; out[di + 1] = (v >> 8) & 0xFF; out[di + 2] = v & 0xFF; out[di + 3] = 255;
            }
        }
        return out;
    }

    private static int[] rect(LinkedCore.Box b, int fw, int fh) {
        int sx = Math.max(0, (int) Math.floor(b.x)), sy = Math.max(0, (int) Math.floor(b.y));
        int ex = Math.min(fw, (int) Math.ceil(b.x + b.width)), ey = Math.min(fh, (int) Math.ceil(b.y + b.height));
        return new int[]{sx, sy, ex, ey};
    }

    /** 상자 왼쪽·오른쪽 띠(상자 너비의 절반)를 붙인 둘레 배경 조각 — 웹 ringRgba. */
    static int[] ring(int[] argb, int fw, int fh, LinkedCore.Box b) {
        int strip = Math.max(4, (int) Math.round(b.width * 0.5));
        int y0 = Math.max(0, (int) Math.floor(b.y)), y1 = Math.min(fh, (int) Math.ceil(b.y + b.height));
        int lx0 = Math.max(0, (int) Math.floor(b.x) - strip), lx1 = Math.max(0, (int) Math.floor(b.x));
        int rx0 = Math.min(fw, (int) Math.ceil(b.x + b.width)), rx1 = Math.min(fw, (int) Math.ceil(b.x + b.width) + strip);
        int[] left = lx1 - lx0 >= 3 && y1 - y0 >= 8 ? resample(argb, fw, lx0, y0, lx1, y1) : null;
        int[] right = rx1 - rx0 >= 3 && y1 - y0 >= 8 ? resample(argb, fw, rx0, y0, rx1, y1) : null;
        int[] a = left != null ? left : right, c = right != null ? right : left;
        if (a == null) return null;
        int cw = LinkedAppearance.CROP_W, ch = LinkedAppearance.CROP_H, half = cw / 2;
        int[] out = new int[cw * ch * 4];
        for (int j = 0; j < ch; j++) for (int i = 0; i < cw; i++) {
            int[] src = i < half ? a : c;
            int u = Math.min(cw - 1, (i < half ? i : i - half) * 2);
            int si = (j * cw + u) * 4, di = (j * cw + i) * 4;
            out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
        }
        return out;
    }

    /** 웹 describeFromImage — 겉모습 + 단서 + 둘레 배경 단서. 작으면 null. */
    static LinkedCore.Desc describe(int[] argb, int fw, int fh, LinkedCore.Box b) {
        int[] r = rect(b, fw, fh);
        if (r[2] - r[0] < 8 || r[3] - r[1] < 16) return null;
        int[] crop = resample(argb, fw, r[0], r[1], r[2], r[3]);
        LinkedCore.Desc d = LinkedAppearance.describe(crop, LinkedAppearance.CROP_W, LinkedAppearance.CROP_H);
        if (d.samples < 60) return null;
        d.cues = LinkedCues.describe(crop, LinkedAppearance.CROP_W, LinkedAppearance.CROP_H, null, false);
        int[] rg = ring(argb, fw, fh, b);
        d.ring = rg != null ? LinkedCues.describe(rg, LinkedAppearance.CROP_W, LinkedAppearance.CROP_H, null, true) : null;
        return d;
    }

    private boolean attachFg(Bitmap frame, int[] argb, LinkedCore.Det det) {
        if (det.desc == null) return false;
        if (!maskTried) { maskTried = true; mask = NativePersonMask.open(context); }
        if (mask == null) return false;
        float[] m;
        try { m = mask.mask(frame, (float) det.box.x, (float) det.box.y, (float) det.box.width, (float) det.box.height, LinkedAppearance.CROP_W, LinkedAppearance.CROP_H); }
        catch (RuntimeException e) { mask.close(); mask = null; return false; }
        if (m == null) return false;
        int[] r = rect(det.box, width, height);
        int[] crop = resample(argb, width, r[0], r[1], r[2], r[3]);
        if (crop == null) return false;
        LinkedCues.Cue fg = LinkedCues.describe(crop, LinkedAppearance.CROP_W, LinkedAppearance.CROP_H, m, false);
        if (fg.n < 60) return false;
        det.desc.cuesFg = fg;
        return true;
    }

    private static boolean maskTick(double t, double every) { return every > 0 && Math.abs(t / every - Math.round(t / every)) < 1e-3; }

    private LinkedCore.Sample sample(double t, Refine refine) {
        LinkedCore.Sample row = cache.get(key(t));
        if (row != null) return row;
        Bitmap f = frame(t);
        List<LinkedCore.Det> dets = new ArrayList<>();
        if (f != null) {
            dets = detectAll(f);
            int[] argb = new int[width * height];
            f.getPixels(argb, 0, width, 0, 0, width, height);
            for (LinkedCore.Det d : dets) d.desc = d.box.height >= 20 && d.score >= 0.2 ? describe(argb, width, height, d.box) : null;
            if (refine.fgMask && maskTick(t, refine.fgMaskEverySec)) {
                List<LinkedCore.Det> big = new ArrayList<>();
                for (LinkedCore.Det d : dets) if (d.desc != null && d.box.height >= refine.fgMaskMinH && d.score >= 0.3) big.add(d);
                big.sort((a, b) -> Double.compare(b.box.height, a.box.height));
                for (int i = 0; i < Math.min(refine.fgMaskMax, big.size()); i++) attachFg(f, argb, big.get(i));
            }
            f.recycle();
        }
        row = new LinkedCore.Sample(t, dets);
        cache.put(key(t), row);
        return row;
    }

    /** 웹 sampleTimes — 0.2초 격자 + 시작 시각. */
    static List<Double> sampleTimes(double start, double end, double hz) {
        List<Double> times = new ArrayList<>();
        times.add(start);
        for (long k = (long) Math.floor(start * hz + 1e-6) + 1; k / hz <= end + 1e-6; k++) {
            double t = k / hz;
            if (t - times.get(times.size() - 1) > 0.02) times.add(t);
        }
        return times;
    }

    /* ── 놓친 자리 확대 재검출 ──────────────────────────────────────── */

    static final class Slot { final int si; final LinkedCore.Box pred; Slot(int si, LinkedCore.Box pred) { this.si = si; this.pred = pred; } }

    /** 웹 lossSlots. */
    static List<Slot> lossSlots(List<LinkedCore.Sample> samples, LinkedCore.Built built, LinkedCore.Link link, Refine refine) {
        List<Slot> out = new ArrayList<>();
        LinkedCore.State[] st = link.state;
        int end = link.ask != null ? link.ask.si : samples.size();
        for (int si = Math.max(0, link.s0); si < end - 1; si++) {
            if (!isObs(st[si]) || isObs(st[si + 1])) continue;
            LinkedCore.State last = st[si];
            int k = si;
            while (k - 1 >= link.s0 && isObs(st[k - 1]) && st[k - 1].trackId == last.trackId && samples.get(si).t - samples.get(k - 1).t <= 1 + 1e-6) k--;
            double vx = 0, vy = 0, dt0 = samples.get(si).t - samples.get(k).t;
            if (k < si && dt0 >= 0.3) {
                double[] cam = LinkedCore.accumulatedShift(built.shifts, k, si);
                LinkedCore.Box a = st[k].box;
                vx = (LinkedCore.cx(last.box) - LinkedCore.cx(a) - cam[0]) / dt0;
                vy = (LinkedCore.cy(last.box) - LinkedCore.cy(a) - cam[1]) / dt0;
                double cap = 3 * last.box.height;
                vx = Math.max(-cap, Math.min(cap, vx)); vy = Math.max(-cap, Math.min(cap, vy));
            }
            for (int j = si + 1; j < end && samples.get(j).t - samples.get(si).t <= refine.zoomWindowSec + 1e-6; j++) {
                if (isObs(st[j])) break;
                double dt = samples.get(j).t - samples.get(si).t;
                double[] cam = LinkedCore.accumulatedShift(built.shifts, si, j);
                out.add(new Slot(j, new LinkedCore.Box(last.box.x + cam[0] + vx * dt, last.box.y + cam[1] + vy * dt, last.box.width, last.box.height)));
            }
        }
        return out;
    }

    private static boolean isObs(LinkedCore.State s) { return s != null && "obs".equals(s.kind); }

    /** 웹 zoomRegion — {x, y, side}. */
    static int[] zoomRegion(LinkedCore.Box pred, int fw, int fh, Refine refine) {
        int side = (int) Math.round(Math.min(Math.min(fw, fh), Math.max(refine.zoomMinSide, refine.zoomSide * pred.height)));
        double cxp = LinkedCore.cx(pred), cyp = LinkedCore.cy(pred);
        int x = (int) Math.round(Math.max(0, Math.min(fw - side, cxp - side / 2.0)));
        int y = (int) Math.round(Math.max(0, Math.min(fh - side, cyp - side / 2.0)));
        return new int[]{x, y, side};
    }

    /** 웹 acceptZoomHits — hits 는 조각 화소 상자와 점수. */
    static List<LinkedCore.Det> acceptZoomHits(List<LinkedCore.Det> hits, int[] region, LinkedCore.Box pred, List<LinkedCore.Det> existing, int fw, int fh, Refine refine) {
        List<LinkedCore.Det> out = new ArrayList<>();
        for (LinkedCore.Det h : hits) {
            if (h.score < refine.zoomScoreMin || cutAtSeam(h.box.x, h.box.y, h.box.width, h.box.height, region[0], region[1], region[2], region[2], fw, fh)) continue;
            LinkedCore.Box b = clamp(new LinkedCore.Box(h.box.x + region[0], h.box.y + region[1], h.box.width, h.box.height), fw, fh);
            if (b.width <= 2 || b.height <= 2) continue;
            double ratio = b.height / Math.max(1, pred.height);
            if (ratio < refine.zoomRatioMin || ratio > refine.zoomRatioMax) continue;
            double dist = LinkedCore.centerDist(b, pred) / Math.max(1, pred.height);
            if (dist > refine.zoomNear) continue;
            boolean dup = false;
            for (LinkedCore.Det e : existing) if (LinkedCore.iou(e.box, b) >= 0.4) { dup = true; break; }
            for (LinkedCore.Det e : out) if (LinkedCore.iou(e.box, b) >= 0.4) { dup = true; break; }
            if (dup) continue;
            LinkedCore.Det d = new LinkedCore.Det(b, h.score);
            d.zoom = true;
            out.add(d);
        }
        out.sort((a, b) -> Double.compare(b.score, a.score));
        return out.size() > 2 ? new ArrayList<>(out.subList(0, 2)) : out;
    }

    private List<LinkedCore.Det> zoomDetect(LinkedCore.Sample row, Slot slot, Refine refine, int[] probes) {
        int[] region = zoomRegion(slot.pred, width, height, refine);
        String k = key(row.t) + ":" + (region[0] >> 3) + ":" + (region[1] >> 3) + ":" + (region[2] >> 3);
        List<LinkedCore.Det> got = zoomCache.get(k);
        if (got != null) return got;
        if (probes[0] >= refine.zoomBudget) return new ArrayList<>();
        probes[0]++;
        Bitmap f = frame(row.t);
        got = new ArrayList<>();
        if (f != null) {
            Bitmap tile = Bitmap.createBitmap(f, region[0], region[1], region[2], region[2]);
            List<LinkedCore.Det> hits = new ArrayList<>();
            for (FollowRefine.Person p : detector.detect(tile)) hits.add(new LinkedCore.Det(new LinkedCore.Box(p.x * region[2], p.y * region[2], p.w * region[2], p.h * region[2]), p.score));
            if (tile != f) tile.recycle();
            got = acceptZoomHits(hits, region, slot.pred, row.dets, width, height, refine);
            if (!got.isEmpty()) {
                int[] argb = new int[width * height];
                f.getPixels(argb, 0, width, 0, 0, width, height);
                for (LinkedCore.Det d : got) d.desc = d.box.height >= 20 && d.score >= 0.15 ? describe(argb, width, height, d.box) : null;
            }
            f.recycle();
        }
        zoomCache.put(k, got);
        return got;
    }

    /* ── 찾기 ─────────────────────────────────────────────────────── */

    private LinkedCore.Box toPx(float[] n) { return new LinkedCore.Box(n[0] * width, n[1] * height, n[2] * width, n[3] * height); }
    private float[] toNorm(LinkedCore.Box b) {
        return new float[]{cl((float) (b.x / width)), cl((float) (b.y / height)), cl((float) (b.width / width)), cl((float) (b.height / height))};
    }
    private static float cl(float v) { return Math.max(0, Math.min(1, v)); }

    private LinkedCore.Desc seedDesc(double t, LinkedCore.Box box, Refine refine) {
        Bitmap f = frame(t);
        if (f == null) return null;
        int[] argb = new int[width * height];
        f.getPixels(argb, 0, width, 0, 0, width, height);
        LinkedCore.Desc d = describe(argb, width, height, box);
        if (d != null && refine.fgMask) { LinkedCore.Det det = new LinkedCore.Det(box, 1); det.desc = d; attachFg(f, argb, det); }
        f.recycle();
        return d;
    }

    /**
     * 고른 상자(정규화)에서 출발해 따라간다. 검출기가 처음부터 안 되거나 고른 상자를 검출로 확인 못 하면 null(D-11).
     * 멈추라는 신호(interrupt)를 받으면 InterruptedException.
     */
    Run track(Uri uri, float[] seedNorm, Options o, Progress progress) throws InterruptedException {
        long began = System.nanoTime();
        openVideo(uri);
        Refine refine = REFINE;
        LinkedCore.Policy policy = LinkedCore.POLICY;
        double start = Math.max(0, Math.min(o.startT, duration - 0.05));
        double end = !Double.isNaN(o.endT) && o.endT > start ? Math.min(duration, o.endT) : duration;
        List<Double> times = sampleTimes(start, Math.max(start, end - 0.02), policy.sampleHz);
        List<LinkedCore.Sample> samples = new ArrayList<>();
        for (int i = 0; i < times.size(); i++) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
            samples.add(sample(times.get(i), refine));
            if (progress != null) {
                double sec = (System.nanoTime() - began) / 1e9;
                progress.onProgress((int) Math.round(i * 100.0 / Math.max(1, times.size())), "대상 따라가는 중", (float) ((i + 1) / Math.max(1e-3, sec)));
            }
        }
        LinkedCore.Box seedBox = toPx(seedNorm);
        LinkedCore.Input in = new LinkedCore.Input();
        in.samples = samples; in.frameW = width; in.frameH = height; in.seedT = start; in.seedBox = seedBox;
        in.stopOnAsk = o.stopOnAsk; in.followThrough = o.followThrough; in.askNotBefore = o.askNotBefore;
        LinkedCore.Desc sd = seedDesc(start, seedBox, refine);
        if (sd != null) in.seedDescs.add(sd);
        for (View v : o.confirmed) { if (in.seedDescs.size() >= 7) break; LinkedCore.Desc d = seedDesc(v.t, toPx(v.box), refine); if (d != null) in.seedDescs.add(d); }
        for (View v : o.rejected) { in.rejectedTimes.add(v.t); in.rejectedBoxes.add(toPx(v.box)); }
        in.built = LinkedCore.buildTracklets(samples, width, height, policy);
        LinkedCore.Link link = LinkedCore.linkTarget(in, policy);
        if (!link.ok) return null;
        List<LinkedCore.Sample> rows = samples;
        if (refine.zoom) {
            Map<Integer, List<LinkedCore.Det>> zoomDets = new HashMap<>();
            java.util.Set<Integer> tried = new java.util.HashSet<>();
            int[] probes = {0};
            for (int round = 0; round < refine.zoomRounds; round++) {
                int added = 0;
                for (Slot slot : lossSlots(rows, in.built, link, refine)) {
                    if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                    if (tried.contains(slot.si) || probes[0] >= refine.zoomBudget) continue;
                    tried.add(slot.si);
                    List<LinkedCore.Det> got = zoomDetect(rows.get(slot.si), slot, refine, probes);
                    List<LinkedCore.Det> have = zoomDets.computeIfAbsent(slot.si, x -> new ArrayList<>());
                    for (LinkedCore.Det d : got) if (!have.contains(d)) { have.add(d); added++; }
                }
                if (added == 0) break;
                List<LinkedCore.Sample> next = new ArrayList<>();
                for (int si = 0; si < samples.size(); si++) {
                    List<LinkedCore.Det> z = zoomDets.get(si);
                    if (z == null || z.isEmpty()) { next.add(samples.get(si)); continue; }
                    List<LinkedCore.Det> d = new ArrayList<>(samples.get(si).dets);
                    d.addAll(z);
                    next.add(new LinkedCore.Sample(samples.get(si).t, d));
                }
                LinkedCore.Built nb = LinkedCore.buildTracklets(next, width, height, policy);
                LinkedCore.Input ni = in;
                LinkedCore.Built ob = in.built; List<LinkedCore.Sample> os = in.samples;
                ni.samples = next; ni.built = nb;
                LinkedCore.Link nl = LinkedCore.linkTarget(ni, policy);
                if (!nl.ok) { in.samples = os; in.built = ob; break; }
                rows = next; link = nl;
            }
        }
        List<LinkedCore.TrajPoint> traj = LinkedCore.renderTrajectory(rows, link, start, end, policy);
        Run run = new Run();
        NativeTrackingEngine.Result out = new NativeTrackingEngine.Result();
        out.width = sourceW; out.height = sourceH; out.orientation = sourceW >= sourceH ? "landscape" : "portrait";
        for (LinkedCore.TrajPoint p : traj) {
            float[] n = toNorm(p.box);
            out.points.add(new NativeTrackingEngine.Point(p.t, new NativeTrackingEngine.Box(n[0], n[1], n[2], n[3]), (float) p.health, (float) p.reid, (float) p.confidence, p.state));
        }
        out.detectorCalls = samples.size();
        out.elapsed = (System.nanoTime() - began) / 1e9;
        run.result = out;
        if (link.ask != null && link.ask.proposalBox != null) {
            AskInfo a = new AskInfo();
            a.t = link.ask.t; a.reason = link.ask.reason; a.proposal = toNorm(link.ask.proposalBox); a.proposalT = link.ask.proposalT;
            a.lastBox = link.ask.lastBox != null ? toNorm(link.ask.lastBox) : null;
            for (LinkedCore.Det d : rows.get(link.ask.si).dets) if (d.score >= policy.scoreNew) a.candidates.add(toNorm(d.box));
            run.ask = a;
        }
        return run;
    }

    /** t 장면의 사람 상자(정규화) — 「여긴 내가 없어요」 뒤 제안 없이 다시 고를 때의 후보. */
    List<float[]> candidatesAt(double t) {
        List<float[]> out = new ArrayList<>();
        if (retriever == null) return out;
        for (LinkedCore.Det d : sample(t, REFINE).dets) if (d.score >= LinkedCore.POLICY.scoreNew) out.add(toNorm(d.box));
        return out;
    }

    /** 묻는 장면 한 장(정규화 상자와 같은 비율). 못 읽으면 null. */
    Bitmap frameAt(double t) { return retriever == null ? null : frame(t); }

    double duration() { return duration; }

    private void closeVideo() {
        if (retriever != null) { try { retriever.release(); } catch (Exception ignored) { /* 이미 닫힘 */ } }
        retriever = null; openedUri = null;
    }

    @Override public void close() {
        closeVideo();
        detector.close();
        if (mask != null) mask.close();
        cache.clear(); zoomCache.clear();
    }
}
