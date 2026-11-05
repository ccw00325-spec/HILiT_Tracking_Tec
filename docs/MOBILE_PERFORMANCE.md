# 모바일 성능 측정

## 현재 상태

실기기에서 잰 프레임률, 발열, 배터리 기준값은 아직 없습니다. 이 문서는 그 값을 같은 방법으로 재고 판정하는 절차입니다. 양자화 같은 모델 경량화도 이 저장소에서 수행한 적이 없습니다.

## 예산

아래 값은 측정을 시작하기 위한 초기 기준입니다. 실기기 결과를 본 뒤 조정해야 합니다.

| 항목 | 기준 | 근거 |
|---|---|---|
| 분석 최저 프레임률 | 12 FPS, 프레임당 83.3ms | 코드의 `WEB_ADAPTIVE_FLOOR_FPS` |
| 끊긴 프레임 비율 | 10% 이하 | 초기 기준 |
| 발열 상태 | 2 이하 (Android 0~6 단계) | 초기 기준 |
| 배터리 온도 | 42°C 이하 | 초기 기준 |
| 10분당 배터리 감소 | 5% 이하 | 초기 기준 |

## 재는 법

PC에서 코어 속도를 봅니다. 기기 성능이 아니라 코드 변경 전후를 비교하는 값입니다.

```bash
node tools/bench-tracker.mjs --width 1280 --height 720 --frames 300
```

실기기에서 잽니다. 명령을 시작한 뒤 앱에서 90초 분량의 영상을 추적합니다.

```bash
node tools/android-profile.mjs --seconds 600 --out result.json
```

- 기기는 충전기를 빼고, 밝기와 실내 온도를 기록합니다.
- 에뮬레이터 결과는 발열과 배터리 근거로 쓰지 않습니다. 결과의 `isEmulator` 를 확인합니다.
- 같은 영상으로 세 번 재고 중앙값을 남깁니다.

## 줄이는 순서

병목을 잰 뒤 효과가 큰 쪽부터 합니다. 각 단계는 정확도 시험을 함께 통과해야 합니다.

1. 프레임 읽기 줄이기: 다음 추적에 필요한 영역만 읽습니다. 코어는 이미 이 방식을 지원합니다.
2. 분석 해상도와 분석 FPS 낮추기: 발열 상태가 올라가면 단계적으로 낮추는 정책을 제품에 넣습니다.
3. 외형 확인 주기 늘리기: 위험이 낮은 구간의 확인 간격을 늘립니다.
4. 모델 양자화: 자체 모델을 쓰는 경로에서만 해당합니다.

## English

No real-device FPS, thermal, or battery baseline exists yet. Use `tools/bench-tracker.mjs` for regression timing and `tools/android-profile.mjs` on a physical device. Budget values are initial targets, not measured results.
