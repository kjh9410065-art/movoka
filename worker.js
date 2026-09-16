// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 브라우저에서 사용할 수 있도록 중계합니다.

const KOPIS_PAGE_ROWS = 100;
const DETAIL_CONCURRENCY = 5;
const DETAIL_CACHE_TTL = 86400;
const LIST_CACHE_TTL = 900;

function getYmd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function proxyKopis(api) {
  const response = await fetch(api.toString());
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

function extractDb(xml) {
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}

async function getAllPerformances(baseApi) {
  const all = [];
  const seen = new Set();
  let page = 1;

  // KOPIS는 페이지당 최대 100개만 반환하므로 실제 마지막 페이지까지 전부 조회합니다.
  while (true) {
    const api = new URL(baseApi.toString());
    api.searchParams.set('cpage', String(page));
    api.searchParams.set('rows', String(KOPIS_PAGE_ROWS));

    const xml = await proxyKopis(api);
    const matches = extractDb(xml);

    for (const db of matches) {
      const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(db);
      }
    }

    // 100개보다 적으면 해당 상태의 실제 마지막 페이지입니다.
    if (matches.length < KOPIS_PAGE_ROWS) break;
    page++;
  }

  return all;
}

function cacheRequest(url) {
  // Cloudflare Cache API에 저장할 내부 캐시 키를 만듭니다.
  return new Request(`https://movoka-cache.invalid/${encodeURIComponent(url)}`);
}

async function getCachedText(url) {
  // 이미 캐시된 KOPIS 상세 응답이 있으면 외부 API를 다시 호출하지 않습니다.
  const cached = await caches.default.match(cacheRequest(url));
  return cached ? cached.text() : null;
}

async function putCachedText(url, text, ttl) {
  // KOPIS 응답을 일정 시간 보관해 같은 공연의 반복 조회를 줄입니다.
  const response = new Response(text, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`
    }
  });
  await caches.default.put(cacheRequest(url), response);
}

async function hasTicketVendor(id, key) {
  // 공연 상세정보에서 KOPIS에 등록된 예매처 URL(relateurl)을 확인합니다.
  const api = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
  api.searchParams.set('service', key);
  const apiUrl = api.toString();

  // 같은 공연의 예매처 확인을 매 요청마다 KOPIS에 다시 보내지 않습니다.
  const cachedXml = await getCachedText(apiUrl);
  const xml = cachedXml || await proxyKopis(api);
  if (!cachedXml) await putCachedText(apiUrl, xml, DETAIL_CACHE_TTL);

  const urls = xml.match(/<relateurl>([\s\S]*?)<\/relateurl>/g) || [];

  // 실제 예매처 URL이 등록된 공연만 판매중 후보로 인정합니다.
  return urls.some(item => {
    const value = item.replace(/^<relateurl>/, '').replace(/<\/relateurl>$/, '').trim();
    return /^https?:\/\//i.test(value);
  });
}

async function filterBookablePerformances(performances, key) {
  const result = [];
  let next = 0;

  // 상세 API는 동시에 5개씩만 조회하여 KOPIS 요청 폭주를 방지합니다.
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= performances.length) return;

      const db = performances[index];
      const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
      if (!id) continue;

      try {
        // 예매처 URL이 등록된 공연만 최종 목록에 포함합니다.
        if (await hasTicketVendor(id, key)) result.push(db);
      } catch (_) {
        // 상세 조회 실패 공연은 예매 가능 여부를 확인할 수 없으므로 제외합니다.
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(DETAIL_CONCURRENCY, performances.length)}, worker));
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});

      // 캐시 버전으로 기존 결과를 우회하고 새 수집 로직을 사용합니다.
      const listCacheKey = `v3:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const cachedList = await caches.default.match(cacheRequest(listCacheKey));
      if (cachedList) return cachedList;

      try {
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 30);

        const baseApi = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
        baseApi.searchParams.set('service', key);
        baseApi.searchParams.set('stdate', url.searchParams.get('stdate') || getYmd(now));
        baseApi.searchParams.set('eddate', url.searchParams.get('eddate') || getYmd(end));

        const genre = url.searchParams.get('shcate') || '';
        const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || '';
        const keyword = url.searchParams.get('shprfnm') || '';
        if (genre) baseApi.searchParams.set('shcate', genre);
        if (area) baseApi.searchParams.set('signgucode', area);
        if (keyword) baseApi.searchParams.set('shprfnm', keyword);

        // KOPIS의 공연상태 01=공연예정, 02=공연중인 모든 공연을 수집합니다.
        const merged = new Map();
        for (const state of ['01', '02']) {
          const api = new URL(baseApi.toString());
          api.searchParams.set('prfstate', state);
          const performances = await getAllPerformances(api);
          for (const db of performances) {
            const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
            if (id && !merged.has(id)) merged.set(id, db);
          }
        }

        // 현재 예매처가 등록된 공연만 최종 목록으로 확정합니다.
        const bookable = await filterBookablePerformances(Array.from(merged.values()), key);
        const xml = `<dbs>${bookable.join('')}</dbs>`;
        const response = new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`
          }
        });

        // 검색조건별 전체 결과를 캐시하여 화면 페이지 이동에서는 KOPIS를 다시 호출하지 않습니다.
        await caches.default.put(cacheRequest(listCacheKey), response.clone());
        return response;
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});
      const id = url.searchParams.get('mt20id');
      if (!id || !/^PF\d+$/.test(id)) return Response.json({error:'Invalid mt20id'}, {status:400});

      try {
        const api = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
        api.searchParams.set('service', key);
        const apiUrl = api.toString();
        const cachedXml = await getCachedText(apiUrl);
        const xml = cachedXml || await proxyKopis(api);
        if (!cachedXml) await putCachedText(apiUrl, xml, DETAIL_CACHE_TTL);
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': `public, max-age=${DETAIL_CACHE_TTL}`
          }
        });
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();

      // 새 목록 API 캐시 버전이 적용되도록 브라우저의 이전 캐시 키를 무효화합니다.
      html = html.replaceAll('movoka-performances-cache:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v2:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v3:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v4:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v5:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v6:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v7:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v8:', 'movoka-performances-cache-v10:');
      html = html.replaceAll('movoka-performances-cache-v9:', 'movoka-performances-cache-v10:');
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');

      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(html, {status: asset.status, headers});
    }

    return env.ASSETS.fetch(request);
  },
  async scheduled(){}
};
