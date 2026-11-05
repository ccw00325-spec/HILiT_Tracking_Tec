# 가중치 요청

제품의 기본 추적에는 저작자의 자체 가중치가 필요 없습니다. 먼저 공개 모델로 충분한지 확인해 주세요.

```bash
node tools/fetch-models.mjs --all-public
```

자체 가중치(`hilit-grid-*`, `hilit-pose-*`)는 합성 자료로 학습한 초기 모델이며 실제 영상의 사람 검출에는 알맞지 않습니다. 그래도 필요하면 **ccw00325@gmail.com** 으로 다음을 보내 주세요.

1. 이름과 소속, 연락처
2. 필요한 모델과 이유
3. 비상업 평가인지 상업 이용인지
4. 사용 기간과 보관 위치

승인되면 별도 약정을 맺은 뒤 받는 사람 전용 사본을 암호화해 드립니다. 사본마다 받는 사람을 식별하는 표시가 들어가며, 다시 나눠 줄 수 없습니다.

받은 파일은 이렇게 엽니다. 비밀번호는 다른 경로로 전달됩니다.

```bash
HILIT_BUNDLE_PASS=<비밀번호> node tools/open-weights-bundle.mjs <받은 파일> [--out <폴더>]
```

해시가 맞을 때만 파일을 풀고, 약정문을 함께 저장합니다.

## English

The default tracking path does not need the author's own weights. To request them, email ccw00325@gmail.com with your identity, the model and reason, noncommercial or commercial intent, and term. Approved recipients sign a separate agreement and receive an encrypted, recipient-marked copy that may not be redistributed.
