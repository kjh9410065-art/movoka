# MOVOKA

연극·뮤지컬·클래식·국악·콘서트·무용·아동공연 등 문화생활 정보를 공식 데이터 중심으로 모아 보여주는 서비스입니다.

## 데이터 원칙

- 공연 데이터의 기본 공급원은 **공연예술통합전산망(KOPIS) Open API**입니다.
- KOPIS API 키는 `KOPIS_API_KEY` Cloudflare **Secret**으로만 관리합니다.
- 브라우저에 API 키를 노출하지 않습니다.
- 공연목록과 공연상세를 KOPIS 공식 API에서 직접 조회합니다.
- 비공식 공연정보 API, 무단 스크래핑, 임의 예매 URL은 사용하지 않습니다.
- 전시 데이터는 문화공공데이터광장·한국문화정보원·지자체 등에서 정식 API/공공데이터 이용조건이 확인된 공급원만 추가합니다.
- 실시간 잔여좌석 서비스로 표시하지 않습니다.

## 현재 구현

- Cloudflare Workers + Static Assets
- KOPIS 공연목록 API 서버 프록시
- KOPIS 공연상세 API 서버 프록시
- 장르 필터
- 지역 필터
- 공연명·공연장 검색
- 공연 포스터 / 기간 / 공연장
- 공식 KOPIS 상세정보
- 다크모드
- 반응형 모바일 화면
- API 키 브라우저 비노출
- Wrangler 버전 고정으로 Workers Builds 재현성 확보

## Cloudflare 설정

Worker의 **Settings → Variables and Secrets**에서 다음 값을 Secret으로 등록합니다.

`KOPIS_API_KEY`

배포 명령은 `npx wrangler deploy`이며, 프로젝트의 `package.json`에서 Wrangler 버전을 고정합니다.

## 공식 데이터 확장 계획

1. KOPIS 공연목록
2. KOPIS 공연상세
3. KOPIS 공연시설목록/상세
4. KOPIS 축제 데이터
5. 문화공공데이터광장 공연 데이터
6. 문화공공데이터광장 전시 데이터
7. 한국문화정보원 맞춤형 문화데이터
8. 서울 열린데이터광장 등 지자체 공식 문화 API
9. 국공립 문화기관 공식 Open API

각 공급원은 API 제공 여부와 이용조건을 확인한 뒤 연결합니다. HTML 무단 수집은 사용하지 않습니다.
