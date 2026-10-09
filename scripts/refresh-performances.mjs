// MOVOKA 일일 공연 데이터 갱신 프로그램
// KOPIS API를 통해 현재/예정 공연을 수집하고 검증 후 원자적으로 저장합니다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { compactDate, refreshDate, validateData } from './refresh-utils.mjs';

const API_BASE = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const OUTPUT = 'public/data/performances.json';
const ROWS = 100;
const WINDOW_DAYS = 30;
const MAX_LOOKBACK_DAYS = 90;
const MAX_LOOKAHEAD_DAYS = 365;
const REQUEST_DELAY_MS = 1800;
const WINDOW_DELAY_MS = 3000;
const MAX_RETRIES = 5;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 모든 페이지와 재시도는 실행 시작 시 고정한 KST 날짜를 사용합니다.
const today = refreshDate();
function dateKst(offsetDays = 0) {
  const date = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)) + offsetDays));
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function validDateRange(item) {
  const from = compactDate(item.prfpdfrom);
  const to = compactDate(item.prfpdto);
  return Boolean(from && to && from <= to);
}

async function fetchWindow(start, end) {
  const items = [];
  let page = 1;
  const seenPages = new Set();
  while (true) {
    if (page > 1000) throw new Error(`페이지 상한 초과: ${start}~${end}`);
    const url = new URL('/api/performances', API_BASE);
    url.searchParams.set('page', String(page));
    url.searchParams.set('rows', String(ROWS));
    url.searchParams.set('stdate', start);
    url.searchParams.set('eddate', end);

    let pageItems;
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          headers: { Accept: 'application/json', 'User-Agent': 'MOVOKA/1.0' },
          signal: AbortSignal.timeout(30000)
        });
        const body = await response.text();
        let data;
        try { data = JSON.parse(body); }
        catch { throw new Error(`JSON 파싱 실패 (HTTP ${response.status})`); }

        if (response.ok && data?.ok === true && Array.isArray(data.items)) {
          pageItems = data.items;
          break;
        }
        const error = new Error(data?.error || `API 요청 실패: HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = data?.retryable;
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        error.retryAfterMs = retryAfter ? Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
        throw error;
      } catch (error) {
        lastError = error;
        const status = error?.status;
        const retryable = error.retryable ?? (!status || status === 429 || status >= 500);
        console.error(`[수집 실패] ${start}~${end} page=${page}, 시도=${attempt}/${MAX_RETRIES}: ${error.message}`);
        if (!retryable || attempt === MAX_RETRIES) break;
        const retryAfter = Number(error?.retryAfterMs || 0);
        await sleep(Math.min(60000, retryAfter || 1500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 1000));
      }
    }
    if (!pageItems) throw new Error(`공연 수집 최종 실패: ${lastError?.message || '알 수 없는 오류'}`);

    // 프록시가 같은 페이지를 반복 반환하면 불완전한 결과를 저장하지 않습니다.
    const signature = pageItems.map(item => item.mt20id).join(',');
    if (pageItems.length && seenPages.has(signature)) throw new Error(`반복 페이지 감지: ${start}~${end} page=${page}`);
    seenPages.add(signature);
    items.push(...pageItems);
    console.log(`[수집] ${start}~${end}, page ${page}: ${pageItems.length}개`);
    if (pageItems.length < ROWS) break;
    page += 1;
    await sleep(REQUEST_DELAY_MS);
  }
  return items;
}

async function fetchWindows(startOffset, endOffset) {
  const all = [];
  let cursor = startOffset;
  while (cursor < endOffset) {
    const next = Math.min(cursor + WINDOW_DAYS, endOffset);
    all.push(...await fetchWindow(dateKst(cursor), dateKst(next)));
    cursor = next;
    if (cursor < endOffset) await sleep(WINDOW_DELAY_MS);
  }
  return all;
}

function uniqueById(items, state) {
  const map = new Map();
  for (const item of items) {
    if (!item.mt20id) continue;
    map.set(item.mt20id, { ...item, prfstate: state });
  }
  return [...map.values()];
}

function normalize(items, today) {
  let invalidDates = 0;
  const eligible = items.filter(item => {
    if (!item.mt20id || !validDateRange(item)) {
      invalidDates += 1;
      return false;
    }
    return compactDate(item.prfpdto) >= today;
  });
  console.log(`[종료일 필터] 수집 ${items.length}개 / 날짜 오류·필수값 누락 ${invalidDates}개 / 종료 공연 제외 ${items.length - invalidDates - eligible.length}개 / 필터 통과 ${eligible.length}개`);

  const current = uniqueById(eligible.filter(item =>
    compactDate(item.prfpdfrom) <= today && compactDate(item.prfpdto) >= today
  ), '02');
  const upcoming = uniqueById(eligible.filter(item =>
    compactDate(item.prfpdfrom) > today && compactDate(item.prfpdto) >= today
  ), '01').sort((a, b) => {
    const diff = compactDate(a.prfpdfrom).localeCompare(compactDate(b.prfpdfrom));
    return diff || String(a.prfnm || '').localeCompare(String(b.prfnm || ''), 'ko');
  });
  const allMap = new Map([...current, ...upcoming].map(item => [item.mt20id, item]));
  const result = { updatedAt: new Date().toISOString(), current, upcoming, items: [...allMap.values()] };
  const expired = result.items.filter(item => compactDate(item.prfpdto) < today);
  if (expired.length) throw new Error(`종료일 검증 실패: ${expired.length}개 종료 공연이 남아 있습니다.`);
  if (!result.items.length) throw new Error('필터링 후 공연이 0건입니다. 기존 정상 데이터를 보호하기 위해 저장하지 않습니다.');
  return result;
}

async function main() {

  console.log(`[시작] MOVOKA 갱신 / 한국 날짜=${today}`);
  const candidates = await fetchWindows(-MAX_LOOKBACK_DAYS, MAX_LOOKAHEAD_DAYS);
  console.log(`[수집 완료] 전체 후보 ${candidates.length}개`);
  if (!candidates.length) throw new Error('KOPIS 수집 결과가 0건입니다. 기존 데이터를 보존합니다.');

  const data = normalize(candidates, today);
  const temporary = `${OUTPUT}.tmp`;
  await mkdir('public/data', { recursive: true });
  await writeFile(temporary, JSON.stringify(data), 'utf8');

  const check = JSON.parse(await readFile(temporary, 'utf8'));
  if (!Array.isArray(check.items) || !Array.isArray(check.current) || !Array.isArray(check.upcoming) ||
      check.items.length !== check.current.length + check.upcoming.length) {
    throw new Error('임시 데이터 파일 스키마 검증 실패');
  }
  const expired = check.items.filter(item => compactDate(item.prfpdto) < today);
  if (expired.length) throw new Error(`최종 저장 검증 실패: 종료 공연 ${expired.length}개`);

  validateData(check, today);
  await rename(temporary, OUTPUT);
  console.log(`[성공] 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
  console.log(`[성공] 기준일=${today}, 저장=${OUTPUT}`);
}

main().catch(error => {
  console.error(`[갱신 실패] ${error.stack || error.message}`);
  process.exitCode = 1;
});

