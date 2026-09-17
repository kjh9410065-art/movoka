// MOVOKA 일일 공연 데이터 갱신 프로그램입니다.
// GitHub Actions 서버에서 실행되므로 사용자 PC가 켜져 있을 필요가 없습니다.

import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
const MAX_PAGES = 100;

// KST 기준 오늘 날짜를 YYYYMMDD 형식으로 만듭니다.
function todayKst() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

// 오늘 하루만 조회하면서 KOPIS의 상태별 데이터를 가져옵니다.
async function fetchByState(state, today) {
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('/api/performances', API_BASE);
    url.searchParams.set('page', String(page));
    url.searchParams.set('rows', String(ROWS));
    url.searchParams.set('stdate', today);
    url.searchParams.set('eddate', today);
    url.searchParams.set('prfstate', state);

    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data?.error || `공연 데이터 조회 실패: HTTP ${response.status}`);

    const pageItems = data.items || [];
    items.push(...pageItems);
    console.log(`오늘 ${today}, state ${state}, page ${page}: ${pageItems.length}개`);
    if (pageItems.length < ROWS) break;
  }

  return items;
}

// 오늘 기준 종료된 공연은 저장하지 않습니다.
function removeExpired(items, today) {
  return items.filter(item => !item.prfpdto || item.prfpdto.replaceAll('.', '') >= today);
}

// KOPIS의 공연중/공연예정 결과를 각각 저장합니다.
function normalize(currentItems, upcomingItems, today) {
  const currentMap = new Map();
  const upcomingMap = new Map();

  for (const item of removeExpired(currentItems, today)) currentMap.set(item.mt20id, { ...item, prfstate: '02' });
  for (const item of removeExpired(upcomingItems, today)) upcomingMap.set(item.mt20id, { ...item, prfstate: '01' });

  const current = [...currentMap.values()];
  const upcoming = [...upcomingMap.values()];
  const allMap = new Map([...current, ...upcoming].map(item => [item.mt20id, item]));

  return { updatedAt: new Date().toISOString(), current, upcoming, items: [...allMap.values()] };
}

// 매일 오늘 하루의 공연정보만 가져오고 공연중/공연예정을 나눕니다.
const today = todayKst();
const [current, upcoming] = await Promise.all([
  fetchByState('02', today),
  fetchByState('01', today)
]);

// 결과를 정적 JSON으로 저장합니다.
const data = normalize(current, upcoming, today);
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`조회일: ${today}`);
console.log(`저장: ${OUTPUT}`);
