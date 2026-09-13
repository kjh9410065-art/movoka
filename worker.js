// MOVOKA Cloudflare Worker
// 영화 데이터와 멀티체인 상영 여부는 KOBIS가 공식 제공하는 데이터만 사용합니다.
// 비공식 영화관 API, 크롤링 프록시, 우회 수집, KOBIS 결과의 KV 저장은 사용하지 않습니다.

const KOBIS_REAL_TICKET_URL = 'https://www.kobis.or.kr/kobis/business/main/searchMainRealTicket.do';
const KOBIS_MULTICHAIN_URL = 'https://www.kobis.or.kr/kobis/business/stat/boxs/findDailyMultichainList.do';
const KOBIS_BASE = 'https://www.kobis.or.kr';

const GENRE_MAP = {
  '공포(호러)': '공포', '호러': '공포', '코미디': '코미디', '스릴러': '스릴러',
  '액션': '액션', '드라마': '드라마', '멜로/로맨스': '멜로/로맨스', '애니메이션': '애니메이션',
  'SF': 'SF', '판타지': '판타지', '범죄': '범죄', '미스터리': '미스터리', '모험': '모험',
  '전쟁': '전쟁', '다큐멘터리': '다큐멘터리'
};

const CINEMA_NAMES = ['CGV', '롯데시네마', '메가박스'];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

async function fetchKobis(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json', ...(options.headers || {}) }
    });
    if (!response.ok) throw new Error(`KOBIS_HTTP_${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKobisJson(url, timeoutMs = 8000) {
  const response = await fetchKobis(url, timeoutMs);
  const text = await response.text();
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('KOBIS_INVALID_DATA');
  return data;
}

function getKoreaDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function normalizeGenres(genre = '') {
  return [...new Set(
    String(genre)
      .split(',')
      .map(item => GENRE_MAP[item.trim()] || item.trim())
      .filter(Boolean)
  )];
}

function normalizeMovieTitle(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCinemaName(value = '') {
  const text = normalizeMovieTitle(value);
  if (text.includes('CGV')) return 'CGV';
  if (text.includes('롯데시네마')) return '롯데시네마';
  if (text.includes('메가박스')) return '메가박스';
  return '';
}

function extractTableCells(rowHtml) {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => normalizeMovieTitle(match[1]));
}

function extractAnchorText(html) {
  const match = String(html).match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
  return match ? normalizeMovieTitle(match[1]) : normalizeMovieTitle(html);
}

// KOBIS 공식 멀티체인별 상영현황에서 실제 상영 중인 체인을 확인합니다.
async function getMultichainMap() {
  const targetDate = getKoreaDate(-1);
  const url = new URL(KOBIS_MULTICHAIN_URL);
  url.searchParams.set('loadEnd', '0');
  url.searchParams.set('searchType', 'search');
  url.searchParams.set('sSearchFrom', targetDate);
  url.searchParams.set('sSearchTo', targetDate);

  const response = await fetchKobis(url, 10000, {
    headers: { accept: 'text/html,application/xhtml+xml' }
  });
  const html = await response.text();
  const map = new Map();

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1];
    const cells = extractTableCells(rowHtml);
    if (cells.length < 4) continue;

    const movieName = extractAnchorText(
      (rowHtml.match(/<td\b[^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/td>/i) || [])[0] || cells[1]
    );
    const chainName = normalizeCinemaName(cells[2]);
    const screeningCount = Number(String(cells[3] || '').replace(/[^0-9]/g, '')) || 0;
    if (!movieName || !chainName || screeningCount <= 0) continue;

    const key = normalizeMovieTitle(movieName);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(chainName);
  }

  return map;
}

function toMovie(row, rankFallback = 999) {
  const poster = row.thumbUrl
    ? new URL(row.thumbUrl, KOBIS_BASE).href
    : '';

  return {
    id: String(row.movieCd || ''),
    title: String(row.movieNm || ''),
    date: String(row.openDt || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    genres: normalizeGenres(row.genre),
    rating: String(row.watchGradeNm || ''),
    runtime: Number(row.showTm) || 0,
    rank: Number(row.rank) || rankFallback,
    audience: Number(row.totalAudiCnt ?? row.audiCnt) || 0,
    screens: Number(row.scrnCnt) || 0,
    poster,
    cinemas: []
  };
}

async function getLiveMovies() {
  const rows = await fetchKobisJson(KOBIS_REAL_TICKET_URL);
  const multichainMap = await getMultichainMap().catch(error => {
    // 상영 여부를 확인할 수 없으면 영화를 노출하지 않습니다. 추측하지 않습니다.
    console.error('MOVOKA KOBIS multichain error:', error);
    return null;
  });

  // 상영현황을 확인할 수 없는 경우 종료/예정작이 섞일 수 있으므로 빈 목록으로 처리합니다.
  if (!multichainMap) {
    return {
      ok: true,
      source: '영화진흥위원회 영화관입장권통합전산망(KOBIS) 공식 데이터',
      basedAt: getKoreaDate(),
      live: true,
      cinemaCheckedAt: null,
      movies: []
    };
  }

  const today = getKoreaDate();

  const movies = rows
    .filter(row => row?.movieCd && row?.movieNm)
    // 오늘 이후 개봉 예정작은 제거합니다.
    .filter(row => {
      const openDate = String(row.openDt || '').replace(/[^0-9]/g, '');
      return !openDate || openDate <= today;
    })
    .map((row, index) => toMovie(row, index + 1))
    .map(movie => {
      const chains = multichainMap.get(normalizeMovieTitle(movie.title));
      movie.cinemas = chains ? CINEMA_NAMES.filter(name => chains.has(name)) : [];
      return movie;
    })
    // KOBIS 전일 멀티체인 상영횟수에 잡힌 영화만 노출합니다.
    // 따라서 상영이 끝난 영화와 아직 상영 전인 예정작이 목록에서 제거됩니다.
    .filter(movie => movie.cinemas.length > 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 20);

  return {
    ok: true,
    source: '영화진흥위원회 영화관입장권통합전산망(KOBIS) 공식 데이터',
    basedAt: today,
    live: true,
    cinemaCheckedAt: getKoreaDate(-1),
    movies
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/movies') {
      try {
        const data = await getLiveMovies();
        return json(data, 200, { 'cache-control': 'no-store' });
      } catch (error) {
        console.error('MOVOKA KOBIS live data error:', error);
        return json({
          ok: false,
          code: 'KOBIS_LIVE_DATA_ERROR',
          message: 'KOBIS 공식 영화 데이터를 불러오지 못했습니다.'
        }, 502, { 'cache-control': 'no-store' });
      }
    }

    if (url.pathname === '/api/movie-info') {
      const movieCd = url.searchParams.get('movieCd');
      if (!movieCd) return json({ ok: false, message: 'movieCd가 필요합니다.' }, 400);

      try {
        const rows = await fetchKobisJson(KOBIS_REAL_TICKET_URL, 5000);
        const movie = rows.find(row => String(row?.movieCd) === String(movieCd));
        if (!movie) return json({ ok: true, plot: '', director: '', trailer: '' });

        return json({
          ok: true,
          plot: String(movie.synop || '').trim(),
          director: String(movie.director || '').trim(),
          trailer: ''
        }, 200, { 'cache-control': 'no-store' });
      } catch (error) {
        console.error('MOVOKA movie info error:', error);
        return json({ ok: false, message: '영화 정보를 불러오지 못했습니다.' }, 502, { 'cache-control': 'no-store' });
      }
    }

    if (url.pathname === '/internal/refresh-cinema-links' && request.method === 'POST') {
      return json({
        ok: false,
        disabled: true,
        message: '영화관 체인 데이터는 KOBIS 공식 멀티체인 통계에서만 조회합니다.'
      }, 501);
    }

    if (url.pathname === '/internal/refresh-movies' && request.method === 'POST') {
      return json({
        ok: false,
        disabled: true,
        message: 'KOBIS 결과를 저장하지 않는 실시간 조회 구조입니다. /api/movies를 사용하세요.'
      }, 410);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return new HTMLRewriter().on('body', {
        element(element) {
          element.append('<script src="/movoka-live.js?v=20260913-20" defer></script>', { html: true });
        }
      }).transform(assetResponse);
    }
    return assetResponse;
  }
};