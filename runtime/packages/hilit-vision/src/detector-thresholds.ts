/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·0be83189 @license @preserve */
/* 검출 점수 문턱 — 쓰임새마다 다르게 둔다.

예전에는 0.35 하나를 모든 곳에 썼다. 그런데 **틀렸을 때의 대가**가
자리마다 다르다.

  확정 타인 갤러리
    배경 조각을 "이 사람은 내가 아니다" 로 외우면, 나중에 진짜 사용자가
    그 조각과 닮았다는 이유로 거절당한다. 한 번 잘못 외우면 그 영상
    내내 따라다닌다. → **정밀도**가 중요하다. 적게 넣어도 된다.

  재획득 후보
    대상을 후보 목록에 못 올리면 그 프레임은 그대로 끝이다. 반대로 가짜가
    섞이는 것은 감당된다 — 뒤에 외형 대조·H0/H1/H2·예측 방화벽이 줄줄이
    걸러 준다. → **재현율**이 중요하다.

  사용자에게 보여 줄 후보
    헛것이 많으면 고르기 어렵고, 없으면 직접 그려야 한다. 둘 사이.

아래 값은 고른 것이 아니라 **잰 것**이다
(`scripts/eval-hilit-grid-thresholds.mjs`, hilit-grid-sports-v1, 합성 200장).

    문턱   recall  precision  상자/프레임
    0.20   52.2%   11.9%      6.6
    0.35   51.5%   14.8%      5.2
    0.50   49.5%   18.8%      4.0
    0.70   42.9%   27.3%      2.4
    0.80   32.6%   34.5%      1.4

고르는 규칙도 코드에 남긴다. 눈으로 고르면 다음 사람이 왜 그 값인지 모른다.

🔴 이 숫자는 우리가 그린 합성 도형에서 잰 것이다. 실사 검출 성능이 아니다.
정답이 붙은 실사 표본이 생기면 같은 스크립트를 돌려 이 파일을 먼저 고친다.

2026-09-23 실사 184프레임(정답 상자 166개, IoU 0.5)에서 처음으로 정답 대비를
쟀다. 결과는 위 표와 비교가 안 된다.

              실사(정답 대비)          합성 도형
    문턱   재현율  정밀도   F1     재현율  정밀도
    0.20    6.6%    1.1%  0.019   52.2%   11.9%
    0.50    6.0%    1.5%  0.024   49.5%   18.8%
    0.70    4.2%    2.4%  0.031   42.9%   27.3%
    0.80    1.8%    2.7%  0.022   32.6%   34.5%

세로 에너지 창까지 합쳐도 최고 F1 이 0.040(문턱 0.9)이다. **이 검출기는 이
영상들에서 사람을 거의 못 찾는다.** 나무·건물·빈 바닥에 상자를 그리고, 사람이
화면 한가운데 전신으로 서 있는 프레임에서도 놓친다.

🔴 **그래도 위 합성 표를 지우지 않았고 아래 값도 바꾸지 않았다.** 두 가지
이유다. 첫째, 정답이 `model-reviewed` 다 — 사람이 아니라 모델이 그렸다.
`STAGE2_ADOPT_RULES` 는 사람 검수를 요구한다. 둘째, 이 상태에서는 어느 문턱도
쓸 만하지 않아 문턱을 옮기는 것이 고치는 일이 아니다. 검출기 자체를 다시
학습해야 한다.

재는 법: `node scripts/tracking-data/eval-detector-on-real.mjs`
자세한 것은
docs/tracking-research/2026-09-23-real-footage-gmc-recalibration.md 11·14장.
*/

export const DETECTOR_SCORE_MIN = Object.freeze({
  /** 재현율 10% 이상인 것 중 정밀도 최대. */
  confirmedOtherGallery: 0.80,
  /** 프레임당 상자 12개 이하인 것 중 재현율 최대. */
  reacquireCandidates: 0.20,
  /** F1 최대. */
  userFacingProposals: 0.80,
  /** 어디에도 안 적힌 호출의 기본값. 예전 동작을 유지한다. */
  default: 0.35,
});

export type DetectorPurpose = keyof Omit<typeof DETECTOR_SCORE_MIN, 'default'>;

export const DETECTOR_THRESHOLD_BASIS = Object.freeze({
  modelId: 'hilit-grid-sports-v1',
  measuredWith: 'scripts/eval-hilit-grid-thresholds.mjs',
  dataset: 'hilit-sports-synth-v1 (합성 도형 200장)',
  measuredAt: '2026-09-21',
  realVideo: false,
  note: '합성 기준. 실사 검출 성능이 아니다.',
});

/** 쓰임새 이름으로 문턱을 고른다. 모르는 이름이면 기본값이다. */
export function scoreMinFor(purpose: DetectorPurpose | null | undefined): number {
  if (!purpose) return DETECTOR_SCORE_MIN.default;
  const value = DETECTOR_SCORE_MIN[purpose];
  return typeof value === 'number' ? value : DETECTOR_SCORE_MIN.default;
}
