/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·bb80e75b @license @preserve */
package app.hilit.mobile;

/**
 * 웹 {@code ReidScheduler} 와 같은 간격·쿨다운·예산 숫자.
 *
 * 운동 예측이 기본이다. 고비용 HSV 추출은 사건·위험·영상시간 간격이
 * 있을 때만 한다. 호출이 줄어도 품질이 좋아졌다고 말하지 않는다.
 * 실행 중 ID switch 를 정답 없이 확정하지 않는다.
 */
final class NativeReidScheduler {
    static final double CHEAP_QUALITY_INTERVAL_SEC = 0.25;
    static final double STABLE_EXPENSIVE_INTERVAL_SEC = 1.67;
    static final double WARNING_EXPENSIVE_INTERVAL_SEC = 0.42;
    static final double COOLDOWN_AFTER_EXPENSIVE_SEC = 0.12;
    static final double EXPENSIVE_BUDGET_MS = 18;
    static final double FULL_OCCLUSION_VISIBLE = 0.12;
    static final double MIN_CROP_PX = 8;
    static final double RESIDUAL_BODIES = 0.45;
    static final double RISK_CLEAR_HOLD_SEC = 1.5;
    static final int POLICY_VERSION = 1;

    static final class Signals {
        double videoTSec;
        boolean cropValid;
        float visibleRatio;
        boolean occluded;
        boolean blurSevere;
        boolean rivalNearby;
        boolean rankCompetition;
        boolean userConfirm;
        boolean reentryAfterOcclusion;
        boolean surpriseMove;
        boolean appearanceWeak;
        boolean trackLostSuspect;
        Double residualBodies;
        int candidateCount;
    }

    static final class Decision {
        final boolean extract;
        final String skip;
        final String switchRisk;
        Decision(boolean extract, String skip, String switchRisk) {
            this.extract = extract;
            this.skip = skip;
            this.switchRisk = switchRisk;
        }
    }

    private double lastExpensiveVideoT = Double.NEGATIVE_INFINITY;
    private double lastRiskT = Double.NEGATIVE_INFINITY;
    private String lastRisk = "none";
    private double currentVideoT = Double.NEGATIVE_INFINITY;
    private boolean extractedThisFrame = false;
    private int analysisFrames = 0;
    private int expensiveExtracts = 0;

    int analysisFrames() { return analysisFrames; }
    int expensiveExtracts() { return expensiveExtracts; }

    Decision decide(Signals sig) {
        if (sig == null || Double.isNaN(sig.videoTSec)) {
            return new Decision(false, "not_due", "none");
        }
        if (sig.videoTSec != currentVideoT) {
            currentVideoT = sig.videoTSec;
            analysisFrames += 1;
            extractedThisFrame = false;
        }
        String skipHard = hardSkip(sig);
        String risk = updateRisk(sig);
        boolean urgent = sig.userConfirm || sig.surpriseMove || sig.reentryAfterOcclusion;
        boolean intervalDue = lastExpensiveVideoT == Double.NEGATIVE_INFINITY
                || sig.videoTSec - lastExpensiveVideoT >= intervalSec(risk) - 1e-9;
        boolean trigger = urgent
                || sig.rivalNearby
                || sig.rankCompetition
                || sig.trackLostSuspect
                || (sig.residualBodies != null && sig.residualBodies >= RESIDUAL_BODIES)
                || intervalDue;
        boolean extract = trigger && skipHard == null;
        String skip = skipHard;
        if (extract && sig.appearanceWeak && !urgent) {
            extract = false;
            skip = "appearance_weak";
        }
        if (extract && !urgent && lastExpensiveVideoT != Double.NEGATIVE_INFINITY
                && sig.videoTSec - lastExpensiveVideoT < COOLDOWN_AFTER_EXPENSIVE_SEC) {
            extract = false;
            skip = "cooldown";
        }
        if (extract && extractedThisFrame) {
            extract = false;
            skip = null;
        }
        if (extract) {
            expensiveExtracts += 1;
            extractedThisFrame = true;
            lastExpensiveVideoT = sig.videoTSec;
        }
        if (!extract && skip == null) skip = "not_due";
        return new Decision(extract, skip, risk);
    }

    private static String hardSkip(Signals sig) {
        if (!sig.cropValid) return "no_valid_crop";
        if (sig.occluded || sig.visibleRatio < FULL_OCCLUSION_VISIBLE) return "full_occlusion";
        if (sig.blurSevere) return "severe_blur";
        return null;
    }

    private String updateRisk(Signals sig) {
        String level = "none";
        if (sig.rivalNearby || sig.rankCompetition) level = "watch";
        if (sig.rankCompetition && sig.residualBodies != null && sig.residualBodies >= RESIDUAL_BODIES) {
            level = "elevated";
        }
        if (sig.trackLostSuspect && sig.rivalNearby) level = "elevated";
        if (sig.appearanceWeak && sig.rivalNearby) level = "ask";
        if (!"none".equals(level)) {
            lastRisk = level;
            lastRiskT = sig.videoTSec;
            return level;
        }
        if (!"none".equals(lastRisk) && sig.videoTSec - lastRiskT < RISK_CLEAR_HOLD_SEC) {
            return lastRisk;
        }
        lastRisk = "none";
        return "none";
    }

    private static double intervalSec(String risk) {
        return "none".equals(risk) ? STABLE_EXPENSIVE_INTERVAL_SEC : WARNING_EXPENSIVE_INTERVAL_SEC;
    }
}
