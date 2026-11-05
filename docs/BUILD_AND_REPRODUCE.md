# 설치와 재현

## 필요한 것

- Node.js 24 이상. 기본 검사와 측정에는 다른 패키지가 필요 없습니다.
- Android 측정을 하려면 adb와 USB 디버깅을 켠 기기가 필요합니다.

처음이면 [바로 써 보기](INTEGRATION.md) 부터 보세요.

## 이 저장소만으로 되는 것

| 명령 | 결과 |
|---|---|
| `npm run demo` | 이 PC 안에서 여는 브라우저 데모 |
| `npm test` | 아래 기본 검사와 합성 시험 기준 비교 |
| `node tools/eval-synthetic.mjs` | 가혹 조건 합성 시험 |
| `node tools/self-test.mjs` | 표시와 지문, 공개 안전, 웹·Android 상수, 추적 코어, 탐지, 모델 받기 검사 |
| `node tools/check-parity.mjs` | 웹과 Android의 추적 상수 비교 |
| `node tools/bench-tracker.mjs` | 추적 코어의 프레임당 시간 측정 |
| `node tools/detect-copy.mjs <폴더>` | 복제 여부 검사 |
| `node tools/fetch-models.mjs --all-public` | 공개 모델을 받아 해시 확인 |

## 이 저장소만으로 안 되는 것

- 제품 화면과 저장 흐름은 들어 있지 않습니다.
- 자체 가중치 세 개는 비공개입니다. 없으면 이를 쓰는 진단 경로가 동작하지 않습니다. 기본 추적 코어, 잇기, 카메라 보정은 자체 가중치 없이 돌아갑니다. 요청 방법은 [가중치 요청](WEIGHTS_ACCESS.md) 에 있습니다.
- 시험 영상과 정답 라벨은 권리와 동의 문제로 공개하지 않습니다. 정확도 수치를 이 저장소에서 다시 재현할 수는 없습니다.

## 자동 빌드에서 의존성을 넣는 순서

1. 코드를 받습니다. 가중치는 저장소에 없습니다.
2. `node tools/fetch-models.mjs --all-public --cache <캐시 폴더>` 로 공개 모델을 받습니다.
3. 비공개 모델 사용을 승인받았다면 `--id <모델> --source <받은 위치>` 로 받습니다. 권한 값은 환경변수 `HILIT_MODEL_TOKEN` 으로만 넘깁니다.
4. 해시가 다르면 도구가 실패하고 파일을 남기지 않습니다. 이때 빌드를 멈춥니다.
5. `node tools/self-test.mjs` 를 돌립니다.

## 사본 갱신 (저작자 전용)

비공개 정본 폴더가 있어야 합니다.

```bash
HILIT_WEB_REPO=<웹 정본> HILIT_ANDROID_REPO=<Android 정본> node tools/sync-runtime.mjs
HILIT_WEB_REPO=<웹 정본> HILIT_ANDROID_REPO=<Android 정본> node tools/sync-runtime.mjs --check
```

갱신은 정본의 `origin/main` 커밋만 읽습니다. 표시와 지문, 모델 목록, 코드 지문을 함께 다시 만듭니다. 저장소에는 정본이 없어 공개 CI는 `--check` 를 돌리지 못합니다. 대신 지문과 공개 안전 검사를 돌립니다.

## English

Requires Node.js 24+. `node tools/self-test.mjs` runs without any other dependency. Product UI, private weights, test footage, and labels are not included, so accuracy results cannot be reproduced from this repository alone.
