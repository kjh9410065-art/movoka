// MOVOKA Worker - KOPIS 연결을 가장 단순한 구조로 다시 만듭니다.

// KOPIS 공식 Open API 가이드의 운영 주소를 사용합니다.
const KOPIS_BASE = 'http://www.kopis.or.kr/openApi/restful/pblprfr';

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
      mt20id: get('mt20id'),
      prfnm: get('prfnm'),
      prfpdfrom: get('prfpdfrom'),
      prfpdto: get('prfpdto'),
      fcltynm: get('fcltynm'),
      poster: get('poster'),
      genrenm: get('genrenm'),
      prfcast: get('prfcast'),
      prfstate: get('prfstate'),
      area: get('area'),
      prfurl: get('prfurl')
    };
  }).filter(x => x.mt20id);
}

// KOPIS에 한 번 요청하고 원문 XML을 반환합니다.
async function callKopis(url) {
  const response = await fetch(url.toString(), { redirect: 'follow' });
  const text = await response.text();
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}: ${text.slice(0, 300)}`);
  if (!text.includes('<dbs') && !text.includes('<db>')) {
    throw new Error(`KOPIS 응답 형식 오류: ${text.slice(0, 300)}`);
  }
  return text;
}

// 화면 검색조건을 KOPIS URL로 변환합니다.
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

export default {
  async fetch(request, env) {
    // API 키가 없으면 정확한 오류를 바로 반환합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;
    if (!key) return Response.json({ ok: false, error: 'KOPIS_API_KEY가 Worker에 없습니다.' }, { status: 500 });

    // 가장 먼저 확인할 연결 테스트입니다. 공연 1개만 요청합니다.
    if (url.pathname === '/api/test') {
      try {
        const kopisUrl = makeListUrl(url, key, 1, 1);
        const xml = await callKopis(kopisUrl);
        const items = parseList(xml);
        return Response.json({ ok: true, count: items.length, first: items[0] || null });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // 공연 목록을 100개 단위로 반환합니다. 프론트가 필요한 페이지를 호출합니다.
    if (url.pathname === '/api/performances') {
      try {
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const rows = Math.min(100, Math.max(1, Number(url.searchParams.get('rows') || 100)));
        const kopisUrl = makeListUrl(url, key, page, rows);
        const xml = await callKopis(kopisUrl);
        const items = parseList(xml);
        return Response.json({ ok: true, page, rows, count: items.length, items });
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
        return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // 정적 파일은 ASSETS에서 그대로 제공합니다.
    return env.ASSETS.fetch(request);
  }
};
