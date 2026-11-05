# 바로 써 보기

자체 가중치와 제품 화면 없이 할 수 있는 일을 쉬운 순서로 적었습니다. Node.js 24 이상이면 설치할 것이 없습니다.

## 1. 브라우저 데모 (1분)

```bash
npm run demo     # http://127.0.0.1:4173
```

가혹 장면을 골라 추적 결과와 정답을 함께 봅니다. 내 영상을 열어 드래그로 대상을 고르면 DCF 위치 추적을 돌려 볼 수 있습니다. 영상은 브라우저 밖으로 나가지 않습니다.

## 2. 내 코드에서 부르기

프레임 위치 추적은 [`examples/track-your-frames.mjs`](../examples/track-your-frames.mjs) 를 봅니다.

```js
const tracker = new HilitDcfTrackerCore();
tracker.init(frame, box, 0);
const { box: next, status, confidence } = tracker.update(frame2, 0.1);
// frame = { data: RGBA 배열, width, height }, box = { x, y, width, height }
```

`confidence` 는 위치 관측의 품질입니다. 동일인 확률이 아닙니다.

제품 기본 잇기는 [`examples/link-your-detections.mjs`](../examples/link-your-detections.mjs) 를 봅니다. 사람 검출 결과만 넘기면 됩니다.

## 3. 어떤 부분에 무엇이 필요한가

| 기능 | 코드 | 필요한 모델 |
|---|---|---|
| 위치 추적 (DCF), 카메라 보정, 구도 | `generated/dcf-tracker.js`, `affine-gmc.js`, `follow-camera.ts` | 없음 |
| 대상 잇기, 재등장 확인 (제품 기본) | `linked-core.js`, `linked-tracker.js` | 사람 검출 결과. 공개 EfficientDet-Lite0 또는 다른 검출기 |
| 사람 모양 마스크 | `person-mask/worker.js` | 공개 Pose Landmarker lite (없으면 생략) |
| 합성 자료로 학습한 자체 검출·관절 | `hilit-person-detector.js` | 비공개 가중치. 제품의 사람 후보에는 쓰지 않음 |

공개 모델은 `node tools/fetch-models.mjs --all-public` 으로 받고 해시를 확인합니다. 해당 모델의 라이선스는 [제3자 고지](../THIRD_PARTY_NOTICES.md) 를 따릅니다.

## 4. 내 영상으로 채점하기

추적 결과와 정답을 JSON으로 만들어 넣으면 합성 시험과 같은 기준으로 채점합니다. 형식은 [`tools/eval-track.mjs`](../tools/eval-track.mjs) 머리말에 있습니다.

```bash
node tools/eval-track.mjs --pred 결과.json --gt 정답.json
```

## 빠져 있는 것

제품 화면, 저장 흐름, 시험 영상과 라벨은 공개하지 않습니다. 그래서 제품과 같은 편집 경험이나 저작자의 실사 수치를 이 저장소만으로 재현할 수는 없습니다.

## English

Run `npm run demo` for a local browser demo, or see `examples/` for the DCF tracker and the default linking code with your own detector. No private weights are needed for these paths. Product UI, footage, and labels are not included.
