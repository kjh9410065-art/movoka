// MOVOKA 일일 공연 데이터 갱신 프로그램입니다.
// GitHub Actions 서버에서 실행되므로 사용자 PC가 켜져 있을 필요가 없습니다.

import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
const WINDOW_DAYS = 30;
const MAX_LOOKBACK_DAYS = 365;
const MAX_LOOKAHEAD_DAYS = 365;
const DETAIL_CONCURRENCY = 10;

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

// KOPIS 조회 결과를 페이지 끝까지 전부 가져옵니다.
// 등록 공연 수에 상한을 두지 않으며, 마지막 페이지가 확인될 때까지 계속 조회합니다.
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

    // 100개 미만이면 KOPIS의 마지막 페이지이므로 다음 구간으로 넘어갑니다.
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
  for (const item of items) map.set(item.mt20id, { ...item, prfstate: state });
  return [...map.values()];
}

// 공연 상세 XML에서 KOPIS가 등록한 예매/연계 사이트 URL을 추출합니다.
function parseBookingUrl(xml) {
  const urls = [...xml.matchAll(/<relates>[\s\S]*?<\/relates>/g)]
    .flatMap(block => [...block[0].matchAll(/<relateurl>([\s\S]*?)<\/relateurl>/g)].map(m => m[1].trim()))
    .filter(Boolean);
  return urls[0] || '';
}

// 공연 상세정보를 조회해 KOPIS 연계 예매 URL을 붙입니다.
async function fetchBookingUrl(id) {
  try {
    const url = new URL('/api/performance', API_BASE);
    url.searchParams.set('mt20id', id);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return '';
    return parseBookingUrl(await response.text());
  } catch {
    return '';
  }
}

// 많은 공연의 상세정보를 동시에 조회하되 요청 수를 제한합니다.
async function attachBookingUrls(items) {
  const result = [...items];
  let cursor = 0;
  async function worker() {
    while (cursor < result.length) {
      const index = cursor++;
      result[index] = { ...result[index], bookingUrl: await fetchBookingUrl(result[index].mt20id) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, result.length) }, worker));
  return result;
}

// 공연 예정은 시작일이 빠른 순서대로 정렬합니다.
function sortUpcoming(items) {
  return [...items].sort((a, b) => {
    const dateCompare = compactDate(a.prfpdfrom).localeCompare(compactDate(b.prfpdfrom));
    if (dateCompare !== 0) return dateCompare;
    return String(a.prfnm || '').localeCompare(String(b.prfnm || ''), 'ko');
  });
}

// 지난 날짜의 공연은 버리고, 현재와 예정 공연은 수량 제한 없이 모두 저장합니다.
async function normalize(items, today) {
  let current = uniqueById(filterCurrent(items, today), '02');
  let upcoming = uniqueById(filterUpcoming(items, today), '01');

  // 예매 URL은 현재/예정 전체에 대해 KOPIS 상세정보에서 가져옵니다.
  current = await attachBookingUrls(current);
  upcoming = await attachBookingUrls(upcoming);

  // 공연 예정은 예정일 순서대로 저장합니다.
  upcoming = sortUpcoming(upcoming);

  const allMap = new Map([...current, ...upcoming].map(item => [item.mt20id, item]));
  return { updatedAt: new Date().toISOString(), current, upcoming, items: [...allMap.values()] };
}

// 매일 새로 조회하고 현재/예정 공연을 분리해 저장합니다.
const today = dateKst(0);
const candidates = await fetchWindows(-MAX_LOOKBACK_DAYS, MAX_LOOKAHEAD_DAYS);
const data = await normalize(candidates, today);

// 최종 결과 JSON을 정적 파일로 저장합니다.
await mkdir('public/data', { recursive: true });
await writeFile(OUTPUT, JSON.stringify(data), 'utf8');
console.log(`완료: 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
console.log(`예매 URL 등록: ${[...data.current, ...data.upcoming].filter(x => x.bookingUrl).length}개`);
console.log(`기준일: ${today}`);
console.log(`저장: ${OUTPUT}`);
