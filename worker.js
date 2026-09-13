// MOVOKA Cloudflare Worker
// 정적 HTML은 ASSETS에서 제공하고 /api/movies는 Worker에서 KOFIC(KOBIS) API를 호출합니다.

const KOFIC_BASE = 'https://www.kobis.or.kr/kobisopenapi/webservice/rest';
const KOBIS_WEB_BASE = 'https://www.kobis.or.kr';
const MOVIE_CACHE_SECONDS = 600; // 같은 날에는 10분 동안 영화 데이터를 재사용합니다.

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

function normalizeGenres(genres = []) {
  // KOFIC의 장르명을 MOVOKA 장르명으로 통일합니다.
  return [...new Set(genres.map(item => GENRE_MAP[item.genreNm] || item.genreNm).filter(Boolean))];
}

function getKoreaDateMinusOne() {
  // 서버가 어느 지역에서 실행되더라도 한국 날짜 기준으로 전일을 계산합니다.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const utc = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10).replaceAll('-', '');
}

async function getKoficJson(url) {
  // KOBIS 응답을 JSON으로 읽고 API 자체의 오류 응답도 구분합니다.
  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`KOBIS_NON_JSON_HTTP_${response.status}`);
  }
  if (!response.ok) throw new Error(`KOBIS_HTTP_${response.status}`);
  if (data?.faultResult) {
    const fault = data.faultResult;
    throw new Error(`KOBIS_${fault.errorCode || 'API_ERROR'}:${fault.faultInfo || 'API 오류'}`);
  }
  return data;
}

async function getPosterMap(targetDt) {
  // KOBIS 공식 일일 데이터에는 원본 파일 위치와 썸네일이 함께 있습니다.
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
    if (row.fileSaveLoct && row.sysFileNm) {
      poster = new URL(`${row.fileSaveLoct}${row.sysFileNm}`, KOBIS_WEB_BASE).href;
    }
    if (!poster && row.thumbUrl) {
      poster = new URL(row.thumbUrl, KOBIS_WEB_BASE).href;
    }
    if (poster) map.set(String(row.movieCd), poster);
  }
  return map;
}

async function getMovies(env) {
  const key = env.KOBIS_API_KEY;
  if (!key) {
    return json({ ok: false, code: 'KOBIS_API_KEY_MISSING', message: 'KOBIS_API_KEY 환경변수가 설정되지 않았습니다.' }, 503);
  }

  const targetDt = getKoreaDateMinusOne();
  const boxofficeUrl = new URL(`${KOFIC_BASE}/boxoffice/searchDailyBoxOfficeList.json`);
  boxofficeUrl.searchParams.set('key', key);
  boxofficeUrl.searchParams.set('targetDt', targetDt);

  const boxofficeData = await getKoficJson(boxofficeUrl);
  const dailyList = boxofficeData?.boxOfficeResult?.dailyBoxOfficeList || [];
  const candidates = dailyList.slice(0, 20);

  // 포스터와 영화 상세 조회는 서로 기다리지 않고 동시에 시작합니다.
  const posterPromise = getPosterMap(targetDt).catch(error => {
    console.error('MOVOKA KOBIS poster error:', error);
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
        // 실제 극장별 상영 여부가 확인되기 전까지는 임의의 극장명을 넣지 않습니다.
        cinemas: []
      };
    } catch (error) {
      // 개별 영화 상세 조회 실패는 전체 목록을 막지 않도록 해당 영화만 제외합니다.
      console.error(`MOVOKA KOBIS movie detail error (${item.movieCd}):`, error);
      return null;
    }
  });

  // 상세 조회와 포스터 조회가 모두 끝난 뒤 한 번만 포스터를 연결합니다.
  const [posterMap, detailMovies] = await Promise.all([posterPromise, Promise.all(detailPromises)]);
  const movies = detailMovies.filter(Boolean).map(movie => ({
    ...movie,
    poster: posterMap.get(String(movie.id)) || ''
  })).sort((a, b) => a.rank - b.rank);

  return json({ ok: true, source: 'KOFIC/KOBIS', basedAt: targetDt, movies });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/movies') {
      // 매번 KOFIC API 20회 이상을 호출하지 않고 10분간 결과를 재사용합니다.
      // 첫 요청만 느리고 이후 방문/새로고침은 캐시에서 바로 응답합니다.
      const cacheKey = new Request(`${url.origin}/__movoka_movie_cache/${getKoreaDateMinusOne()}`);
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const response = await getMovies(env);
        if (response.ok) {
          const cachedResponse = new Response(response.body, response);
          cachedResponse.headers.set('cache-control', `public, max-age=0, s-maxage=${MOVIE_CACHE_SECONDS}`);
          ctx.waitUntil(cache.put(cacheKey, cachedResponse.clone()));
          return cachedResponse;
        }
        return response;
      } catch (error) {
        const detail = String(error?.message || 'unknown');
        return json({ ok: false, code: 'KOFIC_FETCH_ERROR', message: `영화 데이터를 가져오지 못했습니다. (${detail})` }, 502);
      }
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return new HTMLRewriter().on('body', {
        element(element) {
          // 정적 HTML 캐시 때문에 이전 화면이 남지 않도록 버전을 올립니다.
          element.append('<script src="/movoka-live.js?v=20260913-5" defer></script>', { html: true });
        }
      }).transform(assetResponse);
    }
    return assetResponse;
  }
};