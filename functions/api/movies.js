// MOVOKA 영화 데이터 API
// KOBIS API 키를 브라우저에 노출하지 않고 Cloudflare Pages Function에서 호출합니다.
const KOBIS_BASE = 'https://kobis.or.kr/kobisopenapi/webservice/rest';

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

function normalizeGenres(genres = []) {
  // KOBIS의 실제 장르명을 MOVOKA의 장르 탭 이름으로 통일합니다.
  return [...new Set(genres.map(item => GENRE_MAP[item.genreNm] || item.genreNm).filter(Boolean))];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=21600, s-maxage=21600'
    }
  });
}

export async function onRequestGet(context) {
  const key = context.env.KOBIS_API_KEY;

  // Cloudflare에 KOBIS_API_KEY가 설정되지 않았을 때는 키를 노출하지 않고 안내합니다.
  if (!key) {
    return json({
      ok: false,
      code: 'KOBIS_API_KEY_MISSING',
      message: 'KOBIS_API_KEY 환경변수가 설정되지 않았습니다.'
    }, 503);
  }

  try {
    const now = new Date();
    now.setDate(now.getDate() - 1);
    const targetDt = now.toISOString().slice(0, 10).replaceAll('-', '');

    // 일일 박스오피스에서 실제 극장 상영 중인 영화 후보를 가져옵니다.
    const boxofficeUrl = new URL(`${KOBIS_BASE}/boxoffice/searchDailyBoxOfficeList.json`);
    boxofficeUrl.searchParams.set('key', key);
    boxofficeUrl.searchParams.set('targetDt', targetDt);

    const boxofficeResponse = await fetch(boxofficeUrl);
    if (!boxofficeResponse.ok) throw new Error(`KOBIS boxoffice HTTP ${boxofficeResponse.status}`);

    const boxofficeData = await boxofficeResponse.json();
    const dailyList = boxofficeData?.boxOfficeResult?.dailyBoxOfficeList || [];

    // 상위 20편만 상세 조회해 API 호출량을 제한합니다.
    const candidates = dailyList.slice(0, 20);

    const movies = await Promise.all(candidates.map(async item => {
      const detailUrl = new URL(`${KOBIS_BASE}/movie/searchMovieInfo.json`);
      detailUrl.searchParams.set('key', key);
      detailUrl.searchParams.set('movieCd', item.movieCd);

      try {
        const response = await fetch(detailUrl);
        if (!response.ok) return null;
        const data = await response.json();
        const m = data?.movieInfoResult?.movieInfo;
        if (!m) return null;

        const genres = normalizeGenres(m.genres);
        return {
          id: m.movieCd,
          title: m.movieNm,
          date: m.openDt ? `${m.openDt.slice(0,4)}-${m.openDt.slice(4,6)}-${m.openDt.slice(6,8)}` : '',
          genres,
          rating: m.audits?.[0]?.watchGradeNm || '',
          runtime: m.showTm || '',
          rank: Number(item.rank) || 999,
          audience: Number(item.audiAcc) || 0,
          screens: Number(item.scrnCnt) || 0,
          shows: Number(item.showCnt) || 0,
          cinemas: ['CGV', '롯데시네마', '메가박스']
        };
      } catch {
        return null;
      }
    }));

    const result = movies.filter(Boolean).sort((a, b) => a.rank - b.rank);

    return json({
      ok: true,
      source: 'KOBIS',
      basedAt: targetDt,
      movies: result
    });
  } catch (error) {
    return json({
      ok: false,
      code: 'KOBIS_FETCH_ERROR',
      message: '영화 데이터를 가져오지 못했습니다.'
    }, 502);
  }
}
