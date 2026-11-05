# 개인정보와 영상 처리

이 문서는 기술 동작을 설명합니다. 법률 자문이 아니며, 이용자는 자기 나라의 초상권, 개인정보, 생체정보 법령을 스스로 확인해야 합니다.

## 기술이 하는 일과 하지 않는 일

- 사용자가 고른 한 사람을 영상 한 편 안에서 따라갑니다.
- 외형 비교 점수는 고른 대상이 맞는지 보는 보조 근거입니다. 신원 확률이 아닙니다.
- 사람 데이터베이스, 갤러리 검색, 얼굴 인식으로 쓰는 기능을 만들지 않습니다.

## 코드에 들어 있는 안전장치

- 추적 분석은 브라우저나 기기 안에서 돕니다. 이 코드는 영상 프레임을 서버로 보내지 않습니다.
- MediaPipe의 사용 통계 전송은 작업자 안의 fetch 가드로 막습니다. 웹 응답의 `connect-src 'self'` 정책은 배포하는 쪽에서 함께 설정해야 합니다.
- 외형 정보는 영상 한 편을 처리하는 동안만 유지합니다.
- 이 저장소의 코드에는 사용자 정보나 사용 현황을 저작자에게 보내는 기능이 없습니다.

## 이용자가 지킬 일

- 영상 속 사람의 동의를 받고 촬영과 편집 목적을 알립니다.
- 다른 사람을 몰래 추적하거나 감시하는 데 쓰지 않습니다.
- 학습에 영상을 쓰려면 등장인물의 학습 동의와 영상 권리를 따로 확인합니다.
- 얼굴이나 신체 특징을 저장해 사람을 식별하면 별도 법규가 적용될 수 있습니다.

## English

Tracking runs on the user's device and follows one selected person within a single video. It is not an identification system, and this code sends no usage data to the author. Users are responsible for consent, portrait rights, and data protection law where they operate.
