<p align="center">
  <img src="assets/hilit-tec-banner.jpg" alt="AI Tec — Built for Real Work, Not Just Demos" width="100%">
</p>

# HILiT Tracking Tec

영상 속에서 사용자가 고른 한 사람을 따라가는 기술입니다. 사람 후보 찾기, 위치 추적, 카메라 움직임 보정, 대상 확인, 자동 구도까지 웹과 Android 코드를 담았습니다. 사람 데이터베이스나 신원 검색 시스템이 아닙니다.

> **비상업적 이용만 무료입니다.** 상업적으로 쓰려면 먼저 저작자의 서면 승인을 받아야 합니다: **ccw00325@gmail.com**
>
> 사용하거나 공개할 때는 **HILiT Tracking Tec**, **조찬우 (Chanwoo Cho)**, **https://github.com/ccw00325-spec/HILiT_Tracking_Tec** 를 꼭 표시해 주세요. 자세한 조건은 [`LICENSE`](LICENSE) 에 있습니다.

## 이용 조건 요약

| 이용 | 가능 여부 |
|---|---|
| 개인 학습, 교육, 비영리 연구, 비상업적 평가 | 가능. 출처 표시 필수 |
| 유료 제품, 수익 서비스, 영리 조직의 내부 사용, 고객 용역 | 사전 서면 승인 필수 |
| 이 기술로 만든 결과물의 판매, 이 코드를 참고한 상업 제품 개발 | 사전 서면 승인 필수 |
| 모델 학습 자료로 사용 | 사전 서면 승인 필수 |
| 몰래 추적, 감시, 신원 식별 | 승인과 무관하게 금지 |
| 지문, 저작권 표시, `NOTICE` 삭제 | 불가 |
| 가중치, 학습 자료, HILiT 이름과 로고 | 이 라이선스에 포함되지 않음 |

이 라이선스는 소스 공개 라이선스이며, OSI가 정의한 오픈소스 라이선스는 아닙니다.

## 구성

| 경로 | 내용 |
|---|---|
| `runtime/packages/` | 추적 코어와 공용 타입 (TypeScript) |
| `runtime/apps/web/` | 브라우저 추적 파이프라인, 사람 후보 검출 작업자 |
| `runtime/apps/android/` | Android 추적 코드 (Java) |
| `models/manifest.json` | 모델 이름, 크기, SHA-256. **가중치 파일은 없습니다** |
| `fingerprints/index.json` | 복제 탐지에 쓰는 코드 지문 |
| `tools/` | 검사, 측정, 모델 받기, 복제 탐지 도구 |
| `docs/` | 설치와 재현, 모델 배포, 모바일 성능, 스트레스 시험, 개인정보, 보호 구조 |

`runtime/` 은 비공개 제품 정본에서 뽑은 사본입니다. 직접 고치지 않고 `tools/sync-runtime.mjs` 로 갱신합니다.

## 바로 해 보기

Node.js 24 이상이면 설치할 것이 없습니다. 자체 가중치도 필요 없습니다.

```bash
npm run demo     # 브라우저 데모: 가혹 장면과 내 영상 추적
npm test         # 코드 검사와 가혹 조건 합성 시험
node examples/link-your-detections.mjs     # 내 검출기와 잇기 코드를 연결하는 예
```

자세한 내용은 [바로 써 보기](docs/INTEGRATION.md) 에 있습니다. 제품 화면이 빠져 있어 이 저장소만으로 완성된 앱이 되지는 않습니다.

## 문서

- [바로 써 보기](docs/INTEGRATION.md)
- [설치와 재현](docs/BUILD_AND_REPRODUCE.md)
- [모델과 가중치 배포](docs/MODELS.md)
- [가중치 요청](docs/WEIGHTS_ACCESS.md)
- [모바일 성능 측정](docs/MOBILE_PERFORMANCE.md)
- [가혹 조건 시험](docs/STRESS_TESTS.md)
- [개인정보와 영상 처리](docs/PRIVACY.md)
- [기술 보호와 도용 탐지](docs/PROTECTION.md)
- [상업적 이용 신청](docs/COMMERCIAL_LICENSING.md)
- [제3자 고지](THIRD_PARTY_NOTICES.md)

## English

HILiT Tracking Tec follows one user-selected person through a video: person proposals, position tracking, camera-motion compensation, target confirmation, and automatic framing, with web and Android code. It is not a person database or identity search system.

**Free for noncommercial use only. Commercial use requires prior written approval from the author: ccw00325@gmail.com.** You must credit **HILiT Tracking Tec**, **조찬우 (Chanwoo Cho)**, and **https://github.com/ccw00325-spec/HILiT_Tracking_Tec** whenever you use or publish it. See [`LICENSE`](LICENSE). This is a source-available license, not an OSI open source license. Weights are not included.

```bash
npm run demo
npm test
```
