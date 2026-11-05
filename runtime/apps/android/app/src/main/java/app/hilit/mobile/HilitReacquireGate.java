/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b8c4be9d @license @preserve */
package app.hilit.mobile;

import java.util.ArrayList;
import java.util.List;

/**
 * 추적이 끝난 궤적에 재획득 확정 절차를 적용한다.
 *
 * <p>웹의 {@code packages/hilit-vision/src/reacquire-trajectory-gate.ts} 와 같은 규칙이다.
 * 상수는 {@code scripts/check-android-tracking-parity.mjs} 가 기계로 맞춘다. 한쪽만
 * 고치면 같은 영상에서 웹과 앱이 다른 결과를 낸다.
 *
 * <p>무엇을 막는가. 대상이 가려지거나 화면 밖으로 나갔다가 추적이 다시 붙을 때, 지금까지는
 * 그 순간부터 바로 같은 사람으로 취급했다. 다른 사람을 잡았어도 화면에는 정상 추적으로
 * 보인다. 여기서는 최소 관측 수와 최소 확인 시간을 채울 때까지 잠정으로 두고 신뢰도를
 * 낮춘다. 따라가는 것은 멈추지 않는다.
 *
 * <p>신원을 주장하지 않는다. 자동으로 "같은 사람이다" 라고 올리지 않는다. 확신을 미룰 뿐이다.
 *
 * <p>웹과 다른 점이 하나 있다. 웹은 검출기가 같은 프레임의 다른 사람 상자 수를 준다.
 * 앱에는 검출기가 없어(2026-09-16 제거) 그 수를 셀 수 없다. 대신 엔진 자신의 위험 신호
 * (TRACKING_WARNING)를 대리값으로 쓴다. 대리값이라는 것을 숨기지 않는다.
 */
final class HilitReacquireGate {
    private HilitReacquireGate() {}

    /** 이 기능이 켜져 있는가. 끄면 예전 동작 그대로다. */
    static final boolean REACQUIRE_TRAJECTORY_GATE_ENABLED = true;

    /** 확정에 필요한 최소 실관측 프레임 수. */
    static final int MIN_OBSERVATIONS = 3;
    /** 단순한 짧은 공백 뒤 최소 확인 시간(초). */
    static final double MIN_CONFIRM_SEC = 0.4;
    /** 경쟁자가 있거나 공백이 길 때의 최소 확인 시간(초). */
    static final double MIN_CONFIRM_SEC_HARD = 0.8;
    /** 이보다 짧은 공백은 확정 절차를 열지 않는다(초). */
    static final double IGNORE_GAP_SHORTER_THAN_SEC = 0.12;
    /** 이 시간을 넘는 공백은 어려운 장면으로 본다(초). */
    static final double HARD_GAP_SEC = 1.0;
    /** 잠정 구간의 신뢰도 상한. */
    static final float TENTATIVE_CONFIDENCE_CAP = 0.55f;

    static final String LIFECYCLE_PROVISIONAL = "REACQUIRED_PROVISIONAL";
    static final String LIFECYCLE_VERIFYING = "VERIFYING";

    static final class Input {
        final double timestamp;
        /** 이 프레임에서 대상을 실제로 붙들고 있었는가. 예측만이면 false. */
        final boolean observed;
        /** 경쟁 강도. 앱에서는 위험 신호를 쓴 대리값이다. 신원이 아니다. */
        final int competingCount;

        Input(double timestamp, boolean observed, int competingCount) {
            this.timestamp = timestamp;
            this.observed = observed;
            this.competingCount = competingCount;
        }
    }

    static final class Mark {
        final int index;
        final String lifecycle;
        final double gapSec;
        final boolean hardScene;

        Mark(int index, String lifecycle, double gapSec, boolean hardScene) {
            this.index = index;
            this.lifecycle = lifecycle;
            this.gapSec = gapSec;
            this.hardScene = hardScene;
        }
    }

    static final class Span {
        final double start;
        final double end;
        final String reason;
        /** watch = 알려만 준다 · risk = 사용자에게 묻는다. */
        final String level;
        final double gapSec;

        Span(double start, double end, String reason, String level, double gapSec) {
            this.start = start;
            this.end = end;
            this.reason = reason;
            this.level = level;
            this.gapSec = gapSec;
        }
    }

    static final class Result {
        final List<Mark> marks = new ArrayList<>();
        final List<Span> spans = new ArrayList<>();
        int reacquisitions;
        int askedCount;
        /** 이 값은 순위 근거이지 신원 확률이 아니다. */
        final boolean identityClaim = false;
    }

    /**
     * 끊겼다 다시 붙은 구간을 찾아 잠정 표시를 만든다.
     *
     * <p>입력은 시간 오름차순이라고 가정한다. 궤적을 바꾸지 않는다 — 어디를 잠정으로
     * 볼지만 알려준다. 실제 반영은 부르는 쪽이 한다.
     */
    static Result gateReacquisitions(List<Input> points) {
        Result out = new Result();
        if (points == null || points.isEmpty()) return out;

        int i = 0;
        while (i < points.size()) {
            if (points.get(i).observed) { i++; continue; }

            int gapStart = i;
            while (i < points.size() && !points.get(i).observed) i++;
            if (i >= points.size()) break;
            double gapSec = points.get(i).timestamp - points.get(gapStart).timestamp;
            if (gapSec < IGNORE_GAP_SHORTER_THAN_SEC) continue;

            double resumeAt = points.get(i).timestamp;
            int competing = 0;
            int look = 0;
            for (int k = i; k < points.size() && look < MIN_OBSERVATIONS * 2; k++, look++) {
                if (points.get(k).observed) competing = Math.max(competing, points.get(k).competingCount);
            }
            boolean hardScene = competing > 0 || gapSec >= HARD_GAP_SEC;
            double needSec = hardScene ? MIN_CONFIRM_SEC_HARD : MIN_CONFIRM_SEC;

            out.reacquisitions++;
            int observations = 0;
            int lastTentativeIndex = i;
            boolean confirmed = false;
            boolean marked = false;
            for (int k = i; k < points.size(); k++) {
                if (!points.get(k).observed) break;
                observations++;
                double elapsed = points.get(k).timestamp - resumeAt;
                if (observations >= MIN_OBSERVATIONS && elapsed >= needSec) { confirmed = true; break; }
                out.marks.add(new Mark(k, hardScene ? LIFECYCLE_VERIFYING : LIFECYCLE_PROVISIONAL,
                        gapSec, hardScene));
                lastTentativeIndex = k;
                marked = true;
            }

            if (marked) {
                /* 공백이 길고 경쟁자까지 있을 때만 묻는다. 주위에 아무도 없으면 남을
                   잡았을 위험이 낮다. 그런 구간까지 물으면 사용자는 확인 창만 닫게 된다. */
                boolean ask = competing > 0 && gapSec >= HARD_GAP_SEC;
                if (ask) out.askedCount++;
                String reason = confirmed
                        ? (hardScene ? "가림이 끝난 뒤 같은 사람인지 확인하는 중" : "잠깐 끊긴 뒤 다시 붙는 중")
                        : "끊긴 뒤 확인을 끝내지 못했다";
                out.spans.add(new Span(resumeAt, points.get(lastTentativeIndex).timestamp,
                        reason, ask ? "risk" : "watch", gapSec));
            }
        }
        return out;
    }
}
