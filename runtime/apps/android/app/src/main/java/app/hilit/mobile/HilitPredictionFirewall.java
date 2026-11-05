/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·897a216f @license @preserve */
package app.hilit.mobile;

/**
 * 예측과 신원 사이의 방화벽 — 웹 `prediction-identity-firewall.ts` 의 Java 판.
 *
 * <p>위치 예측을 넣으면 곧바로 생기는 뒷문이 있다. <b>예측 자리 근처의 사람을
 * 대상으로 고르는 것</b>이다. 그럴듯해 보이지만 그 순간 신원 판정이 막아 놓은
 * 것을 통째로 우회한다 — 그 자리에는 누구든 서 있을 수 있기 때문이다.
 *
 * <p>그래서 예측은 <b>거절만</b> 한다.
 *
 * <ul>
 *   <li>"예측에서 너무 멀다" → 거절해도 안전하다. 틀려도 사용자에게 묻게 될 뿐이다.
 *   <li>"예측에 가깝다" → <b>아무 의미도 없다.</b>
 * </ul>
 *
 * <p>판정 값은 셋을 <b>모두 적어 둔다</b>. 그래야 accept 가 빠진 것이 실수가
 * 아니라 의도라는 게 코드에 남는다. 예전에는 둘만 있어서 읽는 사람이
 * "빠뜨린 건가?" 하고 넣고 싶어졌다.
 *
 * <p>🔴 {@link #VERDICT_ACCEPT} 는 <b>예약된 값이고 절대 반환되지 않는다.</b>
 * {@link #assertNeverAccepts} 와 시험이 그 약속을 지킨다. 누가 나중에
 * accept 를 내도록 고치면 거기서 멈춘다.
 *
 * <p>신원 판정으로 나가는 것은 {@link #rejectOnly} 의 boolean 하나뿐이다 —
 * 숫자가 넘어가면 언젠가 누가 그 숫자로 가중치를 만든다.
 */
final class HilitPredictionFirewall {

    /**
     * 예측 중심에서 이만큼 넘게 떨어지면 거절한다.
     *
     * <p>3.5 였는데, 사람이 200px 인 720p 화면에서 3.5몸은 화면 절반보다
     * 넓다 — 사실상 아무것도 거절하지 못했다. 합성 대본 6종에서 반경을 훑어
     * 1.5 로 내렸다(정답 오거절 0%, 먼 타인 거절 10.2%). 웹과 같은 값이다.
     */
    static final double MAX_DISTANCE_BODIES = 1.5;
    /** 불확실할수록 관대해진다. 불확실성 1몸당 이만큼 넓혀 준다. */
    static final double UNCERTAINTY_SLACK_BODIES = 2.0;
    static final double MAX_SLACK_BODIES = 4.0;

    /** 예측이 실제로 내는 두 값. */
    static final String VERDICT_REJECT = "reject";
    static final String VERDICT_NEUTRAL = "neutral";
    /**
     * 예약값. <b>gate() 가 절대 반환하지 않는다.</b>
     *
     * <p>예측 자리에 가까운 후보를 승격시키면 H0/H1/H2 가설이 막아 놓은 것을
     * 통째로 우회한다 — 그 자리에는 누구든 서 있을 수 있기 때문이다.
     * 가까움은 아무것도 증명하지 않는다.
     */
    static final String VERDICT_ACCEPT = "accept";
    /** 실제로 나올 수 있는 판정. accept 는 여기 없다. */
    static final String[] PRODUCIBLE_VERDICTS = { VERDICT_REJECT, VERDICT_NEUTRAL };

    private HilitPredictionFirewall() { }

    static final class Verdict {
        final String verdict;
        final double distanceBodies;
        final String reason;
        /** 이 판정으로 후보를 올릴 수 없다. 늘 false 다. */
        final boolean canPromote = false;
        Verdict(String verdict, double distanceBodies, String reason) {
            this.verdict = verdict; this.distanceBodies = distanceBodies; this.reason = reason;
        }
    }

    /**
     * 예측으로 후보를 거절만 한다.
     *
     * <p>예측이 못 미더우면 아무 말도 하지 않는다. 못 믿는 예측으로 후보를
     * 떨어뜨리면 진짜 대상을 잃는다.
     */
    static Verdict gate(HilitTrackRegionPrediction.Prediction prediction,
                        double candCx, double candCy) {
        return gate(prediction, candCx, candCy, MAX_DISTANCE_BODIES);
    }

    static Verdict gate(HilitTrackRegionPrediction.Prediction prediction,
                        double candCx, double candCy, double maxDistanceBodies) {
        if (prediction == null) return new Verdict(VERDICT_NEUTRAL, Double.NaN, "no-prediction");
        if (!prediction.usable) return new Verdict(VERDICT_NEUTRAL, Double.NaN, "prediction-not-usable");
        double bodyHeight = Math.max(1, prediction.box == null ? 1 : prediction.box.h);
        double distance = Math.hypot(candCx - prediction.centerX, candCy - prediction.centerY) / bodyHeight;
        double uncertaintyBodies = Double.isInfinite(prediction.uncertaintyPx)
                ? MAX_SLACK_BODIES : prediction.uncertaintyPx / bodyHeight;
        double slack = Math.min(MAX_SLACK_BODIES, uncertaintyBodies * UNCERTAINTY_SLACK_BODIES);
        if (distance > maxDistanceBodies + slack) {
            return new Verdict(VERDICT_REJECT, distance, "too-far-from-prediction");
        }
        /* 가깝다. 그래서 어떻다는 말은 하지 않는다. */
        return new Verdict(VERDICT_NEUTRAL, distance, "within-prediction-radius-no-claim");
    }

    /** 신원 판정으로 넘어가는 유일한 값. boolean 하나다. */
    static boolean rejectOnly(HilitTrackRegionPrediction.Prediction prediction,
                              double candCx, double candCy) {
        Verdict verdict = gate(prediction, candCx, candCy);
        if (!assertNeverAccepts(verdict)) {
            /* 여기 오면 누가 gate() 를 고쳐 accept 를 내게 만든 것이다.
             * 조용히 통과시키지 않는다 — 그 순간 예측이 사람을 고르게 된다. */
            throw new IllegalStateException(
                    "예측은 거절만 한다. accept 가 나왔다: " + verdict.verdict);
        }
        return VERDICT_REJECT.equals(verdict.verdict);
    }

    /**
     * 예측이 후보를 승격시키지 않는지 본다.
     *
     * <p>타입에 accept 가 있으니 누군가 반환하도록 고칠 수 있다. 그때 조용히
     * 지나가지 않게 여기서 잡는다.
     */
    static boolean assertNeverAccepts(Verdict verdict) {
        return verdict != null && !VERDICT_ACCEPT.equals(verdict.verdict) && !verdict.canPromote;
    }
}
