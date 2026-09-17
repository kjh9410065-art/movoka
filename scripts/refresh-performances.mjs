// MOVOKA 일일 공연 데이터 갱신 프로그램입니다.
// GitHub Actions 서버에서 실행되므로 사용자 PC가 켜져 있을 필요가 없습니다.

import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
const MAX_PAGES = 100;
const WINDOW_DAYS = 30;
const MAX_LOOKBACK_DAYS = 365;
const MAX_LOOKAHEAD_DAYS = 365;

// KST 기준 날짜를 YYYYMMDD 형식으로 만들고 날짜 이동도 정확히 처리합니다.
function dateKst(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offsetDays));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// KOPIS의 최대 조회기간에 맞춰 한 구간의 상태별 공연을 페이지 끝까지 가져옵니다.
async function fetchWindow(state, start, end) {
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('/api/performances', API_BASE);
    url.searchParams.set('page', String(page));
    url.searchParams.set('rows', String(ROWS));
    url.searchParams.set('stdate', start);
    url.searchParams.set('eddate', end);
    url.searchParams.set('prfstate', state);

    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data?.error || `공연 데이터 조회 실패: HTTP ${response.status}`);

    const pageItems = data.items || [];
    items.push(...pageItems);
    console.log(`state ${state}, ${start}~${end}, page ${page}: ${pageItems.length}개`);
    if (pageItems.length < ROWS) break;
  }

  return items;
}

// 여러 30일 구간을 연결해 필요한 상태의 전체 후보를 수집합니다.
async function fetchWindows(state, today, startOffset, endOffset) {
  const all = [];
  let cursor = startOffset;

  while (cursor < endOffset) {
    const next = Math.min(cursor + WINDOW_DAYS, endOffset);
    const start = dateKst(cursor);
    const end = dateKst(next);
    all.push(...await fetchWindow(state, start, end));
    cursor = next;
  }

  return all;
}

// 날짜 문자열의 점을 제거해 YYYYMMDD 비교가 가능하게 만듭니다.
function compactDate(value) {
  return String(value || '').replaceAll('.', '');
}

// 오늘 실제로 진행 중인 공연만 남깁니다.
function filterCurrent(items, today) {
  return items.filter(item => {
    const from = compactDate(item.prfpdfrom);
    const to = compactDate(item.prfpdto);
    return (!from || from <= today) && (!to || to >= today);
  });
}

// 오늘 이후 시작하는 공연예정 항목만 남깁니다.
function filterUpcoming(items, today) {
  return items.filter(item => {
    const from = compactDate(item.prfpdfrom);
    return from && from > today;
  });
}

// 공연 ID가 같은 중복 항목을 하나로 합치면서 상태를 명확하게 지정합니다.
function uniqueById(items, state) {
  const map = new Map();
  for (const item of items) map.set(item.mt20id, { ...item, prfstate: state });
  return [...map.values()];
}

// 조회 과정에서 과거 공연은 버리고 오늘 기준 공연중/공연예정만 저장합니다.
function normalize(currentItems, upcomingItems, today) {
  const current = uniqueById(filterCurrent(currentItems, today), '02');
  const upcoming = uniqueById(filterUpcoming(upcomingItems, today), '01');
  const allMap = new Map([...current, ...upcoming].map(item => [item.mt20id, item]));

  return {
    updatedAt: new Date().toISOString(),
    current,
    upcoming,
    items: [...allMap.values()]
  };
}

// KOPIS는 시작일 기준 조회라 오늘 하루만 조회하면 장기 공연과 미래 공연을 놓칩니다.
// 여러 30일 API 호출로 후보를 모은 뒤 최종 JSON에는 오늘 유효한 공연만 남깁니다.
const today = dateKst(0);
const currentStartOffset = -MAX_LOOKBACK_DAYS;
const upcomingEndOffset = MAX_LOOKAHEAD_DAYS;

const [current, upcoming] = await Promise.all([
  fetchWindows('02', today, currentStartOffset, 0),
  fetchWindows('01', today, 0, upcomingEndOffset)
]);

// 최종 JSON에는 과거 공연을 저장하지 않고 오늘 기준 공연중/공연예정만 저장합니다.
const data = normalize(current, upcoming, today);
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`기준일: ${today}`);
console.log(`현재 후보 조회: ${dateKst(currentStartOffset)} ~ ${today}`);
console.log(`예정 후보 조회: ${today} ~ ${dateKst(upcomingEndOffset)}`);
console.log(`저장: ${OUTPUT}`);
