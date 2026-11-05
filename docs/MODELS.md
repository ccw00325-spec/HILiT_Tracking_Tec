# 모델과 가중치 배포

가중치는 코드와 분리되어 있습니다. 이 저장소에는 `models/manifest.json` 의 이름, 크기, SHA-256만 있습니다.

| 구분 | 모델 | 받는 법 | 권리 |
|---|---|---|---|
| 공개 | MediaPipe EfficientDet-Lite0 int8, Pose Landmarker lite, BlazeFace short range | `node tools/fetch-models.mjs --all-public` | Apache-2.0, 학습 사진의 개별 권리는 보증되지 않음 |
| 비공개 | `hilit-grid-sports-v1`, `hilit-grid-synth-v0`, `hilit-pose-synth-v0` | [가중치 요청](WEIGHTS_ACCESS.md) | 이 저장소의 `LICENSE` 로 허락되지 않음 |

## 받기 동작

- 임시 파일에 받고 해시가 맞을 때만 캐시로 옮깁니다. 끊기거나 변조돼도 깨진 파일이 남지 않습니다.
- 캐시 이름에 해시 앞부분이 들어가므로 버전이 바뀌어도 섞이지 않습니다.
- 네트워크 오류는 세 번까지 다시 시도합니다.
- 기본 캐시는 `~/.cache/hilit-models` 입니다. `--cache` 로 바꿀 수 있습니다.

## 가중치를 보호하는 구조

- 가중치는 공개 저장소와 그 이력에 없습니다. `tools/sync-runtime.mjs` 가 뽑을 때 빼고, `tools/self-test.mjs` 가 다시 들어오면 실패합니다.
- 해시가 공개되어 있어 다른 곳에서 같은 파일이 발견되면 `tools/detect-copy.mjs` 가 찾아냅니다. 다시 저장해 바이트가 달라진 파일은 찾지 못합니다.

## 앱에 넣을 때 남은 일

현재 제품은 모델을 앱 안에 넣거나 자체 서버에서 제공합니다. 앱이 처음 실행될 때 받아 두는 방식으로 바꾸려면 제품 코드에서 다음을 구현해야 하며, 이 저장소에는 포함되어 있지 않습니다.

1. 기기 저장소 여유 확인과 받기 전 안내
2. 이어받기와 실패 후 재시도
3. 해시 확인을 통과한 파일만 사용
4. 모델 버전을 바꿀 때 옛 파일 삭제

## English

Weights are not stored here. `models/manifest.json` lists hashes only. Public models can be fetched with `tools/fetch-models.mjs`; private models require the author's approval. A file is cached only after its SHA-256 matches.
