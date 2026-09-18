// MOVOKA Worker - KOPIS 공연 데이터 관리
// GitHub Actions 서버가 이 API를 통해 KOPIS 데이터를 가져옵니다.

// KOPIS 공식 Open API 운영 주소를 사용합니다.
const KOPIS_BASE = 'http://www.kopis.or.kr/openApi/restful/pblprfr';
const ROWS = 100;

// 날짜를 KOPIS가 요구하는 YYYYMMDD 형식으로 만듭니다.
function ymd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// KOPIS XML에서 공연 목록을 읽고 상태값을 코드로 통일합니다.
function parseList(xml) {
  const matches = xml.match(/<db>[\s\S]*?<\/db>/g) || [];
  return matches.map(db => {
    const get = tag => db.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || '';
    const state = get('prfstate');
    return {
      mt20id: get('mt20id'), prfnm: get('prfnm'), prfpdfrom: get('prfpdfrom'),
      prfpdto: get('prfpdto'), fcltynm: get('fcltynm'), poster: get('poster'),
      genrenm: get('genrenm'), prfcast: get('prfcast'),
      prfstate: state === '공연중' ? '02' : state === '공연예정' ? '01' : state,
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

// KOPIS 요청 조건을 URL로 만듭니다.
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
  for (const name of ['prfstate', 'shcate', 'signgucode', 'signgucodesub', 'shprfnm']) {
    const value = requestUrl.searchParams.get(name);
    if (value) url.searchParams.set(name, value);
  }
  return url;
}

// 외부 HTTP/HTTPS 주소만 허용하고 추적용 fragment는 제거합니다.
function normalizeBookingUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

// 예매사이트 URL의 형식만 확인합니다.
// 실제 예매사이트에 접속해서 응답 여부를 검사하면 사이트마다 수 초가 걸릴 수 있으므로,
// 목록 표시 단계에서는 네트워크 검사를 하지 않습니다.
async function isReachable(url) {
  return Boolean(normalizeBookingUrl(url));
}

// KOPIS 상세 XML에서 중복/잘못된 예매사이트를 제거하고 실제 접속 가능한 사이트만 남깁니다.
async function cleanBookingSites(xml) {
  const block = xml.match(/<relates>[\s\S]*?<\/relates>/)?.[0];
  if (!block) return xml;

  const pairs = [];
  const pairRegex = /<relatenm>([\s\S]*?)<\/relatenm>[\s\S]*?<relateurl>([\s\S]*?)<\/relateurl>/g;
  for (const match of block.matchAll(pairRegex)) {
    const name = match[1].trim();
    const url = normalizeBookingUrl(match[2]);
    if (!url) continue;
    pairs.push({ name, url });
  }

  const seenHosts = new Set();
  const valid = [];
  for (const site of pairs) {
    try {
      const host = new URL(site.url).hostname.replace(/^www\./, '').toLowerCase();
      if (seenHosts.has(host)) continue;
      if (!(await isReachable(site.url))) continue;
      seenHosts.add(host);
      valid.push(site);
    } catch {}
  }

  const cleanBlock = `<relates>${valid.map(site => `<relatenm>${site.name}</relatenm><relateurl>${site.url}</relateurl>`).join('')}</relates>`;
  return xml.replace(block, cleanBlock);
}

export default {
  async fetch(request, env) {
    // Worker에 등록된 KOPIS API 키를 확인합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;
    if (!key) return Response.json({ ok: false, error: 'KOPIS_API_KEY가 Worker에 없습니다.' }, { status: 500 });

    // 공연 목록은 KOPIS 원본 후보를 수량 제한 없이 페이지 끝까지 제공합니다.
    if (url.pathname === '/api/performances') {
      try {
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const rows = Math.min(ROWS, Math.max(1, Number(url.searchParams.get('rows') || ROWS)));
        const items = parseList(await callKopis(makeListUrl(url, key, page, rows)));
        return Response.json({ ok: true, page, rows, count: items.length, items, refreshedAt: ymd(new Date()) });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // KOPIS 연결 테스트용으로 공연 1개만 반환합니다.
    if (url.pathname === '/api/test') {
      try {
        const items = parseList(await callKopis(makeListUrl(url, key, 1, 1)));
        return Response.json({ ok: true, count: items.length, first: items[0] || null });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // 공연 상세정보를 제공하면서 예매사이트는 중복/오류 링크를 정리합니다.
    if (url.pathname === '/api/performance') {
      const id = url.searchParams.get('mt20id') || '';
      if (!/^PF\\d+$/.test(id)) return Response.json({ ok: false, error: '잘못된 공연 ID입니다.' }, { status: 400 });

      // 같은 공연의 예매사이트 정보는 잠시 캐시해 버튼을 다시 눌렀을 때 즉시 표시합니다.
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const detailUrl = new URL(KOPIS_BASE + '/' + id);
        detailUrl.searchParams.set('service', key);
        const xml = await callKopis(detailUrl);

        // 예매처 링크는 형식/중복만 정리하고 외부 사이트에 실제 접속하는 검사는 하지 않습니다.
        // 이렇게 해야 목록 팝업이 외부 사이트 응답을 기다리지 않고 바로 표시됩니다.
        const cleaned = await cleanBookingSites(xml);
        const response = new Response(cleaned, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=600'
          }
        });

        // 10분 동안 같은 공연의 상세 예매정보를 재사용합니다.
        await cache.put(cacheKey, response.clone());
        return response;
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    // 정적 파일은 ASSETS에서 그대로 제공합니다.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    // 실제 데이터 갱신은 GitHub Actions가 매일 오전 7시에 수행합니다.
    console.log(`MOVOKA daily refresh: ${new Date().toISOString()}`);
  }
};
