/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·c414661a @license @preserve */
package app.hilit.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 검출 연결 추적(linked-v1) — 계산 부분. 웹 apps/web/public/tracking/linked-core.js 를 옮긴 것(2026-10-27 사용자 결정 D-04
 * 「웹 엔진 통째로 이식」). 화면·영상·검출기를 모른다 — JVM 시험에서 그대로 부른다(LinkedCoreTest).
 *
 *   1. 0.2초 간격 표본마다 화면의 모든 사람 검출을 시간으로 이어 사람마다 줄(tracklet)을 만든다(buildTracklets).
 *   2. 사용자가 고른 상자가 속한 줄을 따라간다. 상자는 늘 실제 검출 위에 있다(배경에 붙을 수 없다).
 *   3. 그 줄이 끝나면 그 뒤에 새로 생긴 줄만 재등장 후보로 본다. 함께 보였던 사람은 「확실한 타인」이다.
 *   4. 2026-10-27 제안 2·4번: 장면별 단서 무게(LinkedCues), 전광판·LED 화면 속 사람 거르기(screenDetections).
 *
 * 🔴 겉모습 점수는 신원 확률이 아니다. 확실한 타인 기억은 이 영상 한 편 안에서만 산다(AGENTS.md 기술 정의).
 *    값과 분기는 웹과 같아야 한다 — 웹을 바꾸면 여기도 바꾸고 LinkedCoreTest 를 함께 고친다.
 */
final class LinkedCore {
    private LinkedCore() {}

    /* ── 자료 ───────────────────────────────────────────────────────── */

    static final class Box {
        double x, y, width, height;
        Box(double x, double y, double w, double h) { this.x = x; this.y = y; this.width = w; this.height = h; }
        Box copy() { return new Box(x, y, width, height); }
    }

    static final class Desc {
        float[] values; int samples; float trust = 1;
        LinkedCues.Cue cues, ring, cuesFg;
    }

    static final class Det {
        Box box; double score; Desc desc; boolean zoom;
        Det(Box box, double score) { this.box = box; this.score = score; }
    }

    static final class Sample {
        final double t; final List<Det> dets;
        Sample(double t, List<Det> dets) { this.t = t; this.dets = dets; }
    }

    static final class Obs {
        final double t; final int si; final Box box; final double score; final Desc desc; final boolean screen;
        Obs(double t, int si, Box box, double score, Desc desc, boolean screen) { this.t = t; this.si = si; this.box = box; this.score = score; this.desc = desc; this.screen = screen; }
    }

    static final class Track {
        final int id; final List<Obs> obs = new ArrayList<>(); boolean screen;
        Track(int id) { this.id = id; }
    }

    static final class Shift {
        final double dx, dy; final int support;
        Shift(double dx, double dy, int support) { this.dx = dx; this.dy = dy; this.support = support; }
    }

    static final class Row {
        final int trackId; final Det det; final Obs obs;
        Row(int trackId, Det det, Obs obs) { this.trackId = trackId; this.det = det; this.obs = obs; }
    }

    static final class Built {
        final List<Track> tracks = new ArrayList<>(); final List<List<Row>> perSample = new ArrayList<>(); final List<Shift> shifts = new ArrayList<>();
    }

    /** 표본마다 대상 상태. kind: obs · absent · gap. */
    static final class State {
        String kind; int trackId = -1; Box box; double score; boolean exited, longGap; Double reentryAt;
        static State obs(int trackId, Box box, double score) { State s = new State(); s.kind = "obs"; s.trackId = trackId; s.box = box; s.score = score; return s; }
        static State absent(boolean exited) { State s = new State(); s.kind = "absent"; s.exited = exited; return s; }
    }

    static final class Ask {
        int si; double t; String reason; int proposalTrackId = -1; Box proposalBox; double proposalT; Box lastBox; Integer rival;
    }

    static final class Decision {
        final String kind; final double at; final Map<String, Object> info = new LinkedHashMap<>();
        Decision(String kind, double at) { this.kind = kind; this.at = at; }
        Decision put(String k, Object v) { info.put(k, v); return this; }
    }

    static final class Cand {
        int trackId, firstSi; double t, sim, neg, margin, gap, fromLost, lastT; boolean entering, nearLoss;
    }

    static final class Link {
        boolean ok; String reason; int seedTrack = -1; double seedOverlap; int s0;
        State[] state; Ask ask; final List<Decision> decisions = new ArrayList<>();
        int lastObsSi = -1, galleryN, othersN, screenTracks; boolean cueAdapted;
    }

    static final class TrajPoint {
        double t; Box box; String state; double confidence, health, reid; boolean engineAbsent; int frame;
    }

    static final class Input {
        List<Sample> samples; Built built; double frameW, frameH; double seedT; Box seedBox;
        List<double[]> rejected = new ArrayList<>(); /* {t, x, y, w, h} */
        List<Box> rejectedBoxes = new ArrayList<>(); List<Double> rejectedTimes = new ArrayList<>();
        List<Desc> seedDescs = new ArrayList<>();
        boolean stopOnAsk, followThrough; Double askNotBefore;
    }

    /** 웹 LINKED_POLICY 와 같은 값. */
    static final class Policy {
        double sampleHz = 5, outFps = 10, scoreNew = 0.3, scoreKeep = 0.15, minHeightPx = 14, nmsIou = 0.5;
        double gateBase = 0.9, gatePerSec = 1.6, gateMax = 3, sizeRatioMax = 1.7, sizeRefSec = 0;
        double handoverMaxGapSec = 0, handoverMaxCost = 0.6, handoverMargin = 0.3;
        double wIou = 1, wDist = 0.6, wSize = 0.5, wApp = 0.35, wAppConflict = 0, velAlpha = 0.5;
        double trackDeathSec = 1.0, edgeMargin = 0.04, warnGapSec = 0.45;
        int galleryMax = 24, trackDescMax = 10;
        double reentrySimMin = 0.5, reentryMarginMin = 0.0, reentrySelfDrop = 0.1, reentryEarlierWithin = 0.03, reentryAmbiguous = 0.025;
        double occludedNearBase = 1.6, occludedNearPerSec = 1.6;
        double stitchMaxGapSec = 0, stitchNearBase = 0.9, stitchNearPerSec = 1.0, stitchSelfDrop = 0.25, stitchAmbiguous = 0.15;
        boolean crossingAsk = false; double askRearmSec = 1.5;
        double contactIou = 0.2, contactDistH = 0, swapScoreMin = 0.6, swapAppMin = 0, contactDistinctMax = 1;
        boolean riskPartners = true; double reentryNearFirstSec = 0.5, jumpDevMin = 0, jumpRatio = 0.6;
        double askUnclearMargin = 0, askUnclearWindowSec = 3;
        boolean cueAdapt = true; double cueGain = 1, cueLearnSec = 2; boolean useFgCues = true;
        boolean screenFilter = true; double screenGiant = 2.2, screenAspect = 1.45, screenTrackShare = 0.6;
        /** 확대 재검출 상자는 새 줄을 만들지 않고 이미 있는 줄만 잇는다. */
        boolean zoomExtendOnly = true;
    }
    static final Policy POLICY = new Policy();

    /* ── 상자 계산 ─────────────────────────────────────────────────── */

    static double iou(Box a, Box b) {
        double ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        double iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        double inter = ix * iy, union = a.width * a.height + b.width * b.height - inter;
        return union > 0 ? inter / union : 0;
    }
    static double cx(Box b) { return b.x + b.width / 2; }
    static double cy(Box b) { return b.y + b.height / 2; }
    static double centerDist(Box a, Box b) { return Math.hypot(cx(a) - cx(b), cy(a) - cy(b)); }
    static Box shiftBox(Box b, double dx, double dy) { return new Box(b.x + dx, b.y + dy, b.width, b.height); }
    static Box lerpBox(Box a, Box b, double f) {
        return new Box(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.width + (b.width - a.width) * f, a.height + (b.height - a.height) * f);
    }

    static boolean nearEdge(Box box, double fw, double fh, double margin) {
        double m = margin * Math.min(fw, fh);
        return box.x <= m || box.y <= m || box.x + box.width >= fw - m || box.y + box.height >= fh - m;
    }

    /** 겹친 검출 합치기 — 점수 높은 것부터 남긴다. */
    static List<Det> mergeDetections(List<Det> dets, double nmsIou) {
        List<Det> sorted = new ArrayList<>();
        for (Det d : dets) if (d.box.width > 0 && d.box.height > 0) sorted.add(d);
        sorted.sort((a, b) -> Double.compare(b.score, a.score));
        List<Det> kept = new ArrayList<>();
        for (Det d : sorted) {
            boolean dup = false;
            for (Det k : kept) {
                if (iou(d.box, k.box) >= nmsIou) { dup = true; break; }
                double ix = Math.max(0, Math.min(d.box.x + d.box.width, k.box.x + k.box.width) - Math.max(d.box.x, k.box.x));
                double iy = Math.max(0, Math.min(d.box.y + d.box.height, k.box.y + k.box.height) - Math.max(d.box.y, k.box.y));
                double small = Math.min(d.box.width * d.box.height, k.box.width * k.box.height);
                if (small > 0 && (ix * iy) / small >= 0.85) { dup = true; break; }
            }
            if (!dup) kept.add(d);
        }
        return kept;
    }

    /* ── 카메라 이동 ─────────────────────────────────────────────── */

    static Shift estimateShift(List<Box> prevBoxes, List<Box> dets, double fw, double fh) {
        if (prevBoxes.size() < 2 || dets.size() < 2) return new Shift(0, 0, 0);
        double limit = 0.35 * Math.max(fw, fh);
        List<double[]> hyps = new ArrayList<>();
        hyps.add(new double[]{0, 0});
        outer:
        for (Box p : prevBoxes) {
            for (Box d : dets) {
                double r = d.height / p.height;
                if (r < 0.75 || r > 1.33) continue;
                double dx = cx(d) - cx(p), dy = cy(d) - cy(p);
                if (Math.hypot(dx, dy) > limit) continue;
                hyps.add(new double[]{dx, dy});
                if (hyps.size() > 360) break outer;
            }
        }
        double[] best = hyps.get(0);
        int bestS = shiftSupport(prevBoxes, dets, best);
        int zeroS = bestS;
        for (int i = 1; i < hyps.size(); i++) {
            int s = shiftSupport(prevBoxes, dets, hyps.get(i));
            if (s > bestS || (s == bestS && Math.hypot(hyps.get(i)[0], hyps.get(i)[1]) < Math.hypot(best[0], best[1]))) { best = hyps.get(i); bestS = s; }
        }
        if (bestS < 2 || bestS <= zeroS) return new Shift(0, 0, zeroS);
        double sx = 0, sy = 0; int n = 0;
        for (Box p : prevBoxes) {
            Box moved = shiftBox(p, best[0], best[1]);
            Box bd = null; double bv = 0;
            for (Box d : dets) { double v = iou(moved, d); if (v > bv) { bv = v; bd = d; } }
            if (bd != null && bv >= 0.3) { sx += cx(bd) - cx(p); sy += cy(bd) - cy(p); n++; }
        }
        return n > 0 ? new Shift(sx / n, sy / n, bestS) : new Shift(best[0], best[1], bestS);
    }

    private static int shiftSupport(List<Box> prevBoxes, List<Box> dets, double[] h) {
        int s = 0;
        for (Box p : prevBoxes) {
            Box moved = shiftBox(p, h[0], h[1]);
            double best = 0;
            for (Box d : dets) { double v = iou(moved, d); if (v > best) best = v; }
            if (best >= 0.3) s++;
        }
        return s;
    }

    static double[] accumulatedShift(List<Shift> shifts, int fromSi, int toSi) {
        double dx = 0, dy = 0;
        for (int i = fromSi + 1; i <= toSi && i < shifts.size(); i++) { dx += shifts.get(i).dx; dy += shifts.get(i).dy; }
        return new double[]{dx, dy};
    }

    /* ── 닮음 ───────────────────────────────────────────────────────── */

    /** 대상 잇기 동안만 쓰는 단서 문맥(웹 cueCtx). 잇기가 끝나면 비운다. 잇기는 한 스레드에서만 부른다. */
    private static final class CueCtx { double[] w; double gain; boolean useFg; boolean adapted; }
    private static CueCtx cueCtx = null;

    static Double similarity(Desc a, Desc b) {
        if (a == null || b == null) return null;
        Double base = LinkedAppearance.similarity(a, b);
        CueCtx c = cueCtx;
        return c != null ? LinkedCues.adjust(base, a, b, c.w, c.gain, c.useFg) : base;
    }

    /** 전광판·LED 화면 속 사람인가 — 한 장의 검출마다. 웹 screenDetections. */
    static boolean[] screenDetections(List<Det> dets, double fw, double fh, Policy p) {
        boolean[] out = new boolean[dets.size()];
        if (!p.screenFilter || dets.size() < 3) return out;
        for (int i = 0; i < dets.size(); i++) {
            Box d = dets.get(i).box;
            List<Double> hs = new ArrayList<>(), tops = new ArrayList<>();
            for (int j = 0; j < dets.size(); j++) {
                if (j == i || dets.get(j).score < p.scoreNew) continue;
                hs.add(dets.get(j).box.height); tops.add(dets.get(j).box.y);
            }
            if (hs.size() < 2) continue;
            Collections.sort(hs); Collections.sort(tops);
            double medH = hs.get(hs.size() / 2);
            if (!(d.height >= p.screenGiant * medH)) continue;
            boolean floating = d.y + d.height <= tops.get(tops.size() / 2) + 0.1 * medH;
            boolean atBottom = d.y + d.height >= fh - p.edgeMargin * Math.min(fw, fh);
            boolean upper = d.height / Math.max(1, d.width) < p.screenAspect && !atBottom;
            out[i] = floating || upper;
        }
        return out;
    }

    /* ── 줄 만들기 ─────────────────────────────────────────────────── */

    private static final class Live {
        final Track tr; Box lastBox; double lastT, vx, vy, camX, camY, missSec; Desc desc; Box pred; Double refH;
        Live(Track tr, Box box, double t, Desc desc) { this.tr = tr; this.lastBox = box; this.lastT = t; this.desc = desc; this.pred = box; }
    }

    private static Double refHeight(List<Obs> obs, double sec) {
        Obs last = obs.get(obs.size() - 1);
        List<Double> hs = new ArrayList<>();
        for (int i = obs.size() - 1; i >= 0 && obs.get(i).t >= last.t - sec - 1e-6; i--) hs.add(obs.get(i).box.height);
        Collections.sort(hs);
        return hs.get(hs.size() / 2);
    }

    private static final class Pair { Live tr; int di; double base, app, cost; }

    static Built buildTracklets(List<Sample> samples, double fw, double fh, Policy p) {
        Built out = new Built();
        List<Live> active = new ArrayList<>();
        List<Box> prevObserved = new ArrayList<>();
        for (int si = 0; si < samples.size(); si++) {
            double t = samples.get(si).t;
            List<Det> dets = new ArrayList<>();
            for (Det d : samples.get(si).dets) if (d.box.height >= p.minHeightPx && d.score >= p.scoreKeep) dets.add(d);
            boolean[] onScreen = screenDetections(dets, fw, fh, p);
            Shift shift;
            if (si == 0) shift = new Shift(0, 0, 0);
            else {
                List<Box> now = new ArrayList<>();
                for (int di = 0; di < dets.size(); di++) if (dets.get(di).score >= p.scoreNew && !onScreen[di]) now.add(dets.get(di).box);
                shift = estimateShift(prevObserved, now, fw, fh);
            }
            out.shifts.add(shift);
            for (int i = active.size() - 1; i >= 0; i--) if (t - active.get(i).lastT > p.trackDeathSec + 1e-6) active.remove(i);
            for (Live tr : active) {
                tr.refH = p.sizeRefSec > 0 ? refHeight(tr.tr.obs, p.sizeRefSec) : null;
                tr.camX += shift.dx; tr.camY += shift.dy;
                double dt = t - tr.lastT;
                tr.pred = shiftBox(tr.lastBox, tr.camX + tr.vx * dt, tr.camY + tr.vy * dt);
                tr.missSec = dt;
            }
            Map<Integer, Integer> assigned = new HashMap<>();
            Set<Integer> used = new HashSet<>();
            for (int pass = 0; pass < 2; pass++) {
                double minScore = pass == 0 ? p.scoreNew : p.scoreKeep;
                boolean strict = pass == 1;
                List<Pair> list = new ArrayList<>();
                Map<Integer, Integer> contenders = new HashMap<>();
                for (Live tr : active) {
                    if (assigned.containsKey(tr.tr.id)) continue;
                    for (int di = 0; di < dets.size(); di++) {
                        if (used.contains(di)) continue;
                        Det d = dets.get(di);
                        if (d.score < minScore) continue;
                        double h = Math.max(tr.pred.height, 1);
                        double dist = centerDist(tr.pred, d.box) / h;
                        double gate = Math.min(p.gateMax, p.gateBase + p.gatePerSec * Math.max(0, tr.missSec - 1 / p.sampleHz)) * (strict ? 0.7 : 1);
                        if (dist > gate) continue;
                        double ratio = d.box.height / Math.max(1, tr.refH != null ? tr.refH : h);
                        if (ratio > p.sizeRatioMax || ratio < 1 / p.sizeRatioMax) continue;
                        double ov = iou(tr.pred, d.box);
                        if (strict && ov < 0.2) continue;
                        Double sim = similarity(tr.desc, d.desc);
                        Pair pr = new Pair();
                        pr.tr = tr; pr.di = di;
                        pr.base = p.wIou * (1 - ov) + p.wDist * Math.min(2, dist) + p.wSize * Math.abs(Math.log(ratio));
                        pr.app = sim == null ? 0.5 : 1 - sim;
                        list.add(pr);
                        contenders.merge(di, 1, Integer::sum);
                    }
                }
                for (Pair pr : list) {
                    double w = p.wAppConflict > 0 && contenders.get(pr.di) > 1 ? p.wAppConflict : p.wApp;
                    pr.cost = pr.base + w * pr.app;
                }
                list.sort((a, b) -> Double.compare(a.cost, b.cost));
                for (Pair pr : list) {
                    if (assigned.containsKey(pr.tr.tr.id) || used.contains(pr.di)) continue;
                    assigned.put(pr.tr.tr.id, pr.di); used.add(pr.di);
                }
            }
            List<Row> row = new ArrayList<>();
            for (Live tr : active) {
                Integer di = assigned.get(tr.tr.id);
                if (di == null) continue;
                Det d = dets.get(di);
                Box box = d.box.copy();
                double dt = t - tr.lastT;
                if (dt > 0) {
                    double vx = (cx(box) - (cx(tr.lastBox) + tr.camX)) / dt;
                    double vy = (cy(box) - (cy(tr.lastBox) + tr.camY)) / dt;
                    double capV = 3 * box.height, al = p.velAlpha;
                    tr.vx = (1 - al) * tr.vx + al * Math.max(-capV, Math.min(capV, vx));
                    tr.vy = (1 - al) * tr.vy + al * Math.max(-capV, Math.min(capV, vy));
                }
                tr.lastBox = box; tr.lastT = t; tr.camX = 0; tr.camY = 0;
                if (d.desc != null && d.desc.samples >= 60) tr.desc = d.desc;
                Obs ob = new Obs(t, si, box, d.score, d.desc, onScreen[di]);
                tr.tr.obs.add(ob);
                row.add(new Row(tr.tr.id, d, ob));
            }
            for (int di = 0; di < dets.size(); di++) {
                if (used.contains(di)) continue;
                Det d = dets.get(di);
                if (d.score < p.scoreNew) continue;
                if (d.zoom && p.zoomExtendOnly) continue;
                Box box = d.box.copy();
                Obs ob = new Obs(t, si, box, d.score, d.desc, onScreen[di]);
                Track track = new Track(out.tracks.size());
                track.obs.add(ob);
                out.tracks.add(track);
                active.add(new Live(track, box, t, d.desc != null && d.desc.samples >= 60 ? d.desc : null));
                row.add(new Row(track.id, d, ob));
            }
            out.perSample.add(row);
            prevObserved = new ArrayList<>();
            for (Row r : row) if (!r.obs.screen) prevObserved.add(r.obs.box);
        }
        for (Track tr : out.tracks) {
            int n = 0;
            for (Obs o : tr.obs) if (o.screen) n++;
            tr.screen = n >= 2 && n >= p.screenTrackShare * tr.obs.size();
        }
        return out;
    }

    /* ── 겉모습 기억 ────────────────────────────────────────────────── */

    static Double galleryScore(List<Desc> gallery, List<Desc> descs) {
        List<Desc> usable = new ArrayList<>();
        for (Desc d : descs) if (d != null && d.samples >= 60) usable.add(d);
        if (gallery.isEmpty() || usable.isEmpty()) return null;
        List<Double> per = new ArrayList<>();
        for (Desc d : usable) {
            List<Double> sims = new ArrayList<>();
            for (Desc g : gallery) { Double v = similarity(g, d); sims.add(v == null ? 0 : v); }
            sims.sort(Collections.reverseOrder());
            per.add(sims.size() > 1 ? (sims.get(0) + sims.get(1)) / 2 : sims.get(0));
        }
        Collections.sort(per);
        return per.get(per.size() / 2);
    }

    static Double gallerySelf(List<Desc> gallery) {
        List<Double> sims = new ArrayList<>();
        for (int i = 0; i < gallery.size(); i++) for (int j = i + 1; j < gallery.size(); j++) {
            Double v = similarity(gallery.get(i), gallery.get(j));
            if (v != null) sims.add(v);
        }
        if (sims.size() < 3) return null;
        Collections.sort(sims);
        return sims.get(sims.size() / 2);
    }

    private static boolean isolated(Box box, List<Box> others) {
        for (Box o : others) if (!(iou(box, o) < 0.05 && centerDist(box, o) > 0.6 * Math.max(box.height, o.height))) return false;
        return true;
    }

    /* ── 대상 잇기 ──────────────────────────────────────────────────── */

    static Link linkTarget(Input in, Policy p) {
        try {
            return linkTargetInner(in, p);
        } finally {
            cueCtx = null;
        }
    }

    private static LinkedCues.Cue pickCue(Desc d, Policy p) {
        if (d == null) return null;
        return p.useFgCues && d.cuesFg != null ? d.cuesFg : d.cues;
    }

    private static CueCtx pickCueContext(Input in, Policy p, List<List<Row>> perSample, int seedTrack, Track seedTr, int s0, Set<Integer> screenIds) {
        if (!(p.cueGain > 0) || !(p.cueAdapt || p.useFgCues)) return null;
        List<LinkedCues.Cue> self = new ArrayList<>(), ring = new ArrayList<>(), others = new ArrayList<>();
        for (Desc d : in.seedDescs) {
            LinkedCues.Cue c = pickCue(d, p);
            if (c != null) self.add(c);
            if (d != null && d.ring != null) ring.add(d.ring);
        }
        double t0 = in.samples.get(s0).t;
        for (Obs ob : seedTr.obs) {
            if (ob.si < s0) continue;
            if (ob.t > t0 + p.cueLearnSec + 1e-6) break;
            List<Row> oth = new ArrayList<>();
            List<Box> othBoxes = new ArrayList<>();
            for (Row r : perSample.get(ob.si)) if (r.trackId != seedTrack) { oth.add(r); othBoxes.add(r.obs.box); }
            if (!isolated(ob.box, othBoxes)) continue;
            LinkedCues.Cue c = pickCue(ob.desc, p);
            if (c != null) self.add(c);
            if (ob.desc != null && ob.desc.ring != null) ring.add(ob.desc.ring);
            for (Row r : oth) {
                if (screenIds.contains(r.trackId)) continue;
                LinkedCues.Cue oc = pickCue(r.obs.desc, p);
                if (oc != null) others.add(oc);
            }
        }
        LinkedCues.Choice choice = p.cueAdapt
            ? LinkedCues.choose(self.subList(0, Math.min(8, self.size())), ring.subList(0, Math.min(8, ring.size())), others, LinkedCues.POLICY)
            : new LinkedCues.Choice(LinkedCues.DEFAULT.clone(), null, false);
        CueCtx c = new CueCtx();
        c.w = choice.w; c.gain = p.cueGain; c.useFg = p.useFgCues; c.adapted = choice.adapted;
        return c;
    }

    private static List<Obs> obsIn(Track tr, double from, double to) {
        List<Obs> out = new ArrayList<>();
        if (tr == null) return out;
        for (Obs o : tr.obs) if (o.t >= from - 1e-6 && o.t <= to + 1e-6) out.add(o);
        return out;
    }

    private static double[] velocity(List<Obs> list) {
        if (list.size() < 2) return null;
        Obs a = list.get(0), b = list.get(list.size() - 1);
        double dt = b.t - a.t;
        if (dt < 0.3) return null;
        return new double[]{(cx(b.box) - cx(a.box)) / dt, (cy(b.box) - cy(a.box)) / dt};
    }

    private static Double vdist(double[] p, double[] q) { return p != null && q != null ? Math.hypot(p[0] - q[0], p[1] - q[1]) : null; }

    private static Double meanSim(List<Obs> listA, List<Obs> listB) {
        List<Desc> a = new ArrayList<>(), b = new ArrayList<>();
        for (Obs o : listA) if (o.desc != null && o.desc.samples >= 60) a.add(o.desc);
        for (Obs o : listB) if (o.desc != null && o.desc.samples >= 60) b.add(o.desc);
        if (a.isEmpty() || b.isEmpty()) return null;
        double s = 0; int n = 0;
        for (Desc x : a) for (Desc y : b) { Double v = similarity(x, y); s += v == null ? 0 : v; n++; }
        return s / n;
    }

    private static List<Desc> descsOf(List<Obs> list) {
        List<Desc> out = new ArrayList<>();
        for (Obs o : list) if (o.desc != null) out.add(o.desc);
        return out;
    }

    static final class Verdict { boolean swap, ambiguous; int pick; double score, app, motion; }

    /** 두 사람이 겹쳤다 갈라진 뒤 누가 대상인가 — 웹 judgeExchange. */
    static Verdict judgeExchange(Track a, Track b, Track n, double tMerge, double tSplit, List<Desc> gallery, Policy p, boolean distOnly) {
        if (a == null || b == null || n == null) return null;
        if (distOnly && p.contactDistinctMax < 1) {
            Double pair = meanSim(obsIn(a, tMerge - 1.5, tMerge - 0.05), obsIn(n, tMerge - 1.5, tMerge - 0.05));
            if (pair == null || pair > p.contactDistinctMax) return null;
        }
        List<Obs> preA = obsIn(a, tMerge - 1.5, tMerge - 0.05);
        List<Obs> preN = obsIn(n, tMerge - 1.5, tMerge);
        List<Obs> postA = obsIn(a, tSplit + 0.05, tSplit + 1.6);
        List<Obs> postB = obsIn(b, tSplit, tSplit + 1.6);
        if (postA.size() < 2 || postB.size() < 2) return null;
        double h = Math.max(1, (!preA.isEmpty() ? preA.get(preA.size() - 1) : postA.get(0)).box.height);
        double[] vT = velocity(preA), vN = n == b ? velocity(obsIn(b, tMerge - 1.5, tMerge - 0.05)) : velocity(preN);
        double[] vA = velocity(postA), vB = velocity(postB);
        double motion = 0;
        Double kA = vdist(vA, vT), kB = vdist(vB, vN), sA = vdist(vB, vT), sB = vdist(vA, vN);
        if (kA != null && sA != null) {
            double keep = kA + (kB != null ? kB : 0), swap = sA + (sB != null ? sB : 0);
            motion = Math.max(-3, Math.min(3, (keep - swap) / h));
        }
        List<Obs> preNref = n == b ? obsIn(b, tMerge - 1.5, tMerge - 0.05) : preN;
        double app = 0;
        Double gA = galleryScore(gallery, descsOf(postA)), gB = galleryScore(gallery, descsOf(postB));
        Double tA = meanSim(preA, postA), tB = meanSim(preA, postB), nA = meanSim(preNref, postA), nB = meanSim(preNref, postB);
        if (tA != null && tB != null && nA != null && nB != null) app = (tB + nA) - (tA + nB);
        else if (gA != null && gB != null) app = gB - gA;
        double score = 8 * app + 0.6 * motion;
        Verdict v = new Verdict();
        v.swap = score > p.swapScoreMin && app >= p.swapAppMin;
        boolean keep = score < -0.6;
        v.ambiguous = !v.swap && !keep;
        v.pick = score > 0 ? b.id : a.id;
        v.score = score; v.app = app; v.motion = motion;
        return v;
    }

    private static final class Exchange { int b, n; double tMerge; Double tSplit; Integer fromSi; boolean distOnly; }
    private static final class Contact { double t, minD; int minSi; boolean iouHit; }
    private static final class Neighbor { double t, h; }

    private static Link linkTargetInner(Input in, Policy p) {
        List<Sample> samples = in.samples;
        Built built = in.built;
        Link link = new Link();
        if (samples.isEmpty()) { link.ok = false; link.reason = "no-samples"; return link; }
        int s0 = 0;
        for (int i = 1; i < samples.size(); i++) if (Math.abs(samples.get(i).t - in.seedT) < Math.abs(samples.get(s0).t - in.seedT)) s0 = i;
        int seedTrack = -1; double seedOv = 0;
        for (int k = 0; k <= 2 && s0 + k < samples.size(); k++) {
            if (k > 0 && seedOv >= 0.3) break;
            for (Row r : built.perSample.get(s0 + k)) {
                double ov = iou(in.seedBox, r.obs.box);
                boolean inside = cx(r.obs.box) >= in.seedBox.x && cx(r.obs.box) <= in.seedBox.x + in.seedBox.width
                    && cy(r.obs.box) >= in.seedBox.y && cy(r.obs.box) <= in.seedBox.y + in.seedBox.height;
                double ratio = r.obs.box.height / Math.max(1, in.seedBox.height);
                double score = ov + (inside && ratio > 0.5 && ratio < 2 ? 0.15 : 0);
                if (score > seedOv) { seedOv = score; seedTrack = r.trackId; }
            }
        }
        link.seedOverlap = seedOv;
        if (seedTrack < 0 || seedOv < 0.3) { link.ok = false; link.reason = "seed-not-detected"; return link; }
        List<Track> tracks = built.tracks;
        List<List<Row>> perSample = built.perSample;
        Map<Integer, Track> trackById = new HashMap<>();
        for (Track tr : tracks) trackById.put(tr.id, tr);
        Set<Integer> forbidden = new HashSet<>();
        for (int ri = 0; ri < in.rejectedBoxes.size(); ri++) {
            double rt = in.rejectedTimes.get(ri); Box rb = in.rejectedBoxes.get(ri);
            int best = -1; double bv = 0;
            for (int si = 0; si < samples.size(); si++) {
                if (Math.abs(samples.get(si).t - rt) > 0.11) continue;
                for (Row r : perSample.get(si)) { double v = iou(rb, r.obs.box); if (v > bv) { bv = v; best = r.trackId; } }
            }
            if (best >= 0 && bv >= 0.3 && best != seedTrack) forbidden.add(best);
        }
        Track seedTr = trackById.get(seedTrack);
        Set<Integer> screenIds = new HashSet<>();
        if (!seedTr.screen) for (Track tr : tracks) if (tr.screen && tr.id != seedTrack) screenIds.add(tr.id);
        forbidden.addAll(screenIds);
        cueCtx = pickCueContext(in, p, perSample, seedTrack, seedTr, s0, screenIds);

        List<Desc> gallery = new ArrayList<>();
        for (Desc d : in.seedDescs) if (d != null && d.samples >= 60) gallery.add(d);
        final int seedDescN = in.seedDescs.size();
        List<Desc> otherDescs = new ArrayList<>();
        List<Integer> otherDescOwner = new ArrayList<>();
        Map<Integer, Integer> partners = new HashMap<>();
        List<Desc>[] galleryAtRisk = new List[]{null};
        Set<Integer> otherTracks = new HashSet<>();
        State[] state = new State[samples.size()];
        Set<Integer> targetObsTimes = new HashSet<>();
        Ask ask = null;
        int current = seedTrack, fromSi = s0;
        Double selfFloor = null;
        for (int guard = 0; guard < 400; guard++) {
            Track tr = trackById.get(current);
            int lastSi = fromSi;
            Integer switchTo = null; int switchSi = -1; Verdict switchVerdict = null;
            Map<Integer, Obs> obsBySi = new HashMap<>();
            for (Obs o : tr.obs) obsBySi.put(o.si, o);
            Map<Integer, Neighbor> neighbors = new LinkedHashMap<>();
            Map<Integer, Contact> contacts = new LinkedHashMap<>();
            for (int si = fromSi; si < samples.size(); si++) {
                Obs ob = obsBySi.get(si);
                if (ob == null) {
                    if (p.riskPartners) for (Map.Entry<Integer, Neighbor> e : neighbors.entrySet()) if (samples.get(si).t - e.getValue().t < 0.45) markRisk(p, partners, galleryAtRisk, gallery, e.getKey(), si);
                    if (samples.get(si).t - samples.get(lastSi).t > p.trackDeathSec) break;
                    continue;
                }
                lastSi = si;
                state[si] = State.obs(current, ob.box, ob.score);
                targetObsTimes.add(si);
                List<Row> others = new ArrayList<>();
                List<Box> othersBoxes = new ArrayList<>();
                for (Row r : perSample.get(si)) if (r.trackId != current) { others.add(r); othersBoxes.add(r.obs.box); }
                for (Row r : others) {
                    otherTracks.add(r.trackId);
                    if (r.obs.desc != null && otherDescs.size() < 400 && !screenIds.contains(r.trackId) && isolated(r.obs.box, Collections.singletonList(ob.box))) { otherDescs.add(r.obs.desc); otherDescOwner.add(r.trackId); }
                }
                if (isolated(ob.box, othersBoxes)) remember(gallery, ob.desc, p.galleryMax, seedDescN);
                double t = samples.get(si).t;
                List<Exchange> exchanges = new ArrayList<>();
                for (Row r : others) {
                    boolean born = trackById.get(r.trackId).obs.get(0).si == si;
                    double h = ob.box.height;
                    boolean sizeOk = r.obs.box.height / h > 0.6 && r.obs.box.height / h < 1.67;
                    if (born && sizeOk && !nearEdge(r.obs.box, in.frameW, in.frameH, p.edgeMargin) && centerDist(r.obs.box, ob.box) < 1.3 * h) {
                        Integer vanishedId = null; double vanishedT = 0;
                        for (Map.Entry<Integer, Neighbor> e : neighbors.entrySet()) {
                            int nid = e.getKey(); Neighbor nb = e.getValue();
                            if (nb.h / h < 0.6 || nb.h / h > 1.67) continue;
                            boolean present = false;
                            for (Row x : perSample.get(si)) if (x.trackId == nid) { present = true; break; }
                            if (nid == r.trackId || nid == current || present) continue;
                            if (t - nb.t < 0.3 || t - nb.t > 3) continue;
                            if (vanishedId == null || nb.t > vanishedT) { vanishedId = nid; vanishedT = nb.t; }
                        }
                        if (vanishedId != null) { Exchange ex = new Exchange(); ex.b = r.trackId; ex.n = vanishedId; ex.tMerge = vanishedT; exchanges.add(ex); }
                    }
                    double dH = centerDist(ob.box, r.obs.box) / h;
                    boolean iouHit = iou(ob.box, r.obs.box) >= p.contactIou;
                    if (sizeOk && (iouHit || dH < 0.8)) markRisk(p, partners, galleryAtRisk, gallery, r.trackId, si);
                    boolean touching = sizeOk && (iouHit || (p.contactDistH > 0 && dH < p.contactDistH));
                    if (touching && !contacts.containsKey(r.trackId)) { Contact c = new Contact(); c.t = t; c.minD = dH; c.minSi = si; c.iouHit = iouHit; contacts.put(r.trackId, c); }
                    else if (touching) { Contact c = contacts.get(r.trackId); c.iouHit |= iouHit; if (dH < c.minD) { c.minD = dH; c.minSi = si; } }
                    else if (contacts.containsKey(r.trackId)) {
                        Contact c = contacts.get(r.trackId);
                        Exchange ex = new Exchange(); ex.b = r.trackId; ex.n = r.trackId; ex.tMerge = c.t; ex.fromSi = p.contactDistH > 0 ? c.minSi : null; ex.distOnly = !c.iouHit;
                        exchanges.add(ex);
                        contacts.remove(r.trackId);
                    }
                }
                if (p.jumpDevMin > 0) {
                    List<Obs> hist = new ArrayList<>();
                    for (Obs o : obsIn(tr, t - 0.85, t - 0.05)) if (o.si >= fromSi) hist.add(o);
                    double[] v = velocity(hist);
                    if (v != null && hist.size() >= 3) {
                        Obs last = hist.get(hist.size() - 1);
                        Box pred = shiftBox(last.box, v[0] * (t - last.t), v[1] * (t - last.t));
                        double h = Math.max(1, last.box.height);
                        double devA = centerDist(pred, ob.box) / h;
                        if (devA > p.jumpDevMin) {
                            Row bestR = null; double bestDev = 0;
                            for (Row r : others) {
                                if (forbidden.contains(r.trackId)) continue;
                                double ratio = r.obs.box.height / h;
                                if (ratio < 0.6 || ratio > 1.67) continue;
                                double devB = centerDist(pred, r.obs.box) / h;
                                if (devB < devA * p.jumpRatio && (bestR == null || devB < bestDev)) { bestR = r; bestDev = devB; }
                            }
                            if (bestR != null) {
                                boolean dup = false;
                                for (Exchange x : exchanges) if (x.b == bestR.trackId) { dup = true; break; }
                                if (!dup) { Exchange ex = new Exchange(); ex.b = bestR.trackId; ex.n = bestR.trackId; ex.tMerge = t; ex.tSplit = t - 0.05; exchanges.add(ex); }
                            }
                        }
                    }
                }
                for (Row r : others) if (centerDist(r.obs.box, ob.box) < 1.5 * ob.box.height) { Neighbor nb = new Neighbor(); nb.t = t; nb.h = r.obs.box.height; neighbors.put(r.trackId, nb); }
                for (Exchange ex : exchanges) {
                    Verdict verdict = judgeExchange(trackById.get(current), trackById.get(ex.b), trackById.get(ex.n), ex.tMerge, ex.tSplit != null ? ex.tSplit : t, gallery, p, ex.distOnly);
                    if (verdict != null && verdict.swap && !forbidden.contains(ex.b)) {
                        int back = ex.fromSi != null && ex.fromSi > fromSi && ex.fromSi < si ? ex.fromSi : si;
                        for (int k = back; k < si; k++) { state[k] = null; targetObsTimes.remove(k); }
                        switchTo = ex.b; switchSi = back; switchVerdict = verdict;
                        break;
                    }
                    if (verdict != null && verdict.ambiguous && p.crossingAsk && !forbidden.contains(ex.b) && mayAsk(in, p, samples.get(si).t) && ask == null) {
                        ask = new Ask(); ask.si = si; ask.t = samples.get(si).t; ask.reason = "crossing-ambiguous"; ask.proposalTrackId = verdict.pick;
                    }
                }
                if (switchTo != null || ask != null) break;
            }
            if (ask != null) break;
            if (switchTo != null) {
                link.decisions.add(new Decision("swap", samples.get(switchSi).t).put("from", current).put("to", switchTo).put("score", switchVerdict.score));
                otherTracks.add(current);
                current = switchTo;
                fromSi = switchSi;
                continue;
            }
            if (lastSi >= samples.size() - 1) break;
            double lostT = samples.get(lastSi).t;
            Box lostBox = state[lastSi] != null ? state[lastSi].box : null;
            double lostH = lostBox != null ? lostBox.height : 1;
            boolean exited = lostBox != null && nearEdge(lostBox, in.frameW, in.frameH, p.edgeMargin * 2);
            Obs lastObs = null;
            for (Obs o : tr.obs) if (o.si == lastSi) { lastObs = o; break; }
            int[] hand = p.handoverMaxGapSec > 0 ? handoverAfterLoss(tracks, current, lastSi, built.shifts, forbidden, gallery, p, lastObs) : null;
            if (hand != null) {
                link.decisions.add(new Decision("handover", samples.get(hand[1]).t).put("from", current).put("trackId", hand[0]));
                for (int si = lastSi + 1; si < hand[1]; si++) state[si] = null;
                current = hand[0];
                fromSi = hand[1];
                continue;
            }
            Object[] stitch = p.stitchMaxGapSec <= 0 ? null : stitchAfterLoss(tracks, trackById, current, lastSi, built.shifts, targetObsTimes, forbidden, gallery, p);
            if (stitch != null) {
                int sTrack = (Integer) stitch[0], sFirst = (Integer) stitch[1]; Integer rival = (Integer) stitch[2];
                link.decisions.add(new Decision("stitch", samples.get(sFirst).t).put("trackId", sTrack));
                if (rival != null && mayAsk(in, p, samples.get(sFirst).t)) {
                    ask = new Ask(); ask.si = sFirst; ask.t = samples.get(sFirst).t; ask.reason = "reentry-ambiguous"; ask.proposalTrackId = sTrack; ask.rival = rival;
                    break;
                }
                for (int si = lastSi + 1; si < sFirst; si++) state[si] = null;
                current = sTrack;
                fromSi = sFirst;
                continue;
            }
            List<Cand> cands = new ArrayList<>();
            for (Track cand : tracks) {
                boolean partner = p.riskPartners && partners.containsKey(cand.id);
                if (cand.id == current || forbidden.contains(cand.id) || (otherTracks.contains(cand.id) && !partner)) continue;
                Obs born = cand.obs.get(0);
                boolean old = born.t <= lostT + 1e-6;
                if (old && !partner) continue;
                Obs first = null;
                if (old) { for (Obs o : cand.obs) if (o.t > lostT + 1e-6) { first = o; break; } } else first = born;
                if (first == null) continue;
                boolean overlapTarget = false;
                for (Obs o : cand.obs) if (o.t >= first.t - 1e-6 && targetObsTimes.contains(o.si)) { overlapTarget = true; break; }
                if (overlapTarget) continue;
                double gap = first.t - lostT;
                double[] camAcc = accumulatedShift(built.shifts, lastSi, first.si);
                double fromLost = lostBox != null ? centerDist(shiftBox(lostBox, camAcc[0], camAcc[1]), first.box) / Math.max(lostH, first.box.height) : Double.POSITIVE_INFINITY;
                double nearLimit = p.occludedNearBase + p.occludedNearPerSec * gap;
                boolean entering = nearEdge(first.box, in.frameW, in.frameH, p.edgeMargin * 2);
                boolean nearLoss = fromLost <= nearLimit;
                if (!entering && !nearLoss && !partner) continue;
                List<Desc> descs = new ArrayList<>();
                for (Obs o : cand.obs) if (o.t >= first.t - 1e-6 && o.t - first.t <= 3 && o.desc != null && descs.size() < p.trackDescMax) descs.add(o.desc);
                List<Desc> refGallery = partner && galleryAtRisk[0] != null && !galleryAtRisk[0].isEmpty() ? galleryAtRisk[0] : gallery;
                List<Desc> negGallery = otherDescs;
                if (partner) { negGallery = new ArrayList<>(); for (int i = 0; i < otherDescs.size(); i++) if (otherDescOwner.get(i) != cand.id) negGallery.add(otherDescs.get(i)); }
                Double sim = galleryScore(refGallery, descs);
                Double neg = galleryScore(negGallery, descs);
                if (sim == null) continue;
                Cand c = new Cand();
                c.trackId = cand.id; c.firstSi = first.si; c.t = first.t; c.sim = sim; c.neg = neg != null ? neg : 0; c.margin = sim - c.neg;
                c.entering = entering; c.nearLoss = nearLoss; c.gap = gap; c.fromLost = fromLost; c.lastT = cand.obs.get(cand.obs.size() - 1).t;
                cands.add(c);
            }
            Double selfNow = gallerySelf(gallery);
            if (selfNow != null) selfFloor = Math.max(selfFloor != null ? selfFloor : 0, selfNow);
            Double selfRef = selfFloor;
            List<Cand> passing = new ArrayList<>();
            for (Cand c : cands) if (c.sim >= p.reentrySimMin && c.margin >= p.reentryMarginMin && (selfRef == null || c.sim >= selfRef - p.reentrySelfDrop)) passing.add(c);
            link.decisions.add(new Decision("lost", lostT).put("exited", exited).put("candidates", cands.size()).put("passing", passing.size()));
            if (passing.isEmpty()) break;
            List<Cand> quick = new ArrayList<>();
            for (Cand c : passing) if (p.reentryNearFirstSec > 0 && c.nearLoss && c.gap <= p.reentryNearFirstSec + 1e-6) quick.add(c);
            List<Cand> pool = !quick.isEmpty() ? quick : passing;
            Cand best = pool.get(0);
            for (Cand c : pool) if (c.sim > best.sim) best = c;
            Cand chosen = null;
            for (Cand c : pool) if (c.sim >= best.sim - p.reentryEarlierWithin && (chosen == null || c.t < chosen.t)) chosen = c;
            Cand rival = null;
            for (Cand c : passing) if (c.trackId != chosen.trackId && c.t <= chosen.lastT && c.lastT >= chosen.t && Math.abs(c.sim - chosen.sim) < p.reentryAmbiguous) { rival = c; break; }
            link.decisions.add(new Decision("reentry", chosen.t).put("trackId", chosen.trackId).put("sim", chosen.sim).put("neg", chosen.neg).put("rival", rival != null ? rival.trackId : null));
            boolean unsure = false;
            if (p.askUnclearMargin > 0) for (Cand c : cands) if (c.trackId != chosen.trackId && Math.abs(c.t - chosen.t) <= p.askUnclearWindowSec && c.sim > chosen.sim - p.askUnclearMargin) { unsure = true; break; }
            if ((rival != null || unsure) && mayAsk(in, p, chosen.t)) {
                ask = new Ask(); ask.si = chosen.firstSi; ask.t = chosen.t; ask.reason = "reentry-ambiguous"; ask.proposalTrackId = chosen.trackId; ask.rival = rival != null ? rival.trackId : null;
                for (int si = lastSi + 1; si < chosen.firstSi; si++) state[si] = State.absent(exited);
                break;
            }
            for (int si = lastSi + 1; si < chosen.firstSi; si++) { State s = State.absent(exited); s.reentryAt = chosen.t; state[si] = s; }
            current = chosen.trackId;
            fromSi = chosen.firstSi;
        }
        int endSi = ask != null ? ask.si : samples.size();
        int lastObsSi = -1;
        for (int si = s0; si < endSi; si++) {
            if (state[si] != null && "obs".equals(state[si].kind)) lastObsSi = si;
            else if (state[si] == null) state[si] = State.absent(false);
        }
        for (int si = s0; si < endSi; si++) {
            if (state[si] == null || !"absent".equals(state[si].kind)) continue;
            int a = si - 1; while (a >= s0 && !(state[a] != null && "obs".equals(state[a].kind))) a--;
            int b = si + 1; while (b < endSi && !(state[b] != null && "obs".equals(state[b].kind))) b++;
            if (a >= s0 && b < endSi && state[a].trackId == state[b].trackId && samples.get(b).t - samples.get(a).t <= p.trackDeathSec + 0.25) {
                for (int k = a + 1; k < b; k++) {
                    double f = (samples.get(k).t - samples.get(a).t) / (samples.get(b).t - samples.get(a).t);
                    State g = new State(); g.kind = "gap"; g.trackId = state[a].trackId; g.box = lerpBox(state[a].box, state[b].box, f);
                    g.longGap = samples.get(b).t - samples.get(a).t > p.warnGapSec;
                    state[k] = g;
                }
            }
        }
        if (ask != null) {
            Track tr = trackById.get(ask.proposalTrackId);
            Obs ob = null;
            if (tr != null) { for (Obs o : tr.obs) if (o.si >= ask.si) { ob = o; break; } if (ob == null) ob = tr.obs.get(0); }
            ask.proposalBox = ob != null ? ob.box : null;
            ask.proposalT = ob != null ? ob.t : ask.t;
            for (int si = Math.min(ask.si, samples.size() - 1); si >= s0; si--) if (state[si] != null && "obs".equals(state[si].kind)) { ask.lastBox = state[si].box; break; }
        }
        link.ok = true; link.seedTrack = seedTrack; link.s0 = s0; link.state = state; link.ask = ask; link.lastObsSi = lastObsSi;
        link.galleryN = gallery.size(); link.othersN = otherDescs.size(); link.screenTracks = screenIds.size();
        link.cueAdapted = cueCtx != null && cueCtx.adapted;
        return link;
    }

    private static void markRisk(Policy p, Map<Integer, Integer> partners, List<Desc>[] galleryAtRisk, List<Desc> gallery, int trackId, int si) {
        if (!p.riskPartners || partners.containsKey(trackId)) return;
        partners.put(trackId, si);
        if (galleryAtRisk[0] == null) galleryAtRisk[0] = new ArrayList<>(gallery);
    }

    private static void remember(List<Desc> list, Desc desc, int max, int seedDescN) {
        if (desc == null || desc.samples < 60) return;
        list.add(desc);
        if (list.size() > max) list.remove(seedDescN > 0 ? 1 : 0);
    }

    private static boolean mayAsk(Input in, Policy p, double t) {
        return in.stopOnAsk && !in.followThrough && !(in.askNotBefore != null && t < in.askNotBefore) && t >= in.seedT + p.askRearmSec;
    }

    /** 끊긴 대상 줄을 바로 이어 줄 새 줄 — {trackId, firstSi, rival|null}. 웹 stitchAfterLoss. */
    private static Object[] stitchAfterLoss(List<Track> tracks, Map<Integer, Track> trackById, int current, int lastSi, List<Shift> shifts, Set<Integer> targetObsTimes, Set<Integer> forbidden, List<Desc> gallery, Policy p) {
        Track tr = trackById.get(current);
        Obs last = null;
        for (Obs o : tr.obs) if (o.si <= lastSi) last = o;
        if (last == null) return null;
        List<Obs> recent = new ArrayList<>();
        for (Obs o : tr.obs) if (o.t >= last.t - 1 && o.si <= lastSi) recent.add(o);
        double[] v = velocity(recent);
        if (v == null) v = new double[]{0, 0};
        double h = last.box.height;
        Double selfRef = gallerySelf(gallery);
        List<double[]> list = new ArrayList<>(); /* {trackId, firstSi, cost, firstT} */
        for (Track cand : tracks) {
            if (cand.id == current || forbidden.contains(cand.id)) continue;
            Obs first = cand.obs.get(0);
            double gap = first.t - last.t;
            if (gap <= 1e-6 || gap > p.stitchMaxGapSec) continue;
            boolean hit = false;
            for (Obs o : cand.obs) if (targetObsTimes.contains(o.si)) { hit = true; break; }
            if (hit) continue;
            double ratio = first.box.height / h;
            if (ratio < 0.6 || ratio > 1.67) continue;
            double[] cam = accumulatedShift(shifts, last.si, first.si);
            Box pred = shiftBox(last.box, cam[0] + v[0] * gap, cam[1] + v[1] * gap);
            double dist = centerDist(pred, first.box) / Math.max(h, first.box.height);
            if (dist > p.stitchNearBase + p.stitchNearPerSec * gap) continue;
            List<Desc> descs = new ArrayList<>();
            for (Obs o : cand.obs) if (o.t - first.t <= 2 && o.desc != null) descs.add(o.desc);
            Double sim = galleryScore(gallery, descs);
            if (sim != null && selfRef != null && sim < selfRef - p.stitchSelfDrop) continue;
            double cost = dist + 0.4 * gap + (sim == null ? 0.3 : 2 * Math.max(0, (selfRef != null ? selfRef : sim) - sim));
            list.add(new double[]{cand.id, first.si, cost, first.t});
        }
        if (list.isEmpty()) return null;
        list.sort((a, b) -> Double.compare(a[2], b[2]));
        double[] best = list.get(0);
        double[] second = null;
        for (double[] c : list) if (c[0] != best[0] && Math.abs(c[3] - best[3]) < 0.6) { second = c; break; }
        Integer rival = second != null && second[2] - best[2] < p.stitchAmbiguous ? (int) second[0] : null;
        return new Object[]{(int) best[0], (int) best[1], rival};
    }

    private static double joinCost(Obs a, Obs b, List<Shift> shifts) {
        double[] cam = accumulatedShift(shifts, a.si, b.si);
        double dt = Math.max(0, b.t - a.t);
        double d = centerDist(shiftBox(a.box, cam[0], cam[1]), b.box) / Math.max(1, a.box.height) / (1 + 2 * dt);
        return d + Math.abs(Math.log(b.box.height / Math.max(1, a.box.height)));
    }

    /** 웹 handoverAfterLoss — {trackId, si} 또는 null. */
    private static int[] handoverAfterLoss(List<Track> tracks, int current, int lastSi, List<Shift> shifts, Set<Integer> forbidden, List<Desc> gallery, Policy p, Obs lastObs) {
        if (lastObs == null) return null;
        Double selfRef = gallerySelf(gallery);
        int[] best = null; double bestCost = 0;
        for (Track cand : tracks) {
            if (cand.id == current || forbidden.contains(cand.id)) continue;
            int k0 = -1;
            for (int i = 0; i < cand.obs.size(); i++) if (cand.obs.get(i).si > lastSi) { k0 = i; break; }
            if (k0 <= 0) continue;
            if (cand.obs.get(k0 - 1).t < lastObs.t - 0.5) continue;
            for (int k = k0; k < cand.obs.size() && cand.obs.get(k).t - lastObs.t <= p.handoverMaxGapSec + 1e-6; k++) {
                Obs ob = cand.obs.get(k), prev = cand.obs.get(k - 1);
                double cost = joinCost(lastObs, ob, shifts), selfCost = joinCost(prev, ob, shifts);
                if (cost > p.handoverMaxCost || cost + p.handoverMargin > selfCost) continue;
                List<Desc> descs = new ArrayList<>();
                for (Obs o : cand.obs.subList(k, cand.obs.size())) if (o.t - ob.t <= 2 && o.desc != null) descs.add(o.desc);
                Double sim = galleryScore(gallery, descs);
                if (sim != null && selfRef != null && sim < selfRef - p.stitchSelfDrop) continue;
                if (best == null || cost < bestCost) { best = new int[]{cand.id, ob.si}; bestCost = cost; }
                break;
            }
        }
        return best;
    }

    /* ── 궤적 ───────────────────────────────────────────────────────── */

    private static boolean live(State s) { return s != null && ("obs".equals(s.kind) || "gap".equals(s.kind)); }

    /** 표본 상태 → 편집기 궤적(초당 outFps 점). 웹 renderTrajectory. */
    static List<TrajPoint> renderTrajectory(List<Sample> samples, Link link, double startT, double endT, Policy p) {
        List<TrajPoint> out = new ArrayList<>();
        State[] state = link.state;
        int lastSi = link.ask != null ? link.ask.si : samples.size() - 1;
        Box lastBox = null;
        double tail = lastSi >= 0 && lastSi < samples.size() ? samples.get(lastSi).t : endT;
        int n = Math.max(1, (int) Math.floor((Math.min(endT, tail) - startT) * p.outFps + 1e-6));
        int si = link.s0;
        for (int i = 0; i <= n; i++) {
            double t = Math.min(startT + i / p.outFps, endT);
            while (si + 1 <= lastSi && samples.get(si + 1).t <= t + 1e-6) si++;
            State a = state[si];
            State b = si + 1 <= lastSi ? state[si + 1] : null;
            double ta = samples.get(si).t, tb = b != null ? samples.get(si + 1).t : ta;
            TrajPoint row = new TrajPoint();
            row.t = t;
            if (live(a) && live(b) && a.trackId == b.trackId && tb > ta) {
                double f = Math.max(0, Math.min(1, (t - ta) / (tb - ta)));
                row.box = lerpBox(a.box, b.box, f);
                boolean warn = ("gap".equals(a.kind) && a.longGap) || ("gap".equals(b.kind) && b.longGap);
                row.state = warn ? "TRACKING_WARNING" : "TRACKING_OK"; row.confidence = row.health = warn ? 0.55 : 0.9; row.reid = 0.9;
            } else if (live(a) && t - ta < 0.5 / p.sampleHz + 1e-6) {
                boolean warn = "gap".equals(a.kind) && a.longGap;
                row.box = a.box.copy();
                row.state = warn ? "TRACKING_WARNING" : "TRACKING_OK"; row.confidence = row.health = warn ? 0.55 : 0.9; row.reid = 0.9;
            } else if (live(b) && tb - t < 0.5 / p.sampleHz + 1e-6) {
                row.box = b.box.copy();
                row.state = "TRACKING_OK"; row.confidence = row.health = 0.85; row.reid = 0.9;
            } else {
                row.box = lastBox != null ? lastBox.copy() : new Box(0, 0, 0, 0);
                row.state = "TARGET_LOST"; row.confidence = row.health = row.reid = 0; row.engineAbsent = true;
            }
            if (!"TARGET_LOST".equals(row.state)) lastBox = row.box;
            row.frame = i;
            out.add(row);
        }
        return out;
    }
}
