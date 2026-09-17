// MOVOKA 일일 공연 데이터 갱신 프로그램입니다.
// GitHub Actions 서버에서 실행되므로 사용자 PC가 켜져 있을 필요가 없습니다.

import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
const MAX_PAGES = 100;
const LOOKBACK_DAYS = 365;
const LOOKAHEAD_DAYS = 365;
const WINDOW_DAYS = 31;

// KST 기준 오늘 날짜를 YYYYMMDD 형식으로 만듭니다.
function todayKst() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

// YYYYMMDD 날짜에 일수를 더하거나 빼서 새 날짜를 만듭니다.
function shiftDate(value, days) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6)) - 1;
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

// KOPIS API의 최대 31일 범위에 맞춰 날짜 구간을 나눕니다.
function makeWindows(start, end) {
  const windows = [];
  let cursor = start;

  while (cursor <= end) {
    const windowEnd = shiftDate(cursor, WINDOW_DAYS - 1);
    const actualEnd = windowEnd < end ? windowEnd : end;
    windows.push({ start: cursor, end: actualEnd });
    cursor = shiftDate(actualEnd, 1);
  }

  return windows;
}

// 지정한 날짜 구간을 100개씩 끝까지 조회합니다.
async function fetchWindow(start, end) {
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('/api/performances', API_BASE);
    url.searchParams.set('page', String(page));
    url.searchParams.set('rows', String(ROWS));
    url.searchParams.set('stdate', start);
    url.searchParams.set('eddate', end);

    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data?.error || `공연 데이터 조회 실패: HTTP ${response.status}`);
    }

    const pageItems = data.items || [];
    items.push(...pageItems);
    console.log(`${start}~${end}, page ${page}: ${pageItems.length}개`);

    // 100개보다 적으면 실제 마지막 페이지입니다.
    if (pageItems.length < ROWS) break;
  }

  return items;
}

// 종료일이 지난 데이터는 저장 단계에서도 한 번 더 제거합니다.
function removeExpired(items, today) {
  return items.filter(item => !item.prfpdto || item.prfpdto.replaceAll('.', '') >= today);
}

// 날짜 기준으로 현재 공연과 예정 공연을 정확히 나눕니다.
function normalize(items, today) {
  const currentMap = new Map();
  const upcomingMap = new Map();

  for (const item of removeExpired(items, today)) {
    const start = (item.prfpdfrom || '').replaceAll('.', '');
    const end = (item.prfpdto || '').replaceAll('.', '');

    // 오늘이 공연기간 안에 있으면 현재 공연으로 분류합니다.
    if (start && end && start <= today && today <= end) {
      currentMap.set(item.mt20id, { ...item, prfstate: '02' });
      continue;
    }

    // 아직 시작하지 않은 공연은 예정 공연으로 분류합니다.
    if (start && start > today) {
      upcomingMap.set(item.mt20id, { ...item, prfstate: '01' });
    }
  }

  const current = [...currentMap.values()];
  const upcoming = [...upcomingMap.values()];
  const allMap = new Map([...current, ...upcoming].map(item => [item.mt20id, item]));

  return {
    updatedAt: new Date().toISOString(),
    current,
    upcoming,
    items: [...allMap.values()]
  };
}

// 오늘부터 과거 1년과 미래 1년을 31일 단위로 나눠 전체 후보를 수집합니다.
const today = todayKst();
const pastStart = shiftDate(today, -LOOKBACK_DAYS);
const futureEnd = shiftDate(today, LOOKAHEAD_DAYS);
const windows = makeWindows(pastStart, futureEnd);
const allItems = [];

for (const window of windows) {
  allItems.push(...await fetchWindow(window.start, window.end));
}

// 공연 ID 기준으로 중복을 먼저 제거합니다.
const uniqueMap = new Map();
for (const item of allItems) {
  if (item.mt20id) uniqueMap.set(item.mt20id, item);
}

// JSON 파일을 생성하여 Cloudflare 정적 자산으로 배포할 수 있게 합니다.
const data = normalize([...uniqueMap.values()], today);
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`조회범위: ${pastStart} ~ ${futureEnd}`);
console.log(`저장: ${OUTPUT}`);
