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

// 상태 필터를 걸지 않고 KOPIS의 전체 공연 후보를 가져옵니다.
// 상태 필터를 사용하면 KOPIS의 상태 분류와 날짜 조건이 함께 적용되어 장기 공연이 누락될 수 있습니다.
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
    if (!response.ok || !data.ok) throw new Error(data?.error || `공연 데이터 조회 실패: HTTP ${response.status}`);

    const pageItems = data.items || [];
    items.push(...pageItems);
    console.log(`전체, ${start}~${end}, page ${page}: ${pageItems.length}개`);
    if (pageItems.length < ROWS) break;
  }

  return items;
}

// KOPIS의 최대 31일 조회 제한에 맞춰 전체 후보를 구간별로 수집합니다.
async function fetchWindows(startOffset, endOffset) {
  const all = [];
  let cursor = startOffset;

  while (cursor < endOffset) {
    const next = Math.min(cursor + WINDOW_DAYS, endOffset);
    all.push(...await fetchWindow(dateKst(cursor), dateKst(next)));
    cursor = next;
  }

  return all;
}

// 날짜 문자열을 YYYYMMDD 비교용으로 정규화합니다.
function compactDate(value) {
  return String(value || '').replaceAll('.', '');
}

// 오늘 날짜가 공연기간 안에 포함되는 공연을 공연중으로 분류합니다.
function filterCurrent(items, today) {
  return items.filter(item => {
    const from = compactDate(item.prfpdfrom);
    const to = compactDate(item.prfpdto);
    return from && from <= today && (!to || to >= today);
  });
}

// 오늘 이후 시작하는 공연을 공연예정으로 분류합니다.
function filterUpcoming(items, today) {
  return items.filter(item => compactDate(item.prfpdfrom) > today);
}

// 여러 조회 구간에서 중복된 공연 ID를 하나로 합칩니다.
function uniqueById(items, state) {
  const map = new Map();
  for (const item of items) map.set(item.mt20id, { ...item, prfstate: state });
  return [...map.values()];
}

// 과거 공연은 저장하지 않고 오늘 기준 공연중/공연예정만 저장합니다.
function normalize(items, today) {
  const current = uniqueById(filterCurrent(items, today), '02');
  const upcoming = uniqueById(filterUpcoming(items, today), '01');
  const allMap = new Map([...current, ...upcoming].map(item => [item.mt20id, item]));
  return { updatedAt: new Date().toISOString(), current, upcoming, items: [...allMap.values()] };
}

// 매일 한 번 새로 조회하고, 최종 저장 데이터는 오늘 기준으로만 구성합니다.
// KOPIS가 공연 시작일 기준으로 검색하기 때문에 현재 공연을 놓치지 않도록 후보를 충분히 조회한 뒤 날짜로 직접 분류합니다.
const today = dateKst(0);
const candidates = await fetchWindows(-MAX_LOOKBACK_DAYS, MAX_LOOKAHEAD_DAYS);
const data = normalize(candidates, today);

// 최종 결과 JSON을 정적 파일로 저장합니다.
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`기준일: ${today}`);
console.log(`후보 조회: ${dateKst(-MAX_LOOKBACK_DAYS)} ~ ${dateKst(MAX_LOOKAHEAD_DAYS)}`);
console.log(`저장: ${OUTPUT}`);
