/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·434ad264 @license @preserve */
package app.hilit.mobile;

import java.util.ArrayList;
import java.util.List;

/**
 * 네이티브 「헷갈리면 바로 묻기」 — 웹 apps/web/src/lib/live-ask.ts 와 같은 규칙(2026-10-27 사용자 결정 D-10·D-13·D-14·D-15).
 * 추적이 헷갈리는 자리에서 멈추면 추적 진행 화면에서 바로 묻고, 사용자가 고른 상자로 그 시각부터 이어서 찾는다.
 * 누가 그 사람인지는 사용자가 고른다 — 사람 판정이 아니다. 화면과 무관한 계산만 둔다(NativeLiveAskTest).
 */
final class NativeLiveAsk {
    /** 남은 구간이 이보다 짧으면 묻지 않고 끝낸다. */
    static final double MIN_LEFT_SEC = 0.5;
    /** 「여긴 내가 없어요」를 누르면 이만큼 뒤까지 비운다(D-14, 웹과 같은 값). */
    static final double ABSENT_STEP_SEC = 2;
    /** 한 번의 찾기에서 묻는 횟수 상한(D-14, 웹과 같은 값). */
    static final int MAX = 8;
    /** 이어서 찾을 출발점을 찾는 거리(초). */
    static final double CONFIDENT_BACK_SEC = 3;

    /** 묻는 중인 장면. points 는 지금까지 찾은 궤적(정규화 상자). */
    static final class State {
        double at, from, end; String reason; int count;
        List<NativeTrackingEngine.Point> points;
        LinkedNativeTracker.AskInfo info;
        /** 크기·방향을 이어 쓸 결과 틀. */
        NativeTrackingEngine.Result result;
    }

    private NativeLiveAsk() {}

    /** template 의 크기·방향에 points 를 담은 새 결과. */
    static NativeTrackingEngine.Result withPoints(NativeTrackingEngine.Result template, List<NativeTrackingEngine.Point> points) {
        NativeTrackingEngine.Result out = new NativeTrackingEngine.Result();
        out.width = template.width; out.height = template.height; out.orientation = template.orientation;
        out.points.addAll(points);
        out.detectorCalls = template.detectorCalls; out.elapsed = template.elapsed;
        return out;
    }

    /** from~to 에 「놓침」 점을 채운다 — 웹 fillAbsent(step 1/12). */
    static List<NativeTrackingEngine.Point> fillAbsent(List<NativeTrackingEngine.Point> points, double from, double to) {
        List<NativeTrackingEngine.Point> out = new ArrayList<>();
        if (!(to > from)) { out.addAll(points); return out; }
        NativeTrackingEngine.Point before = null;
        for (NativeTrackingEngine.Point p : points) {
            if (p.timestamp < from - 1e-6 || p.timestamp > to + 1e-6) out.add(p);
            if (p.timestamp < from - 1e-6) before = p;
        }
        NativeTrackingEngine.Box box = before != null ? before.box.copy() : new NativeTrackingEngine.Box(0, 0, 0, 0);
        for (double t = from; t <= to + 1e-6; t += 1 / 12.0) {
            out.add(new NativeTrackingEngine.Point(Math.round(t * 10000) / 10000.0, box.copy(), 0, 0, 0, "TARGET_LOST", "LOST_UNCERTAIN"));
        }
        out.sort((a, b) -> Double.compare(a.timestamp, b.timestamp));
        return out;
    }

    /** before 직전(3초 안)에 실제로 잡고 있던 마지막 점 — 웹 lastConfidentPoint. 없으면 null. */
    static NativeTrackingEngine.Point lastConfidentPoint(List<NativeTrackingEngine.Point> points, double before) {
        for (int i = points.size() - 1; i >= 0; i--) {
            NativeTrackingEngine.Point p = points.get(i);
            if (p.timestamp >= before - 1e-6) continue;
            if (p.timestamp < before - CONFIDENT_BACK_SEC) break;
            boolean live = "TRACKING_OK".equals(p.state) || "TRACKING_WARNING".equals(p.state);
            if (live && p.box.w > 0.002f && p.box.h > 0.002f) return p;
        }
        return null;
    }

    /** base 의 from 이전 + patch 의 from 이후 — 웹 spliceTrajectoryWindow 와 같은 뜻. */
    static List<NativeTrackingEngine.Point> splice(List<NativeTrackingEngine.Point> base, double from, List<NativeTrackingEngine.Point> patch) {
        List<NativeTrackingEngine.Point> out = new ArrayList<>();
        for (NativeTrackingEngine.Point p : base) if (p.timestamp < from - 1e-6) out.add(p);
        for (NativeTrackingEngine.Point p : patch) if (p.timestamp >= from - 1e-6) out.add(p);
        out.sort((a, b) -> Double.compare(a.timestamp, b.timestamp));
        return out;
    }

    /** 이어서 찾는 동안의 진행률을 전체 범위 기준으로 — 웹 overallPercent. */
    static int overallPercent(int percent, double start, double from, double end) {
        double span = end - start;
        int pc = Math.max(0, Math.min(100, percent));
        if (!(span > 0)) return pc;
        double done = (from - start) + pc / 100.0 * (end - from);
        return (int) Math.round(Math.max(0, Math.min(100, done / span * 100)));
    }

    /** 이 멈춤을 물어야 하나 — 남은 구간이 짧거나 상한을 넘으면 묻지 않는다. */
    static boolean shouldAsk(LinkedNativeTracker.AskInfo ask, double end, int count) {
        return ask != null && ask.t < end - MIN_LEFT_SEC && count <= MAX;
    }

    /** 제안 상자와 거의 같은 후보는 「아니에요」 뒤 후보에서 뺀다(IoU 0.5 이상). */
    static List<float[]> otherCandidates(List<float[]> candidates, float[] proposal) {
        List<float[]> out = new ArrayList<>();
        for (float[] c : candidates) if (proposal == null || iou(c, proposal) < 0.5) out.add(c);
        return out;
    }

    static double iou(float[] a, float[] b) {
        double ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
        double iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
        double inter = ix * iy, union = a[2] * a[3] + b[2] * b[3] - inter;
        return union > 0 ? inter / union : 0;
    }
}
