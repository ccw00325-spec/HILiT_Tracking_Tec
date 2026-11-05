# 제3자 고지 / Third-party notices

이 표의 구성요소는 이 저장소의 `LICENSE` 가 아니라 각자의 라이선스를 따릅니다. 이 표는 코드와 코드 주석에서 확인한 내용이며 법률 검토를 거치지 않았습니다.

| 구성요소 | 이 저장소에서의 쓰임 | 라이선스 | 파일 포함 여부 |
|---|---|---|---|
| MediaPipe Tasks Vision 1.0.1 | 사람 후보 검출 실행기 | Apache-2.0 | 포함 안 함. 작업자 코드가 불러옵니다 |
| EfficientDet-Lite0 int8 | 사람 후보 검출 모델 | 가중치 Apache-2.0. 학습에 쓰인 COCO 사진의 개별 권리는 보증되지 않습니다 | 포함 안 함. `models/manifest.json` 의 주소와 해시 참고 |
| LiteRT | Android 실행기 | Apache-2.0 | 포함 안 함 |
| AMD FidelityFX CAS | `runtime/packages/tracking-core/src/enhance.ts` 의 선명화 식 | MIT, Copyright (c) 2020 Advanced Micro Devices, Inc. | 해당 파일에 식 일부 포함 |
| 1€ Filter | 평활 알고리즘 참고 | 원 저자 저장소 https://github.com/casiez/OneEuroFilter | 자체 구현 |

## AMD FidelityFX CAS (MIT)

Copyright (c) 2020 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 알고리즘 참고 / Papers

추적 코드 주석에 인용한 논문(KCF, MOSSE 계열 상관 필터, Li & Zhu 크기 탐색 등)은 참고 문헌입니다. 특허 비침해를 보증하지 않습니다.
