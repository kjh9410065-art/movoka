// MOVOKA 일일 공연 데이터 갱신 프로그램입니다.
// GitHub Actions 서버에서 실행되므로 사용자 PC가 켜져 있을 필요가 없습니다.
// 공연 데이터 강제 갱신이 필요한 경우에도 이 파일 변경으로 Actions를 즉시 실행할 수 있습니다.

import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
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

// KOPIS 조회 결과를 페이지 끝까지 전부 가져옵니다. 공연 등록 수에는 상한을 두지 않습니다.
async function fetchWindow(start, end) {
  const items = [];
  let page = 1;

  while (true) {
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

    // 100개 미만이면 마지막 페이지이므로 다음 날짜 구간으로 넘어갑니다.
    if (pageItems.length < ROWS) break;
    page += 1;
  }

  return items;
}

// KOPIS의 31일 조회 제한에 맞춰 모든 후보를 30일 구간으로 나눠 수집합니다.
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
  for (const item of items) {
    if (!item.mt20id) continue;
    map.set(item.mt20id, { ...item, prfstate: state });
  }
  return [...map.values()];
}

// 공연 예정은 시작일이 빠른 순서대로 정렬합니다.
function sortUpcoming(items) {
  return [...items].sort((a, b) => {
    const dateCompare = compactDate(a.prfpdfrom).localeCompare(compactDate(b.prfpdfrom));
    if (dateCompare !== 0) return dateCompare;
    return String(a.prfnm || '').localeCompare(String(b.prfnm || ''), 'ko');
  });
}

// 공연 종료일이 오늘보다 이전인 데이터는 제외하고 현재/예정 공연만 저장합니다.
function normalize(items, today) {
  const current = uniqueById(filterCurrent(items, today), '02');
  const upcoming = sortUpcoming(uniqueById(filterUpcoming(items, today), '01'));
  const allMap = new Map([...current, ...upcoming].map(item => [item.mt20id, item]));
  return { updatedAt: new Date().toISOString(), current, upcoming, items: [...allMap.values()] };
}

// 매일 새로 조회하고 현재/예정 공연을 분리해 저장합니다.
const today = dateKst(0);
const candidates = await fetchWindows(-MAX_LOOKBACK_DAYS, MAX_LOOKAHEAD_DAYS);
const data = normalize(candidates, today);

// 최종 결과 JSON을 정적 파일로 저장합니다.
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`기준일: ${today}`);
console.log(`저장: ${OUTPUT}`);