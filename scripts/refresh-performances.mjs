// MOVOKA 일일 공연 데이터 갱신 프로그램입니다.
// GitHub Actions 서버에서 실행되며 사용자 PC가 켜져 있을 필요가 없습니다.

import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
const MAX_PAGES = 100;

// KOPIS Worker API를 100개 단위로 끝까지 조회합니다.
async function fetchAll() {
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('/api/performances', API_BASE);
    url.searchParams.set('page', String(page));
    url.searchParams.set('rows', String(ROWS));

    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data?.error || `공연 데이터 조회 실패: HTTP ${response.status}`);
    }

    items.push(...(data.items || []));
    console.log(`page ${page}: ${data.items?.length || 0}개`);

    // 100개보다 적으면 실제 마지막 페이지로 판단합니다.
    if ((data.items || []).length < ROWS) break;
  }

  return items;
}

// 종료일이 지난 데이터는 저장 단계에서도 한 번 더 제거합니다.
function removeExpired(items) {
  const now = new Date();
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return items.filter(item => !item.prfpdto || item.prfpdto >= today);
}

// 중복 공연을 제거하고 현재/예정 데이터로 나눠 저장합니다.
function normalize(items) {
  const unique = new Map();
  for (const item of removeExpired(items)) unique.set(item.mt20id, item);

  const all = [...unique.values()];
  return {
    updatedAt: new Date().toISOString(),
    current: all.filter(item => item.prfstate === '02'),
    upcoming: all.filter(item => item.prfstate === '01'),
    items: all
  };
}

// JSON 파일을 생성하여 Cloudflare 정적 자산으로 배포할 수 있게 합니다.
const data = normalize(await fetchAll());
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`저장: ${OUTPUT}`);
