#!/usr/bin/env bash
# 실패한 수집도 전체 재시도하고 push 충돌은 최신 원격 코드로 복구합니다.
set -Eeuo pipefail
export MOVOKA_REFRESH_STARTED_AT="$(node -p 'new Date().toISOString()')"
export MOVOKA_REFRESH_DATE="$(node --input-type=module -e 'import { refreshDate } from "./scripts/refresh-utils.mjs"; console.log(refreshDate())')"
for attempt in 1 2 3; do
  echo "전체 갱신 시도 ${attempt}/3"
  git fetch origin "${BRANCH}"
  git reset --hard "origin/${BRANCH}"
  # 조건문 내부에서 실패를 잡아 set -e가 재시도 루프를 끝내지 않게 합니다.
  if node scripts/refresh-performances.mjs && node scripts/generate-sitemap.mjs && node scripts/validate-refresh.mjs; then
    git add public/data/performances.json public/sitemap.xml
    if git diff --cached --quiet; then
      echo '전체 갱신 및 검증 완료: 파일 변경 없음'
      exit 0
    fi
    git commit -m 'chore: refresh MOVOKA performance data'
    if git push origin "HEAD:${BRANCH}"; then exit 0; fi
    echo 'Push 실패: 최신 원격 기준으로 다시 생성합니다.'
  else
    echo '수집 또는 검증 실패: 기존 원격 데이터는 유지하고 전체 재시도합니다.'
  fi
  if [ "$attempt" -lt 3 ]; then sleep $((attempt * 30)); fi
done
echo '::error::전체 갱신 3회 실패'
exit 1
