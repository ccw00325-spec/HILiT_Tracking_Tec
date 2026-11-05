/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·5093d3de @license @preserve */
package app.hilit.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 스포츠 개인 추적 보조 — packages/hilit-vision 의 Java 사본.
 * 자동 재획득을 열지 않는다. 옆 사람으로의 점프만 막는다.
 */
final class SportsTrack {
    static final String AUTO_REACQUIRE_DEFAULT = "off";
    static final int TRACKLET_MIN_HITS = 3;
    static final float TRACKLET_SWITCH_BODIES = 0.8f;
    static final float TRACKLET_BIND_IOU = 0.35f;
    static final float JERSEY_ACCEPT = 0.72f;
    static final int JERSEY_TPL_W = 12;
    static final int JERSEY_TPL_H = 18;
    static final int TEAM_BINS = 8;
    static final float TEAM_SAME = 0.78f;
    static final float TEAM_DIFF = 0.52f;
    static final int COURT_MIN_LINES = 4;
    static final float COURT_MIN_QUALITY = 0.35f;
    static final float OCCLUSION_IOU_WIDEN = 0.22f;
    static final float OCCLUSION_MAX_WIDEN = 1.32f;
    static final float OFFLINE_AGREE_IOU = 0.5f;
    static final float OFFLINE_BRIDGE_SEC = 0.4f;

    static final class Box {
        final float x, y, width, height;
        Box(float x, float y, float width, float height) {
            this.x = x; this.y = y; this.width = width; this.height = height;
        }
        float cx() { return x + width / 2; }
        float cy() { return y + height / 2; }
    }

    static final class SwitchDecision {
        final String action, reason;
        final Integer subjectTrackletId, candidateTrackletId;
        final boolean identityConfirmed = false;
        final boolean eligibleForAutoReacquire = false;
        SwitchDecision(String action, String reason, Integer subjectId, Integer candidateId) {
            this.action = action;
            this.reason = reason;
            this.subjectTrackletId = subjectId;
            this.candidateTrackletId = candidateId;
        }
    }

    static final class SportsGateResult {
        final String action, reason;
        final boolean identityConfirmed = false;
        final boolean eligibleForAutoReacquire = false;
        SportsGateResult(String action, String reason) {
            this.action = action;
            this.reason = reason;
        }
    }

    static final class JerseyRead {
        final String digits;
        final float score, quality;
        final String reason;
        JerseyRead(String digits, float score, float quality, String reason) {
            this.digits = digits; this.score = score; this.quality = quality; this.reason = reason;
        }
    }

    static final class JerseyDecision {
        final String action, reason, locked, read;
        final boolean identityConfirmed = false;
        final boolean eligibleForAutoReacquire = false;
        JerseyDecision(String action, String reason, String locked, String read) {
            this.action = action; this.reason = reason; this.locked = locked; this.read = read;
        }
    }

    static final class TeamVector {
        final float[] hist;
        final int samples;
        TeamVector(float[] hist, int samples) { this.hist = hist; this.samples = samples; }
    }

    static final class TeamDecision {
        final Boolean sameTeam;
        final Float score;
        final String reason;
        final boolean identityConfirmed = false;
        TeamDecision(Boolean sameTeam, Float score, String reason) {
            this.sameTeam = sameTeam; this.score = score; this.reason = reason;
        }
    }

    static final class CourtPoint {
        final float x, y;
        CourtPoint(float x, float y) { this.x = x; this.y = y; }
    }

    static final class CourtHintResult {
        final boolean usable;
        final float quality;
        final String reason;
        final int lineCount;
        final CourtPoint foot;
        CourtHintResult(boolean usable, float quality, String reason, int lineCount, CourtPoint foot) {
            this.usable = usable; this.quality = quality; this.reason = reason;
            this.lineCount = lineCount; this.foot = foot;
        }
    }

    static final class OcclusionResult {
        final float cropShare, overlap;
        final boolean widened;
        OcclusionResult(float cropShare, float overlap, boolean widened) {
            this.cropShare = cropShare; this.overlap = overlap; this.widened = widened;
        }
    }

    static final class EventScore {
        final float score;
        final List<String> reason;
        final boolean usedGlobalShake = false;
        EventScore(float score, List<String> reason) { this.score = score; this.reason = reason; }
    }

    static final class OfflineBox {
        final double t;
        final float x, y, width, height;
        final boolean observed;
        OfflineBox(double t, float x, float y, float width, float height, boolean observed) {
            this.t = t; this.x = x; this.y = y; this.width = width; this.height = height; this.observed = observed;
        }
    }

    static final class OfflinePoint {
        final double t;
        Box box;
        String state;
        boolean observed;
        final boolean identityConfirmed = false;
        final boolean eligibleForAutoReacquire = false;
        String reason;
        OfflinePoint(double t, Box box, String state, boolean observed, String reason) {
            this.t = t; this.box = box; this.state = state; this.observed = observed; this.reason = reason;
        }
    }

    private static final class Tracklet {
        final int id;
        Box box;
        float vx, vy;
        double lastT, startT;
        int hits, misses;
        Tracklet(int id, Box box, double t) {
            this.id = id; this.box = box; this.lastT = t; this.startT = t; this.hits = 1;
        }
    }

    static float boxIou(Box a, Box b) {
        float x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        float x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
        float w = x2 - x1, h = y2 - y1;
        if (w <= 0 || h <= 0) return 0;
        float inter = w * h;
        float union = a.width * a.height + b.width * b.height - inter;
        return union <= 0 ? 0 : inter / union;
    }

    static final class TrackletGraph {
        private final List<Tracklet> items = new ArrayList<>();
        private int nextId = 1;
        Integer subjectId = null;

        void clear() {
            items.clear();
            nextId = 1;
            subjectId = null;
        }

        int[] update(double t, List<Box> detections, AffineGmc.Affine affine, Box subject) {
            List<Box> dets = new ArrayList<>();
            for (Box b : detections) if (b.width > 4 && b.height > 4) dets.add(b);
            if (dets.size() < 2) return new int[0];
            List<Box> predictedBoxes = new ArrayList<>();
            for (Tracklet item : items) {
                float dt = (float) Math.max(0, t - item.lastT);
                Box box = new Box(item.box.x + item.vx * dt, item.box.y + item.vy * dt, item.box.width, item.box.height);
                if (affine != null && affine.isFinite()) {
                    AffineGmc.Box moved = AffineGmc.applyToBox(new AffineGmc.Box(box.x, box.y, box.width, box.height), affine);
                    box = new Box(moved.x, moved.y, moved.width, moved.height);
                }
                predictedBoxes.add(box);
            }
            Set<Integer> usedT = new HashSet<>();
            Set<Integer> usedD = new HashSet<>();
            List<float[]> pairs = new ArrayList<>();
            for (int ti = 0; ti < predictedBoxes.size(); ti++) {
                for (int di = 0; di < dets.size(); di++) {
                    float overlap = boxIou(predictedBoxes.get(ti), dets.get(di));
                    float moved = (float) Math.hypot(
                        predictedBoxes.get(ti).cx() - dets.get(di).cx(),
                        predictedBoxes.get(ti).cy() - dets.get(di).cy());
                    if (moved > Math.max(8, items.get(ti).box.width) * 3.2f) continue;
                    pairs.add(new float[]{ti, di, moved / Math.max(8, items.get(ti).box.width) - overlap});
                }
            }
            Collections.sort(pairs, new Comparator<float[]>() {
                @Override public int compare(float[] a, float[] b) { return Float.compare(a[2], b[2]); }
            });
            int[] assigned = new int[dets.size()];
            for (float[] p : pairs) {
                int ti = (int) p[0], di = (int) p[1];
                if (usedT.contains(ti) || usedD.contains(di)) continue;
                usedT.add(ti);
                usedD.add(di);
                Tracklet item = items.get(ti);
                Box det = dets.get(di);
                float dt = (float) Math.max(1e-3, t - item.lastT);
                item.vx = (det.x - item.box.x) / dt;
                item.vy = (det.y - item.box.y) / dt;
                item.box = det;
                item.lastT = t;
                item.hits++;
                item.misses = 0;
                assigned[di] = item.id;
            }
            for (int di = 0; di < dets.size(); di++) {
                if (usedD.contains(di)) continue;
                int id = nextId++;
                items.add(new Tracklet(id, dets.get(di), t));
                assigned[di] = id;
            }
            List<Tracklet> kept = new ArrayList<>();
            for (Tracklet item : items) {
                if (item.lastT == t) { kept.add(item); continue; }
                item.misses++;
                if (item.misses <= 3) kept.add(item);
            }
            items.clear();
            items.addAll(kept);
            if (subject != null) bindSubject(subject);
            return assigned;
        }

        Integer bindSubject(Box box) {
            Tracklet best = null;
            float bestIou = TRACKLET_BIND_IOU;
            for (Tracklet item : items) {
                float v = boxIou(item.box, box);
                if (v > bestIou) { bestIou = v; best = item; }
            }
            if (best == null || best.hits < 2) return subjectId;
            subjectId = best.id;
            return subjectId;
        }

        Tracklet find(Integer id) {
            if (id == null) return null;
            for (Tracklet item : items) if (item.id == id) return item;
            return null;
        }

        boolean coVisible(int a, Integer b) {
            Tracklet A = find(a), B = find(b);
            if (A == null || B == null) return false;
            return Math.abs(A.lastT - B.lastT) < 1.5 && A.hits >= 2 && B.hits >= 2;
        }

        SwitchDecision decideSwitch(Box candidate) {
            Tracklet mine = find(subjectId);
            if (mine == null || mine.hits < TRACKLET_MIN_HITS) {
                return new SwitchDecision("continue", "subject-tracklet-unready", subjectId, null);
            }
            Tracklet other = null;
            float best = TRACKLET_BIND_IOU;
            for (Tracklet item : items) {
                float v = boxIou(item.box, candidate);
                if (v > best) { best = v; other = item; }
            }
            if (other == null) return new SwitchDecision("continue", "candidate-unbound", subjectId, null);
            if (other.id == mine.id) return new SwitchDecision("continue", "same-tracklet", subjectId, null);
            if (other.hits < TRACKLET_MIN_HITS) {
                return new SwitchDecision("continue", "candidate-tracklet-unready", subjectId, null);
            }
            float body = Math.max(8, mine.box.width);
            float dx = candidate.cx() - mine.box.cx();
            float dy = candidate.cy() - mine.box.cy();
            if (Math.hypot(dx, dy) < TRACKLET_SWITCH_BODIES * body) {
                return new SwitchDecision("continue", "near-current-box", subjectId, null);
            }
            if (!coVisible(other.id, mine.id)) {
                return new SwitchDecision("hold", "different-tracklet-not-covisible", mine.id, other.id);
            }
            return new SwitchDecision("block-switch", "co-visible-other-person", mine.id, other.id);
        }
    }

    static SportsGateResult gateSportsIdentity(
        String appearance,
        SwitchDecision tracklet,
        JerseyDecision jersey,
        TeamDecision team,
        Boolean courtFar,
        Double gapSeconds
    ) {
        if (jersey != null && "conflict".equals(jersey.action)) {
            return new SportsGateResult("reject-switch", "jersey-conflict");
        }
        if (tracklet != null && "block-switch".equals(tracklet.action)) {
            return new SportsGateResult("reject-switch", tracklet.reason);
        }
        if ("reject".equals(appearance)) return new SportsGateResult("reject-switch", "appearance-reject");
        if (jersey != null && "hold".equals(jersey.action) && jersey.locked != null) {
            return new SportsGateResult("hold", "jersey-unreadable");
        }
        if (tracklet != null && "hold".equals(tracklet.action)) {
            return new SportsGateResult("hold", tracklet.reason);
        }
        if ("hold".equals(appearance)) return new SportsGateResult("hold", "appearance-hold");
        double gap = gapSeconds == null ? 0 : gapSeconds;
        if (team != null && Boolean.TRUE.equals(team.sameTeam) && gap > 0.8) {
            return new SportsGateResult("hold", "same-team-after-gap");
        }
        if (Boolean.TRUE.equals(courtFar) && gap < 0.5) {
            return new SportsGateResult("hold", "court-teleport");
        }
        if ("accept".equals(appearance)) {
            return new SportsGateResult("accept", "multi-signal-ok");
        }
        return new SportsGateResult("hold", "insufficient-sports-evidence");
    }

    private static final int[] SEGMENTS = {
        0b1110111, 0b0010010, 0b1011101, 0b1011011, 0b0111010,
        0b1101011, 0b1101111, 0b1010010, 0b1111111, 0b1111011,
    };
    private static final byte[][] TEMPLATES = new byte[10][];
    static {
        for (int d = 0; d < 10; d++) TEMPLATES[d] = paintDigit(d);
    }

    private static byte[] paintDigit(int digit) {
        int bits = SEGMENTS[digit];
        byte[] out = new byte[JERSEY_TPL_W * JERSEY_TPL_H];
        if ((bits & 0b1000000) != 0) fill(out, 2, 1, 9, 2);
        if ((bits & 0b0100000) != 0) fill(out, 9, 2, 10, 8);
        if ((bits & 0b0010000) != 0) fill(out, 9, 9, 10, 15);
        if ((bits & 0b0001000) != 0) fill(out, 2, 15, 9, 16);
        if ((bits & 0b0000100) != 0) fill(out, 1, 9, 2, 15);
        if ((bits & 0b0000010) != 0) fill(out, 1, 2, 2, 8);
        if ((bits & 0b0000001) != 0) fill(out, 2, 8, 9, 9);
        return out;
    }

    private static void fill(byte[] out, int x0, int y0, int x1, int y1) {
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) {
                if (x >= 0 && y >= 0 && x < JERSEY_TPL_W && y < JERSEY_TPL_H) {
                    out[y * JERSEY_TPL_W + x] = 1;
                }
            }
        }
    }

    private static float[] matchDigit(byte[] bin) {
        int best = 0;
        float bestScore = -1;
        for (int d = 0; d < 10; d++) {
            int same = 0;
            for (int i = 0; i < bin.length; i++) if (bin[i] == TEMPLATES[d][i]) same++;
            float score = same / (float) bin.length;
            if (score > bestScore) { bestScore = score; best = d; }
        }
        return new float[]{best, bestScore};
    }

    private static byte[] resizeBinary(byte[] src, int sw, int sh, int dw, int dh) {
        byte[] out = new byte[dw * dh];
        for (int y = 0; y < dh; y++) {
            int sy = Math.min(sh - 1, (int) Math.floor((y * (double) sh) / dh));
            for (int x = 0; x < dw; x++) {
                int sx = Math.min(sw - 1, (int) Math.floor((x * (double) sw) / dw));
                out[y * dw + x] = src[sy * sw + sx];
            }
        }
        return out;
    }

    /** packed ARGB int[] (Android Bitmap.getPixels). */
    static JerseyRead readJerseyNumber(int[] argb, int width, int height) {
        if (width < 16 || height < 24) return new JerseyRead(null, 0, 0, "crop-too-small");
        int[] gray = new int[width * height];
        for (int i = 0; i < gray.length; i++) {
            int v = argb[i];
            int r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
            gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
        }
        int x0 = (int) Math.floor(width * 0.22), x1 = (int) Math.ceil(width * 0.78);
        int y0 = (int) Math.floor(height * 0.28), y1 = (int) Math.ceil(height * 0.62);
        int bw = Math.max(4, x1 - x0), bh = Math.max(4, y1 - y0);
        int[] band = new int[bw * bh];
        for (int y = 0; y < bh; y++) {
            System.arraycopy(gray, (y0 + y) * width + x0, band, y * bw, bw);
        }
        int sum = 0;
        for (int v : band) sum += v;
        float mean = sum / (float) band.length;
        byte[] bin = new byte[band.length];
        int ink = 0;
        for (int i = 0; i < band.length; i++) {
            bin[i] = (byte) (band[i] < mean - 8 ? 1 : 0);
            ink += bin[i];
        }
        float fill = ink / (float) bin.length;
        if (fill < 0.04f || fill > 0.55f) return new JerseyRead(null, 0, fill, "no-digit-contrast");
        int mid = (int) Math.floor(bw / 2f);
        byte[] left = new byte[mid * bh];
        byte[] right = new byte[(bw - mid) * bh];
        for (int y = 0; y < bh; y++) {
            System.arraycopy(bin, y * bw, left, y * mid, mid);
            System.arraycopy(bin, y * bw + mid, right, y * (bw - mid), bw - mid);
        }
        float leftInk = 0, rightInk = 0;
        for (byte v : left) leftInk += v;
        for (byte v : right) rightInk += v;
        leftInk /= Math.max(1, left.length);
        rightInk /= Math.max(1, right.length);
        if (leftInk > 0.06f && rightInk > 0.06f) {
            float[] a = matchDigit(resizeBinary(left, mid, bh, JERSEY_TPL_W, JERSEY_TPL_H));
            float[] b = matchDigit(resizeBinary(right, bw - mid, bh, JERSEY_TPL_W, JERSEY_TPL_H));
            float score = Math.min(a[1], b[1]);
            if (score < JERSEY_ACCEPT) return new JerseyRead(null, score, fill, "two-digit-weak");
            return new JerseyRead("" + (int) a[0] + (int) b[0], score, fill, "two-digit");
        }
        float[] one = matchDigit(resizeBinary(bin, bw, bh, JERSEY_TPL_W, JERSEY_TPL_H));
        if (one[1] < JERSEY_ACCEPT) return new JerseyRead(null, one[1], fill, "one-digit-weak");
        return new JerseyRead(String.valueOf((int) one[0]), one[1], fill, "one-digit");
    }

    static final class JerseyLock {
        String locked = null;
        boolean remember(JerseyRead read, boolean userConfirmed) {
            if (!userConfirmed || read.digits == null || read.score < JERSEY_ACCEPT) return false;
            locked = read.digits;
            return true;
        }
        JerseyDecision decide(JerseyRead read) {
            if (locked == null) return new JerseyDecision("hold", "no-lock", null, read.digits);
            if (read.digits == null || read.score < JERSEY_ACCEPT) {
                return new JerseyDecision("hold", "unreadable", locked, read.digits);
            }
            if (read.digits.equals(locked)) return new JerseyDecision("agree", "same-number", locked, read.digits);
            return new JerseyDecision("conflict", "different-number", locked, read.digits);
        }
    }

    static TeamVector describeTeam(int[] argb, int width, int height) {
        float[] hist = new float[TEAM_BINS];
        int samples = 0;
        int y0 = (int) Math.floor(height * 0.22), y1 = (int) Math.ceil(height * 0.70);
        int x0 = (int) Math.floor(width * 0.18), x1 = (int) Math.ceil(width * 0.82);
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                int v = argb[y * width + x];
                float r = ((v >> 16) & 255) / 255f;
                float g = ((v >> 8) & 255) / 255f;
                float b = (v & 255) / 255f;
                float max = Math.max(r, Math.max(g, b));
                float min = Math.min(r, Math.min(g, b));
                float s = max == 0 ? 0 : (max - min) / max;
                if (s < 0.12f || max < 0.12f) continue;
                float hue = 0;
                float d = max - min;
                if (d > 1e-6f) {
                    if (max == r) hue = ((g - b) / d) % 6;
                    else if (max == g) hue = (b - r) / d + 2;
                    else hue = (r - g) / d + 4;
                    hue /= 6;
                    if (hue < 0) hue += 1;
                }
                hist[Math.min(TEAM_BINS - 1, (int) Math.floor(hue * TEAM_BINS))] += 1;
                samples++;
            }
        }
        float sum = 0;
        for (float v : hist) sum += v;
        if (sum > 0) for (int i = 0; i < hist.length; i++) hist[i] /= sum;
        return new TeamVector(hist, samples);
    }

    static Float teamAffinity(TeamVector a, TeamVector b) {
        if (a.samples < 40 || b.samples < 40) return null;
        float s = 0;
        for (int i = 0; i < TEAM_BINS; i++) s += (float) Math.sqrt(a.hist[i] * b.hist[i]);
        return Math.max(0, Math.min(1, s));
    }

    static TeamDecision decideTeamCue(TeamVector self, TeamVector other) {
        Float score = teamAffinity(self, other);
        if (score == null) return new TeamDecision(null, null, "weak-color");
        if (score >= TEAM_SAME) return new TeamDecision(true, score, "same-kit-color");
        if (score <= TEAM_DIFF) return new TeamDecision(false, score, "different-kit-color");
        return new TeamDecision(null, score, "ambiguous-kit");
    }

    static CourtHintResult estimateCourtHint(int[] argb, int width, int height, Box subject) {
        if (width < 64 || height < 64) {
            return new CourtHintResult(false, 0, "frame-too-small", 0, null);
        }
        int[] gray = new int[width * height];
        for (int i = 0; i < gray.length; i++) {
            int v = argb[i];
            gray[i] = ((((v >> 16) & 255) * 77 + ((v >> 8) & 255) * 150 + (v & 255) * 29) >> 8);
        }
        int[] edge = new int[width * height];
        for (int y = 1; y < height - 1; y++) {
            for (int x = 1; x < width - 1; x++) {
                int i = y * width + x;
                edge[i] = Math.min(255, Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + width] - gray[i - width]));
            }
        }
        int lines = 0, horiz = 0, vert = 0;
        int minLen = Math.round(Math.min(width, height) * 0.18f);
        int step = 3;
        for (int y = 2; y < height - 2; y += step) {
            int run = 0;
            for (int x = 2; x < width - 2; x++) {
                if (edge[y * width + x] > 46) run++;
                else {
                    if (run >= 14 && run >= minLen) { lines++; horiz++; }
                    run = 0;
                }
            }
        }
        for (int x = 2; x < width - 2; x += step) {
            int run = 0;
            for (int y = 2; y < height - 2; y++) {
                if (edge[y * width + x] > 46) run++;
                else {
                    if (run >= 14 && run >= minLen) { lines++; vert++; }
                    run = 0;
                }
            }
        }
        if (lines < COURT_MIN_LINES || horiz < 2 || vert < 1) {
            return new CourtHintResult(false, 0, "not-enough-lines", lines, null);
        }
        float quality = Math.max(0, Math.min(1, (horiz + vert) / 10f));
        if (quality < COURT_MIN_QUALITY) {
            return new CourtHintResult(false, quality, "low-line-quality", lines, null);
        }
        CourtPoint foot = subject == null ? null : new CourtPoint(subject.cx(), subject.y + subject.height);
        return new CourtHintResult(true, quality, "axis-aligned-lines", lines, foot);
    }

    static Float courtFootDistance(CourtPoint a, CourtPoint b, float height) {
        if (a == null || b == null || height <= 0) return null;
        return (float) (Math.hypot(a.x - b.x, a.y - b.y) / height);
    }

    static float maxOverlap(Box subject, List<Box> others) {
        float best = 0;
        if (others == null) return 0;
        for (Box other : others) best = Math.max(best, boxIou(subject, other));
        return best;
    }

    static float occlusionWidenFactor(float overlap) {
        if (!(overlap > OCCLUSION_IOU_WIDEN)) return 1;
        float t = Math.min(1, (overlap - OCCLUSION_IOU_WIDEN) / 0.45f);
        return 1 + (OCCLUSION_MAX_WIDEN - 1) * t;
    }

    static OcclusionResult applyOcclusionCrop(float cropShare, float maxCropShare, Box subject, List<Box> others) {
        float overlap = others == null || others.isEmpty() ? 0 : maxOverlap(subject, others);
        float factor = occlusionWidenFactor(overlap);
        return new OcclusionResult(Math.min(maxCropShare, cropShare * factor), overlap, factor > 1.001f);
    }

    static EventScore scoreEventForMe(
        Float subjectSpeed, Float subjectAccel, Float directionChange, Float sizeChange,
        Float trackingHealth, Float overlapOthers, Boolean jerseyReadable,
        Float cameraShake, Boolean identityHold
    ) {
        Float speed = clamp01(subjectSpeed);
        if (speed == null && subjectAccel == null) {
            return new EventScore(0, Collections.singletonList("no-subject-motion"));
        }
        float accel = nvl(clamp01(subjectAccel));
        float dir = nvl(clamp01(directionChange));
        float size = nvl(clamp01(sizeChange));
        float health = clamp01(trackingHealth) == null ? 0.4f : clamp01(trackingHealth);
        float raw = nvl(speed) * 0.36f + accel * 0.28f + dir * 0.18f + size * 0.10f;
        if (Boolean.TRUE.equals(jerseyReadable)) raw += 0.08f;
        float overlap = nvl(clamp01(overlapOthers));
        raw *= 1 - 0.45f * overlap;
        if (Boolean.TRUE.equals(identityHold)) raw *= 0.35f;
        raw *= 0.55f + 0.45f * health;
        if ((cameraShake == null ? 0 : cameraShake) > 0.55f && nvl(speed) < 0.12f) raw *= 0.25f;
        float score = Math.max(0, Math.min(1, raw));
        List<String> reason = new ArrayList<>();
        if (nvl(speed) > 0.45f) reason.add("subject-fast");
        if (accel > 0.45f) reason.add("subject-accel");
        if (dir > 0.45f) reason.add("subject-turn");
        if (Boolean.TRUE.equals(jerseyReadable)) reason.add("jersey-readable");
        if (overlap > OCCLUSION_IOU_WIDEN) reason.add("overlap-penalized");
        if (reason.isEmpty()) reason.add("subject-motion");
        if (reason.size() > 3) reason = reason.subList(0, 3);
        return new EventScore(score, reason);
    }

    static List<OfflineBox> inferBackwardFromForward(List<OfflineBox> forward) {
        List<OfflineBox> boxes = new ArrayList<>();
        for (OfflineBox b : forward) {
            if (Double.isFinite(b.t) && finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height)) {
                boxes.add(b);
            }
        }
        if (boxes.size() < 3) return new ArrayList<>(boxes);
        List<OfflineBox> out = new ArrayList<>(boxes);
        for (int i = boxes.size() - 3; i >= 0; i--) {
            OfflineBox a = boxes.get(i + 1), b = boxes.get(i + 2);
            double dt = b.t - a.t;
            if (dt <= 1e-6) continue;
            double backDt = a.t - boxes.get(i).t;
            out.set(i, new OfflineBox(
                boxes.get(i).t,
                (float) (a.x - ((b.x - a.x) / dt) * backDt),
                (float) (a.y - ((b.y - a.y) / dt) * backDt),
                a.width, a.height, true));
        }
        return out;
    }

    static List<OfflinePoint> refineOfflineTrajectory(List<OfflineBox> forward, List<OfflineBox> backward) {
        List<OfflineBox> fwd = new ArrayList<>();
        for (OfflineBox b : forward) {
            if (Double.isFinite(b.t) && finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height)) {
                fwd.add(b);
            }
        }
        Map<String, OfflineBox> back = new HashMap<>();
        if (backward != null) {
            for (OfflineBox box : backward) back.put(key(box.t), box);
        }
        List<OfflinePoint> out = new ArrayList<>();
        for (OfflineBox f : fwd) {
            OfflineBox b = back.get(key(f.t));
            boolean observed = f.observed && f.width > 2 && f.height > 2;
            Box box = new Box(f.x, f.y, f.width, f.height);
            if (b != null) {
                float iou = boxIou(box, new Box(b.x, b.y, b.width, b.height));
                if (iou >= OFFLINE_AGREE_IOU) {
                    out.add(new OfflinePoint(f.t, box, "ok", observed, "forward-backward-agree"));
                } else {
                    out.add(new OfflinePoint(f.t, box, "lost", false, "forward-backward-disagree"));
                }
            } else {
                out.add(new OfflinePoint(f.t, box, !observed ? "lost" : "ok", observed, observed ? "forward-only" : "unobserved"));
            }
        }
        for (int i = 1; i < out.size(); i++) {
            OfflinePoint prev = out.get(i - 1), cur = out.get(i);
            if (prev.observed && cur.observed) continue;
            double gap = cur.t - prev.t;
            if (gap <= 0 || gap > OFFLINE_BRIDGE_SEC) continue;
            if (prev.observed && !cur.observed && "lost".equals(cur.state)) {
                double span = Math.max(1e-6, cur.t - prev.t);
                double k = Math.max(0, Math.min(1, (cur.t - prev.t) / span));
                cur.box = new Box(
                    (float) (prev.box.x + (cur.box.x - prev.box.x) * k),
                    (float) (prev.box.y + (cur.box.y - prev.box.y) * k),
                    (float) (prev.box.width + (cur.box.width - prev.box.width) * k),
                    (float) (prev.box.height + (cur.box.height - prev.box.height) * k));
                cur.state = "occluded";
                cur.observed = false;
                cur.reason = "short-gap-position-only";
            }
        }
        return out;
    }

    static String appearanceFromReid(float reid, float accept, float critical) {
        if (reid >= accept) return "accept";
        if (reid < critical) return "reject";
        return "hold";
    }

    static final int MAX_CONFIRMED_EXEMPLARS = 12;
    static final int MAX_PER_VIEW = 3;
    static final boolean PRODUCT_IDENTITY_APPLY = false;

    static String classifyLifecycle(boolean observed, boolean headingOut, boolean atEdge, float overlap, boolean inside) {
        if (observed && inside) return "TRACKING";
        if (!observed && headingOut && atEdge) return "OUT_OF_VIEW";
        if (!observed && inside && overlap >= 0.22f) return "OCCLUDED";
        return "LOST_UNCERTAIN";
    }

    static boolean mayUpdateAppearance(String lifecycle) {
        return "TRACKING".equals(lifecycle);
    }

    static boolean productMayApplyIdentity() {
        return PRODUCT_IDENTITY_APPLY;
    }

    /** 평가 정답(targetPresent)을 받지 않는다. 외형·시간 근거만 본다. */
    static String judgeReentry(int candidates, boolean unmeasuredRival, boolean headOnly, boolean timeReady, float best, float margin) {
        if (candidates <= 0) return "waiting";
        if (unmeasuredRival) return "waiting";
        if (headOnly) return "waiting";
        if (!timeReady) return "waiting";
        if (best < 0.82f) return "waiting";
        if (margin < 0.02f && candidates >= 2) return "needs_user";
        if (margin < 0.12f && candidates >= 2) return "needs_user";
        if (candidates == 1 && best >= 0.86f) return "provisional";
        if (candidates == 1) return "needs_user";
        return "provisional";
    }

    private static String key(double t) { return String.format(java.util.Locale.US, "%.3f", t); }
    private static Float clamp01(Float v) {
        if (v == null || !finite(v)) return null;
        return Math.max(0, Math.min(1, v));
    }
    private static float nvl(Float v) { return v == null ? 0 : v; }
    private static boolean finite(float v) { return !Float.isNaN(v) && !Float.isInfinite(v); }
}
