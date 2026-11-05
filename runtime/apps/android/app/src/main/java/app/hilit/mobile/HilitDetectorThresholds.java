/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f87c618f @license @preserve */
package app.hilit.mobile;

/**
 * 검출 점수 문턱 — 웹 `detector-thresholds.ts` 의 Java 판.
 *
 * <p>쓰임새마다 틀렸을 때의 대가가 다르다.
 *
 * <ul>
 *   <li><b>확정 타인 갤러리</b> — 배경 조각을 "나 아님" 으로 외우면 나중에 진짜
 *       사용자가 그 조각과 닮았다는 이유로 거절당한다. 정밀도 우선.
 *   <li><b>재획득 후보</b> — 대상을 후보에 못 올리면 그 프레임은 끝이다. 가짜는
 *       뒤에서 걸러진다. 재현율 우선.
 *   <li><b>사용자 제시</b> — 헛것이 많으면 고르기 어렵다. 둘 사이.
 * </ul>
 *
 * <p>값은 고른 것이 아니라 잰 것이다(hilit-grid-sports-v1, 합성 200장,
 * 2026-09-21). 웹과 어긋나면 두 화면이 다른 후보를 본다.
 *
 * <p>🔴 Android 네이티브 경로에는 아직 사람 검출기가 없다. 검출기가 붙는 날
 * 이 값을 쓰기 위해 먼저 옮겨 둔다 — 그때 웹 값을 다시 찾아 헤매지 않게.
 */
final class HilitDetectorThresholds {
    /** recall ≥ 10% 인 것 중 precision 최대. */
    static final float CONFIRMED_OTHER_GALLERY = 0.80f;
    /** 상자/프레임 ≤ 12 인 것 중 recall 최대. */
    static final float REACQUIRE_CANDIDATES = 0.20f;
    /** F1 최대. */
    static final float USER_FACING_PROPOSALS = 0.80f;
    /** 어디에도 안 적힌 호출의 기본값. 예전 동작을 유지한다. */
    static final float DEFAULT = 0.35f;

    static final String BASIS_MODEL = "hilit-grid-sports-v1";
    static final String BASIS_NOTE = "합성 도형 기준. 실사 검출 성능이 아니다.";

    private HilitDetectorThresholds() { }
}
