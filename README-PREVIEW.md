# MOVOKA 기능 미리보기 (운영 서비스와 분리)

전용 브랜치: `preview/discovery-features-20261026`. **운영 주소 `https://movoka.tcflick.com/` 및 `main`에는 반영하지 않습니다.**

## 구현 기능
- 공연 찜하기(브라우저 localStorage, 회원가입·서버 저장 없음)
- 관람 날짜별 검색, 이번 주말·14일 이내 종료 추천, 날짜순·가나다순 정렬
- 공연명·공연장·지역 한글 검색
- 공연 상세페이지 찜하기, 기기 공유, 관람 날짜 선택 후 .ics 캘린더 저장
- 미리보기 검색엔진 색인 차단, 운영 광고·분석 수집 제외

## 기능 검증 및 별도 미리보기
GitHub Actions `MOVOKA isolated feature preview`가 JS 구문과 기능 테스트를 실행하고 미리보기 파일을 Artifact로 첨부합니다.

GitHub Secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`에 미리보기 Worker 생성 권한이 있으면 `movoka-preview`라는 **운영과 다른 Worker**를 배포합니다. 정확한 `workers.dev` 주소는 성공한 Wrangler 배포 로그를 확인하세요. 해당 Secret이 없으면 웹 주소는 자동 생성되지 않고 파일 묶음만 생성됩니다.

`wrangler.jsonc`에 운영 도메인 `routes`가 없으며 Worker 이름은 `movoka-preview`입니다. 이 브랜치는 초안 PR로 보관하고 운영 배포 전에는 병합하지 마세요.

공연 목록은 복제된 KOPIS 저장 데이터이며, 별도 Worker에서 최신 예매정보를 조회하려면 그 Worker에도 KOPIS 키가 필요할 수 있습니다.

## 오프라인 단일 HTML 미리보기
GitHub Actions의 `movoka-feature-preview` 파일 묶음 안에 있는 `public/preview-demo.html`을 휴대전화나 PC 브라우저에서 열면 목록/찜하기/날짜·정렬을 샘플 데이터로 시험할 수 있습니다. 실제 공연 상세페이지 서버는 아니므로 상세보기는 안내창으로 대체됩니다.
