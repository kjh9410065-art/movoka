// MOVOKA 일일 공연 데이터 갱신 프로그램입니다.
// GitHub Actions 서버에서 실행되므로 사용자 PC가 켜져 있을 필요가 없습니다.

import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
const MAX_PAGES = 100;
const WINDOW_DAYS = 30;
const MAX_LOOKBACK_DAYS = 730;
const MAX_LOOKAHEAD_DAYS = 730;

// KST 기준 날짜를 YYYYMMDD 형식으로 만듭니다.
function dateKst(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offsetDays));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

// KOPIS 날짜 형식에서 숫자만 남깁니다.
function compactDate(value) {
  return String(value || '').replaceAll('.', '').replaceAll('-', '');
}

// 한 조회구간의 모든 페이지를 끝까지 가져옵니다.
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

    const pageItems = Array.isArray(data.items) ? data.items : [];
    items.push(...pageItems);
    console.log(`조회 ${start}~${end} / ${page}페이지: ${pageItems.length}개`);
    if (pageItems.length < ROWS) break;
  }
  return items;
}

// KOPIS의 31일 제한 때문에 기간을 30일씩 나누어 전체 후보를 수집합니다.
async function fetchAllWindows(startOffset, endOffset) {
  const all = [];
  for (let cursor = startOffset; cursor < endOffset; cursor += WINDOW_DAYS) {
    const next = Math.min(cursor + WINDOW_DAYS, endOffset);
    all.push(...await fetchWindow(dateKst(cursor), dateKst(next)));
  }
  return all;
}

// 여러 구간에서 중복된 공연을 ID 기준으로 하나로 합칩니다.
function unique(items) {
  const map = new Map();
  for (const item of items) {
    if (item?.mt20id) map.set(item.mt20id, item);
  }
  return [...map.values()];
}

// 현재 공연은 오늘이 공연기간 안에 있는 작품만 남깁니다.
function getCurrent(items, today) {
  return unique(items.filter(item => {
    const from = compactDate(item.prfpdfrom);
    const to = compactDate(item.prfpdto);
    return from && from <= today && (!to || to >= today);
  })).map(item => ({ ...item, prfstate: '02' }));
}

// 공연 예정은 아직 시작하지 않은 작품을 별도 목록으로 만듭니다.
function getUpcoming(items, today) {
  return unique(items.filter(item => compactDate(item.prfpdfrom) > today))
    .map(item => ({ ...item, prfstate: '01' }));
}

// 공연중 작품을 예매 가능 여부와 시작일을 기준으로 정렬합니다.
function sortCurrent(items) {
  return [...items].sort((a, b) => {
    const bookA = a.prfurl ? 1 : 0;
    const bookB = b.prfurl ? 1 : 0;
    if (bookA !== bookB) return bookB - bookA;
    return compactDate(a.prfpdfrom).localeCompare(compactDate(b.prfpdfrom));
  });
}

// 공연 예정은 시작일이 가까운 작품부터 정렬합니다.
function sortUpcoming(items) {
  return [...items].sort((a, b) => compactDate(a.prfpdfrom).localeCompare(compactDate(b.prfpdfrom)));
}

// 지난 공연은 버리고 현재 공연과 예정 공연만 최종 저장합니다.
function normalize(items, today) {
  const valid = unique(items).filter(item => {
    const to = compactDate(item.prfpdto);
    return !to || to >= today;
  });
  const current = sortCurrent(getCurrent(valid, today));
  const upcoming = sortUpcoming(getUpcoming(valid, today));
  return {
    updatedAt: new Date().toISOString(),
    current,
    upcoming,
    items: [...current, ...upcoming]
  };
}

// 매일 전체 활성/예정 후보를 새로 받아 현재와 예정으로 분리합니다.
const today = dateKst(0);
const candidates = await fetchAllWindows(-MAX_LOOKBACK_DAYS, MAX_LOOKAHEAD_DAYS);
const data = normalize(candidates, today);

// 최종 공연 데이터를 정적 JSON으로 저장합니다.
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 공연중 ${data.current.length}개 / 공연예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`기준일: ${today}`);
