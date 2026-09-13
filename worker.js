// MOVOKA Cloudflare Worker
// 영화 데이터는 KOBIS 공식 공개 데이터만 실시간으로 사용합니다.
// 비공식 영화관 API, 크롤링 프록시, 우회 수집, KOBIS 결과의 KV 저장은 사용하지 않습니다.

const KOBIS_REAL_TICKET_URL = 'https://www.kobis.or.kr/kobis/business/main/searchMainRealTicket.do';
const KOBIS_BASE = 'https://www.kobis.or.kr';

const GENRE_MAP = {
  '공포(호러)': '공포', '호러': '공포', '코미디': '코미디', '스릴러': '스릴러',
  '액션': '액션', '드라마': '드라마', '멜로/로맨스': '멜로/로맨스', '애니메이션': '애니메이션',
  'SF': 'SF', '판타지': '판타지', '범죄': '범죄', '미스터리': '미스터리', '모험': '모험',
  '전쟁': '전쟁', '다큐멘터리': '다큐멘터리'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

async function fetchKobis(timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // KOBIS가 직접 제공하는 공식 JSON 데이터를 실시간으로 조회합니다.
    const response = await fetch(KOBIS_REAL_TICKET_URL, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`KOBIS_HTTP_${response.status}`);

    const text = await response.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('KOBIS_INVALID_DATA');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function getKoreaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function normalizeGenres(genre = '') {
  return [...new Set(
    String(genre)
      .split(',')
      .map(item => GENRE_MAP[item.trim()] || item.trim())
      .filter(Boolean)
  )];
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
    // 공식적으로 확인 가능한 체인별 API가 연결될 때까지 추측하지 않습니다.
    cinemas: []
  };
}

async function getLiveMovies() {
  const rows = await fetchKobis();
  const movies = rows
    .filter(row => row?.movieCd && row?.movieNm)
    .slice(0, 20)
    .map((row, index) => toMovie(row, index + 1))
    .sort((a, b) => a.rank - b.rank);

  return {
    ok: true,
    source: '영화진흥위원회 영화관입장권통합전산망(KOBIS) 공식 데이터',
    basedAt: getKoreaDate(),
    live: true,
    cinemaCheckedAt: null,
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
        // 영화 정보 버튼을 누를 때도 공식 KOBIS 데이터를 실시간으로 조회합니다.
        const rows = await fetchKobis(5000);
        const movie = rows.find(row => String(row?.movieCd) === String(movieCd));
        if (!movie) {
          return json({ ok: true, plot: '', director: '', trailer: '' });
        }

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

    // 이전 비공식 수집 엔드포인트는 완전히 비활성화합니다.
    if (url.pathname === '/internal/refresh-cinema-links' && request.method === 'POST') {
      return json({
        ok: false,
        disabled: true,
        message: '공식적으로 허용된 영화관 체인 데이터 연동이 없어 비공식 수집을 사용하지 않습니다.'
      }, 501);
    }

    // 기존 KV 새로고침 호출도 더 이상 KOBIS 데이터를 저장하지 않도록 비활성화합니다.
    if (url.pathname === '/internal/refresh-movies' && request.method === 'POST') {
      return json({
        ok: false,
        disabled: true,
        message: 'KOBIS 결과의 지속 저장을 하지 않는 구조로 변경되었습니다. /api/movies에서 실시간 조회합니다.'
      }, 410);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return new HTMLRewriter().on('body', {
        element(element) {
          element.append('<script src="/movoka-live.js?v=20260913-18" defer></script>', { html: true });
        }
      }).transform(assetResponse);
    }
    return assetResponse;
  }
};