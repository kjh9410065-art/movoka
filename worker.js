// MOVOKA Cloudflare Worker
// 방문자는 저장된 일일 데이터를 즉시 받고, 데이터 갱신은 별도의 하루 1회 작업에서 담당합니다.

const KOFIC_BASE = 'https://www.kobis.or.kr/kobisopenapi/webservice/rest';
const KOBIS_WEB_BASE = 'https://www.kobis.or.kr';

const GENRE_MAP = {
  '공포(호러)': '공포', '호러': '공포', '코미디': '코미디', '스릴러': '스릴러',
  '액션': '액션', '드라마': '드라마', '멜로/로맨스': '멜로/로맨스', '애니메이션': '애니메이션',
  'SF': 'SF', '판타지': '판타지', '범죄': '범죄', '미스터리': '미스터리', '모험': '모험',
  '전쟁': '전쟁', '다큐멘터리': '다큐멘터리'
};

// 영화관별 공식 예매/상영 페이지입니다.
// 실제 상영작 제목이 페이지에서 확인된 경우에만 카드에 버튼을 노출합니다.
const CINEMA_SOURCES = {
  CGV: 'https://cgv.co.kr/cnm/movieBook/movie',
  롯데시네마: 'https://www.lottecinema.co.kr/NLCHS/Ticketing',
  메가박스: 'https://www.megabox.co.kr/booking/timetable'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

function normalizeGenres(genres = []) {
  return [...new Set(genres.map(item => GENRE_MAP[item.genreNm] || item.genreNm).filter(Boolean))];
}

function normalizeTitle(value = '') {
  // 영화관 페이지와 KOBIS 제목의 괄호/기호/공백 차이를 줄여 비교합니다.
  return String(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^0-9a-z가-힣]/gi, '');
}

async function fetchCinemaPage(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
        accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) return '';
    return await response.text();
  } catch (error) {
    console.error(`MOVOKA cinema source error (${url}):`, error);
    return '';
  }
}

async function getCinemaAvailability(movies) {
  // 하루 데이터 수집 시 영화관 공식 페이지를 한 번씩만 확인합니다.
  const pages = await Promise.all(Object.entries(CINEMA_SOURCES).map(async ([name, url]) => {
    const html = await fetchCinemaPage(url);
    return [name, normalizeTitle(html)];
  }));

  const pageMap = new Map(pages);
  return movies.map(movie => {
    const title = normalizeTitle(movie.title);
    const cinemas = title
      ? Object.keys(CINEMA_SOURCES).filter(name => {
          const pageText = pageMap.get(name) || '';
          return pageText.includes(title);
        })
      : [];
    return { ...movie, cinemas };
  });
}

function getKoreaDateMinusOne() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
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

async function collectMovies(env) {
  // 하루 1회 실행되어 KOFIC API에서 최신 데이터를 수집합니다.
  const key = env.KOBIS_API_KEY;
  if (!key) return { ok: false, code: 'KOBIS_API_KEY_MISSING', message: 'KOBIS_API_KEY 환경변수가 설정되지 않았습니다.' };

  const targetDt = getKoreaDateMinusOne();
  const boxofficeUrl = new URL(`${KOFIC_BASE}/boxoffice/searchDailyBoxOfficeList.json`);
  boxofficeUrl.searchParams.set('key', key);
  boxofficeUrl.searchParams.set('targetDt', targetDt);
  const boxofficeData = await getKoficJson(boxofficeUrl);
  const candidates = (boxofficeData?.boxOfficeResult?.dailyBoxOfficeList || []).slice(0, 20);

  const posterPromise = getPosterMap(targetDt).catch(error => {
    console.error('MOVOKA poster error:', error);
    return new Map();
  });

  const detailPromises = candidates.map(async item => {
    const detailUrl = new URL(`${KOFIC_BASE}/movie/searchMovieInfo.json`);
    detailUrl.searchParams.set('key', key);
    detailUrl.searchParams.set('movieCd', item.movieCd);
    try {
      const data = await getKoficJson(detailUrl);
      const movie = data?.movieInfoResult?.movieInfo;
      if (!movie) return null;
      return {
        id: movie.movieCd,
        title: movie.movieNm,
        date: movie.openDt ? `${movie.openDt.slice(0,4)}-${movie.openDt.slice(4,6)}-${movie.openDt.slice(6,8)}` : '',
        genres: normalizeGenres(movie.genres),
        rating: movie.audits?.[0]?.watchGradeNm || '',
        runtime: movie.showTm || '',
        rank: Number(item.rank) || 999,
        audience: Number(item.audiAcc) || 0,
        screens: Number(item.scrnCnt) || 0,
        poster: '',
        cinemas: []
      };
    } catch (error) {
      console.error(`MOVOKA movie detail error (${item.movieCd}):`, error);
      return null;
    }
  });

  const [posterMap, detailMovies] = await Promise.all([posterPromise, Promise.all(detailPromises)]);
  const movies = detailMovies.filter(Boolean).map(movie => ({
    ...movie,
    poster: posterMap.get(String(movie.id)) || ''
  })).sort((a, b) => a.rank - b.rank);

  // 영화관 공식 페이지에서 실제 상영작으로 확인된 체인만 저장합니다.
  const verifiedMovies = await getCinemaAvailability(movies);

  return {
    ok: true,
    source: 'KOFIC/KOBIS',
    basedAt: targetDt,
    movies: verifiedMovies
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/movies') {
      // 정상 방문에서는 KOFIC API를 호출하지 않고 KV에 저장된 데이터만 읽습니다.
      const stored = await env.MOVIE_DATA.get('latest', { type: 'json' });
      if (stored?.ok) return json(stored, 200, { 'cache-control': 'public, max-age=3600' });
      return json({ ok: false, code: 'MOVIE_DATA_NOT_READY', message: '오늘의 영화 데이터가 아직 준비되지 않았습니다.' }, 503);
    }

    if (url.pathname === '/internal/refresh-movies' && request.method === 'POST') {
      // 첫 배포 후 KV가 비어 있을 때 한 번만 초기 데이터를 생성합니다.
      const data = await collectMovies(env);
      if (!data.ok) return json(data, 503);
      await env.MOVIE_DATA.put('latest', JSON.stringify(data));
      return json({ ok: true, basedAt: data.basedAt, count: data.movies.length });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return new HTMLRewriter().on('body', {
        element(element) {
          element.append('<script src="/movoka-live.js?v=20260913-9" defer></script>', { html: true });
        }
      }).transform(assetResponse);
    }
    return assetResponse;
  },

  async scheduled(event, env, ctx) {
    // Cloudflare Cron이 하루 한 번 실행하면 최신 영화 데이터를 저장합니다.
    ctx.waitUntil((async () => {
      const data = await collectMovies(env);
      if (data.ok) await env.MOVIE_DATA.put('latest', JSON.stringify(data));
    })());
  }
};
