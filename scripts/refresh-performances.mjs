// MOVOKA 일일 공연 데이터 갱신 프로그램
// KOPIS API를 통해 현재/예정 공연을 수집하고 검증 후 원자적으로 저장합니다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

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

function dateKst(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offsetDays));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

function compactDate(value) {
  const raw = String(value ?? '').trim();
  const digits = raw.replaceAll('.', '').replaceAll('-', '').replaceAll('/', '');
  return /^\\d{8}$/.test(digits) ? digits : '';
}

function validDateRange(item) {
  const from = compactDate(item.prfpdfrom);
  const to = compactDate(item.prfpdto);
  return Boolean(from && to && from <= to);
}

async function fetchWindow(start, end) {
  const items = [];
  let page = 1;
  while (true) {
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
        throw error;
      } catch (error) {
        lastError = error;
        const status = error?.status;
        const retryable = !status || status === 429 || status >= 500;
        console.error(`[수집 실패] ${start}~${end} page=${page}, 시도=${attempt}/${MAX_RETRIES}: ${error.message}`);
        if (!retryable || attempt === MAX_RETRIES) break;
        const retryAfter = Number(error?.retryAfterMs || 0);
        await sleep(retryAfter || Math.min(60000, 1500 * (2 ** (attempt - 1))));
      }
    }
    if (!pageItems) throw new Error(`공연 수집 최종 실패: ${lastError?.message || '알 수 없는 오류'}`);

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
  const today = dateKst(0);
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

  await rename(temporary, OUTPUT);
  console.log(`[성공] 현재 ${data.current.length}개 / 예정 ${data.upcoming.length}개 / 전체 ${data.items.length}개`);
  console.log(`[성공] 기준일=${today}, 저장=${OUTPUT}`);
}

main().catch(error => {
  console.error(`[갱신 실패] ${error.stack || error.message}`);
  process.exitCode = 1;
});
