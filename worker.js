// MOVOKA Cloudflare Worker
// 정적 HTML은 ASSETS에서 제공하고 /api/movies는 Worker에서 KOFIC(KOBIS) API를 호출합니다.

const KOFIC_BASE = 'https://kobis.or.kr/kobisopenapi/webservice/rest';

const GENRE_MAP = {
  '공포(호러)': '공포',
  '호러': '공포',
  '코미디': '코미디',
  '스릴러': '스릴러',
  '액션': '액션',
  '드라마': '드라마',
  '멜로/로맨스': '멜로/로맨스',
  '애니메이션': '애니메이션',
  'SF': 'SF',
  '판타지': '판타지',
  '범죄': '범죄',
  '미스터리': '미스터리',
  '모험': '모험',
  '전쟁': '전쟁',
  '다큐멘터리': '다큐멘터리'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=21600, s-maxage=21600'
    }
  });
}

function normalizeGenres(genres = []) {
  // KOFIC의 장르명을 MOVOKA 장르명으로 통일합니다.
  return [...new Set(
    genres.map(item => GENRE_MAP[item.genreNm] || item.genreNm).filter(Boolean)
  )];
}

function getKoreaDateMinusOne() {
  // 서버가 어느 지역에서 실행되더라도 한국 날짜 기준으로 전일을 계산합니다.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const utc = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  utc.setUTCDate(utc.getUTCDate() - 1);

  return utc.toISOString().slice(0, 10).replaceAll('-', '');
}

async function getMovies(env) {
  const key = env.KOBIS_API_KEY;
  if (!key) {
    return json({
      ok: false,
      code: 'KOBIS_API_KEY_MISSING',
      message: 'KOBIS_API_KEY 환경변수가 설정되지 않았습니다.'
    }, 503);
  }

  const targetDt = getKoreaDateMinusOne();

  // 일일 박스오피스에서 현재 영화 후보를 가져옵니다.
  const boxofficeUrl = new URL(`${KOFIC_BASE}/boxoffice/searchDailyBoxOfficeList.json`);
  boxofficeUrl.searchParams.set('key', key);
  boxofficeUrl.searchParams.set('targetDt', targetDt);

  const boxofficeResponse = await fetch(boxofficeUrl);
  if (!boxofficeResponse.ok) {
    throw new Error(`KOFIC boxoffice HTTP ${boxofficeResponse.status}`);
  }

  const boxofficeData = await boxofficeResponse.json();
  const dailyList = boxofficeData?.boxOfficeResult?.dailyBoxOfficeList || [];
  const candidates = dailyList.slice(0, 20);

  const movies = await Promise.all(candidates.map(async item => {
    const detailUrl = new URL(`${KOFIC_BASE}/movie/searchMovieInfo.json`);
    detailUrl.searchParams.set('key', key);
    detailUrl.searchParams.set('movieCd', item.movieCd);

    try {
      const response = await fetch(detailUrl);
      if (!response.ok) return null;

      const data = await response.json();
      const movie = data?.movieInfoResult?.movieInfo;
      if (!movie) return null;

      return {
        id: movie.movieCd,
        title: movie.movieNm,
        date: movie.openDt
          ? `${movie.openDt.slice(0, 4)}-${movie.openDt.slice(4, 6)}-${movie.openDt.slice(6, 8)}`
          : '',
        genres: normalizeGenres(movie.genres),
        rating: movie.audits?.[0]?.watchGradeNm || '',
        runtime: movie.showTm || '',
        rank: Number(item.rank) || 999,
        audience: Number(item.audiAcc) || 0,
        screens: Number(item.scrnCnt) || 0,
        shows: Number(item.showCnt) || 0,
        // 실제 극장별 상영 여부가 확인되기 전까지는 임의의 극장명을 넣지 않습니다.
        cinemas: []
      };
    } catch {
      return null;
    }
  }));

  return json({
    ok: true,
    source: 'KOFIC/KOBIS',
    basedAt: targetDt,
    movies: movies.filter(Boolean).sort((a, b) => a.rank - b.rank)
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API 요청은 Worker가 직접 처리합니다.
    if (url.pathname === '/api/movies') {
      try {
        return await getMovies(env);
      } catch (error) {
        return json({
          ok: false,
          code: 'KOFIC_FETCH_ERROR',
          message: '영화 데이터를 가져오지 못했습니다.'
        }, 502);
      }
    }

    // 홈페이지는 기존 정적 파일을 그대로 제공하되 라이브 JS를 HTML에 주입합니다.
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      return new HTMLRewriter()
        .on('body', {
          element(element) {
            element.append('<script src="/movoka-live.js" defer></script>', { html: true });
          }
        })
        .transform(assetResponse);
    }

    return assetResponse;
  }
};
