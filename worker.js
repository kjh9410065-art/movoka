// MOVOKA Worker - KOPIS 공연 데이터 관리
// 매일 오전 7시 갱신을 기준으로 현재 공연과 예정 공연을 제공합니다.

const KOPIS_BASE = 'http://www.kopis.or.kr/openApi/restful/pblprfr';
const ROWS = 100;

// 날짜를 KOPIS가 요구하는 YYYYMMDD 형식으로 만듭니다.
function ymd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// KOPIS XML에서 공연 목록을 읽습니다.
function parseList(xml) {
  const matches = xml.match(/<db>[\s\S]*?<\/db>/g) || [];
  return matches.map(db => {
    const get = tag => db.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || '';
    return {
      mt20id: get('mt20id'), prfnm: get('prfnm'), prfpdfrom: get('prfpdfrom'),
      prfpdto: get('prfpdto'), fcltynm: get('fcltynm'), poster: get('poster'),
      genrenm: get('genrenm'), prfcast: get('prfcast'), prfstate: get('prfstate'),
      area: get('area'), prfurl: get('prfurl')
    };
  }).filter(x => x.mt20id);
}

// KOPIS API를 호출하고 정상 XML인지 확인합니다.
async function callKopis(url) {
  const response = await fetch(url.toString(), { redirect: 'follow' });
  const text = await response.text();
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}: ${text.slice(0, 300)}`);
  if (!text.includes('<dbs') && !text.includes('<db>')) throw new Error(`KOPIS 응답 형식 오류: ${text.slice(0, 300)}`);
  return text;
}

// 조회 기간은 오늘부터 30일 뒤까지이며, 종료일이 지난 공연은 추가로 제거합니다.
function makeListUrl(requestUrl, key, page, rows) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);
  const url = new URL(KOPIS_BASE);
  url.searchParams.set('service', key);
  url.searchParams.set('stdate', requestUrl.searchParams.get('stdate') || ymd(now));
  url.searchParams.set('eddate', requestUrl.searchParams.get('eddate') || ymd(end));
  url.searchParams.set('cpage', String(page));
  url.searchParams.set('rows', String(rows));
  for (const name of ['shcate', 'signgucode', 'signgucodesub', 'shprfnm']) {
    const value = requestUrl.searchParams.get(name);
    if (value) url.searchParams.set(name, value);
  }
  return url;
}

// 종료일이 오늘보다 이전인 공연을 제외합니다.
function removeExpired(items) {
  const today = ymd(new Date());
  return items.filter(item => !item.prfpdto || item.prfpdto >= today);
}

export default {
  async fetch(request, env) {
    // Worker에 등록된 KOPIS API 키를 확인합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;
    if (!key) return Response.json({ ok: false, error: 'KOPIS_API_KEY가 Worker에 없습니다.' }, { status: 500 });

    // 공연 목록을 100개 단위로 반환합니다.
    if (url.pathname === '/api/performances') {
      try {
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const rows = Math.min(ROWS, Math.max(1, Number(url.searchParams.get('rows') || ROWS)));
        const items = removeExpired(parseList(await callKopis(makeListUrl(url, key, page, rows))));
        return Response.json({ ok: true, page, rows, count: items.length, items, refreshedAt: ymd(new Date()) });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // KOPIS 연결 테스트용으로 공연 1개만 반환합니다.
    if (url.pathname === '/api/test') {
      try {
        const items = removeExpired(parseList(await callKopis(makeListUrl(url, key, 1, 1))));
        return Response.json({ ok: true, count: items.length, first: items[0] || null });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // 공연 상세정보를 제공합니다.
    if (url.pathname === '/api/performance') {
      const id = url.searchParams.get('mt20id') || '';
      if (!/^PF\d+$/.test(id)) return Response.json({ ok: false, error: '잘못된 공연 ID입니다.' }, { status: 400 });
      try {
        const detailUrl = new URL(`${KOPIS_BASE}/${id}`);
        detailUrl.searchParams.set('service', key);
        const xml = await callKopis(detailUrl);
        return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // 정적 파일은 ASSETS에서 그대로 제공합니다.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    // Cloudflare Cron이 매일 오전 7시에 실행합니다. 실제 목록은 다음 사용자 요청 시 최신 상태로 조회됩니다.
    console.log(`MOVOKA daily refresh completed: ${new Date().toISOString()}`);
  }
};
