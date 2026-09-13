// MOVOKA Cloudflare Worker
// 영화 데이터는 KV에 저장하고, 영화 상세 정보는 필요할 때 KOBIS 자료에서 가져옵니다.

const KOFIC_BASE = 'https://www.kobis.or.kr/kobisopenapi/webservice/rest';
const KOBIS_WEB_BASE = 'https://www.kobis.or.kr';

const GENRE_MAP = {
  '공포(호러)': '공포', '호러': '공포', '코미디': '코미디', '스릴러': '스릴러',
  '액션': '액션', '드라마': '드라마', '멜로/로맨스': '멜로/로맨스', '애니메이션': '애니메이션',
  'SF': 'SF', '판타지': '판타지', '범죄': '범죄', '미스터리': '미스터리', '모험': '모험',
  '전쟁': '전쟁', '다큐멘터리': '다큐멘터리'
};

// 각 영화관의 현재 영화/예매 페이지를 확인해 해당 체인에서 실제로 노출되는 영화만 연결합니다.
const CINEMA_SOURCES = {
  CGV: 'https://cgv.co.kr/cnm/movieBook',
  롯데시네마: 'https://www.lottecinema.co.kr/NLCMW/ticketing?filter=movie',
  메가박스: 'https://www.megabox.co.kr/movie'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders } });
}

function normalizeGenres(genres = []) {
  return [...new Set(genres.map(item => GENRE_MAP[item.genreNm] || item.genreNm).filter(Boolean))];
}

function normalizeTitle(value = '') {
  return String(value).toLowerCase().replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/[^0-9a-z가-힣]/gi, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchCinemaPage(url) {
  try {
    const response = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36', accept: 'text/html,application/xhtml+xml' } });
    if (!response.ok) return '';
    return await response.text();
  } catch (error) {
    console.error(`MOVOKA cinema source error (${url}):`, error);
    return '';
  }
}

async function getCinemaAvailability(movies) {
  // 영화관 사이트가 서버 렌더링하지 않는 경우에도 기존 빈 배열을 그대로 고정하지 않습니다.
  // 각 소스의 응답 상태와 HTML을 함께 검사해 실제 페이지에서 확인되는 체인만 넣습니다.
  const results = await Promise.all(Object.entries(CINEMA_SOURCES).map(async ([name, url]) => {
    const html = await fetchCinemaPage(url);
    return [name, { html: normalizeTitle(html), available: Boolean(html) }];
  }));
  const pageMap = new Map(results);
  return movies.map(movie => {
    const title = normalizeTitle(movie.title);
    const cinemas = title
      ? Object.keys(CINEMA_SOURCES).filter(name => {
          const source = pageMap.get(name);
          return source?.available && source.html.includes(title);
        })
      : [];
    return { ...movie, cinemas };
  });
}

function getKoreaDateMinusOne() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const utc = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10).replaceAll('-', '');
}

async function getKoficJson(url) {
  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`KOBIS_NON_JSON_HTTP_${response.status}`); }
  if (!response.ok) throw new Error(`KOBIS_HTTP_${response.status}`);
  if (data?.faultResult) {
    const fault = data.faultResult;
    throw new Error(`KOBIS_${fault.errorCode || 'API_ERROR'}:${fault.faultInfo || 'API 오류'}`);
  }
  return data;
}

async function getPosterMap(targetDt) {
  const url = new URL(`${KOBIS_WEB_BASE}/kobis/business/main/searchMainDailyBoxOffice.do`);
  url.searchParams.set('startDate', `${targetDt.slice(0,4)}.${targetDt.slice(4,6)}.${targetDt.slice(6,8)}`);
  url.searchParams.set('endDate', `${targetDt.slice(0,4)}.${targetDt.slice(4,6)}.${targetDt.slice(6,8)}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`KOBIS_POSTER_PAGE_HTTP_${response.status}`);
  const rows = await response.json();
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.movieCd) continue;
    let poster = '';
    if (row.fileSaveLoct && row.sysFileNm) poster = new URL(`${row.fileSaveLoct}${row.sysFileNm}`, KOBIS_WEB_BASE).href;
    if (!poster && row.thumbUrl) poster = new URL(row.thumbUrl, KOBIS_WEB_BASE).href;
    if (poster) map.set(String(row.movieCd), poster);
  }
  return map;
}

async function getMovieInfoFromKobis(movieCd) {
  const response = await fetchWithTimeout(`${KOBIS_WEB_BASE}/kobis/business/main/searchMainRealTicket.do`, { redirect: 'follow', headers: { accept: 'application/json' } }, 5000);
  if (!response.ok) throw new Error(`KOBIS_MOVIE_INFO_HTTP_${response.status}`);
  const rows = await response.json();
  const movie = (Array.isArray(rows) ? rows : []).find(row => String(row?.movieCd) === String(movieCd));
  if (!movie) return { plot: '', director: '', trailer: '' };
  return { plot: String(movie.synop || '').trim(), director: String(movie.director || '').trim(), trailer: '' };
}

async function collectMovies(env) {
  const key = env.KOBIS_API_KEY;
  if (!key) return { ok: false, code: 'KOBIS_API_KEY_MISSING', message: 'KOBIS_API_KEY 환경변수가 설정되지 않았습니다.' };
  const targetDt = getKoreaDateMinusOne();
  const boxofficeUrl = new URL(`${KOFIC_BASE}/boxoffice/searchDailyBoxOfficeList.json`);
  boxofficeUrl.searchParams.set('key', key);
  boxofficeUrl.searchParams.set('targetDt', targetDt);
  const boxofficeData = await getKoficJson(boxofficeUrl);
  const candidates = (boxofficeData?.boxOfficeResult?.dailyBoxOfficeList || []).slice(0, 20);
  const posterPromise = getPosterMap(targetDt).catch(error => { console.error('MOVOKA poster error:', error); return new Map(); });
  const detailPromises = candidates.map(async item => {
    const detailUrl = new URL(`${KOFIC_BASE}/movie/searchMovieInfo.json`);
    detailUrl.searchParams.set('key', key);
    detailUrl.searchParams.set('movieCd', item.movieCd);
    try {
      const data = await getKoficJson(detailUrl);
      const movie = data?.movieInfoResult?.movieInfo;
      if (!movie) return null;
      return {
        id: movie.movieCd, title: movie.movieNm,
        date: movie.openDt ? `${movie.openDt.slice(0,4)}-${movie.openDt.slice(4,6)}-${movie.openDt.slice(6,8)}` : '',
        genres: normalizeGenres(movie.genres), rating: movie.audits?.[0]?.watchGradeNm || '', runtime: movie.showTm || '',
        rank: Number(item.rank) || 999, audience: Number(item.audiAcc) || 0, screens: Number(item.scrnCnt) || 0, poster: '', cinemas: []
      };
    } catch (error) { console.error(`MOVOKA movie detail error (${item.movieCd}):`, error); return null; }
  });
  const [posterMap, detailMovies] = await Promise.all([posterPromise, Promise.all(detailPromises)]);
  const movies = detailMovies.filter(Boolean).map(movie => ({ ...movie, poster: posterMap.get(String(movie.id)) || '' })).sort((a, b) => a.rank - b.rank);
  const verifiedMovies = await getCinemaAvailability(movies);
  return { ok: true, source: 'KOFIC/KOBIS', basedAt: targetDt, cinemaCheckedAt: new Date().toISOString(), movies: verifiedMovies };
}

async function refreshCinemaLinks(env) {
  const stored = await env.MOVIE_DATA.get('latest', { type: 'json' });
  if (!stored?.ok || !Array.isArray(stored.movies)) return null;
  const movies = await getCinemaAvailability(stored.movies);
  const data = { ...stored, cinemaCheckedAt: new Date().toISOString(), movies };
  await env.MOVIE_DATA.put('latest', JSON.stringify(data));
  return data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/movies') {
      let stored = await env.MOVIE_DATA.get('latest', { type: 'json' });
      if (stored?.ok && Array.isArray(stored.movies)) {
        // 기존에 저장된 cinemaCheckedAt이 있어도 모든 영화의 cinemas가 비어 있으면 즉시 재검사합니다.
        const hasCinemaData = stored.movies.some(movie => Array.isArray(movie.cinemas) && movie.cinemas.length > 0);
        const checkedAt = stored.cinemaCheckedAt ? Date.parse(stored.cinemaCheckedAt) : 0;
        const cinemaStale = !checkedAt || (Date.now() - checkedAt > 3 * 60 * 60 * 1000) || !hasCinemaData;
        if (cinemaStale) {
          const refreshed = await refreshCinemaLinks(env);
          if (refreshed) stored = refreshed;
        }
        return json(stored, 200, { 'cache-control': 'no-store' });
      }
      return json({ ok: false, code: 'MOVIE_DATA_NOT_READY', message: '오늘의 영화 데이터가 아직 준비되지 않았습니다.' }, 503);
    }
    if (url.pathname === '/api/movie-info') {
      const movieCd = url.searchParams.get('movieCd');
      if (!movieCd) return json({ ok: false, message: 'movieCd가 필요합니다.' }, 400);
      try {
        const info = await getMovieInfoFromKobis(movieCd);
        return json({ ok: true, ...info }, 200, { 'cache-control': 'public, max-age=21600' });
      } catch (error) {
        console.error('MOVOKA movie info error:', error);
        return json({ ok: false, message: '영화 정보를 불러오지 못했습니다.' }, 502);
      }
    }
    if (url.pathname === '/internal/refresh-movies' && request.method === 'POST') {
      const data = await collectMovies(env);
      if (!data.ok) return json(data, 503);
      await env.MOVIE_DATA.put('latest', JSON.stringify(data));
      return json({ ok: true, basedAt: data.basedAt, count: data.movies.length });
    }
    if (url.pathname === '/internal/refresh-cinema-links' && request.method === 'POST') {
      const data = await refreshCinemaLinks(env);
      if (!data) return json({ ok: false, message: '영화 데이터가 없습니다.' }, 503);
      return json({ ok: true, cinemaCheckedAt: data.cinemaCheckedAt });
    }
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return new HTMLRewriter().on('body', { element(element) { element.append('<script src="/movoka-live.js?v=20260913-14" defer></script>', { html: true }); } }).transform(assetResponse);
    }
    return assetResponse;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const data = await collectMovies(env);
      if (data.ok) await env.MOVIE_DATA.put('latest', JSON.stringify(data));
    })());
  }
};