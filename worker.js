// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 안전하게 중계하고 정적 사이트를 제공합니다.
const ROWS = 100;
const FIRST_ROWS = 28;
const BATCH_PAGES = 6;
const LIST_CACHE_TTL = 900;
const DETAIL_CACHE_TTL = 86400;
const TICKET_BATCH_SIZE = 20;
const DETAIL_CONCURRENCY = 5;

// KOPIS canonical HTTPS 주소를 직접 사용합니다.
const KOPIS_BASE = 'https://kopis.or.kr/openApi/restful/pblprfr';

// 날짜를 KOPIS 형식인 YYYYMMDD로 변환합니다.
function ymd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// Cloudflare Cache API용 키를 만듭니다.
function cacheKey(value) {
  return new Request(`https://movoka-cache.invalid/${encodeURIComponent(value)}`);
}

// KOPIS XML의 공연 목록을 추출합니다.
function dbs(xml) {
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}

// 공연 ID를 추출합니다.
function idOf(db) {
  return db.match(/<mt20id>[\s\S]*?<\/mt20id>/)?.[1] || '';
}

// KOPIS API를 호출하고 응답 오류를 확인합니다.
async function kopis(api) {
  const response = await fetch(api.toString(), { redirect: 'follow' });
  const text = await response.text();
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}: ${text.slice(0, 180)}`);
  return text;
}

// 화면의 검색 조건을 KOPIS 요청으로 변환합니다.
function baseApi(url, key) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);
  const api = new URL(KOPIS_BASE);
  api.searchParams.set('service', key);
  api.searchParams.set('stdate', url.searchParams.get('stdate') || ymd(now));
  api.searchParams.set('eddate', url.searchParams.get('eddate') || ymd(end));
  const genre = url.searchParams.get('shcate') || '';
  const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || url.searchParams.get('shigucodesub') || '';
  const keyword = url.searchParams.get('shprfnm') || '';
  if (genre) api.searchParams.set('shcate', genre);
  if (area) api.searchParams.set('signgucode', area);
  if (keyword) api.searchParams.set('shprfnm', keyword);
  return api;
}

// 첫 화면에 필요한 28개를 가져옵니다.
async function firstPage(api) {
  const request = new URL(api);
  request.searchParams.set('cpage', '1');
  request.searchParams.set('rows', String(FIRST_ROWS));
  return kopis(request);
}

// Cloudflare 외부 요청 제한을 피하면서 6페이지를 한 번에 가져옵니다.
async function batchPages(api, start) {
  const first = Number(start) || 2;
  const requests = [];
  for (let page = first; page < first + BATCH_PAGES; page++) {
    const request = new URL(api);
    request.searchParams.set('cpage', String(page));
    request.searchParams.set('rows', String(ROWS));
    requests.push(request);
  }
  const results = await Promise.all(requests.map(kopis));
  const items = [];
  const seen = new Set();
  let done = false;
  for (const xml of results) {
    const pageItems = dbs(xml);
    for (const db of pageItems) {
      const id = idOf(db);
      if (id && !seen.has(id)) {
        seen.add(id);
        items.push(db);
      }
    }
    if (pageItems.length < ROWS) {
      done = true;
      break;
    }
  }
  return { items, nextStart: first + BATCH_PAGES, done };
}

export default {
  async fetch(request, env) {
    // Worker 요청과 API 키를 준비합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;
    if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

    if (url.pathname === '/api/debug-kopis') {
      // KOPIS 연결 여부를 1건으로 빠르게 테스트합니다.
      try {
        const api = baseApi(url, key);
        api.searchParams.set('cpage', '1');
        api.searchParams.set('rows', '1');
        const xml = await kopis(api);
        return Response.json({ ok: true, host: KOPIS_BASE, dbCount: dbs(xml).length, responseLength: xml.length });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error).slice(0, 300) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/performances/first' || url.pathname === '/api/performances') {
      // 첫 페이지 API를 제공합니다. 구형 /api/performances 경로도 유지합니다.
      const keyUrl = `first-v13:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const hit = await caches.default.match(cacheKey(keyUrl));
      if (hit) return hit;
      try {
        const xml = await firstPage(baseApi(url, key));
        if (!dbs(xml).length) throw new Error('KOPIS returned 0 performances');
        const response = new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300'
          }
        });
        await caches.default.put(cacheKey(keyUrl), response.clone());
        return response;
      } catch (error) {
        return Response.json({ error: String(error?.message || error).slice(0, 300) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/performances/batch') {
      // 전체 목록을 6페이지 단위로 제공합니다.
      const start = Math.max(2, Number(url.searchParams.get('start') || 2));
      const keyUrl = `batch-v5:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const hit = await caches.default.match(cacheKey(keyUrl));
      if (hit) return hit;
      try {
        const batch = await batchPages(baseApi(url, key), start);
        const body = JSON.stringify({
          xml: `<dbs>${batch.items.join('')}</dbs>`,
          nextStart: batch.nextStart,
          done: batch.done,
          count: batch.items.length
        });
        const response = new Response(body, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`
          }
        });
        await caches.default.put(cacheKey(keyUrl), response.clone());
        return response;
      } catch (error) {
        return Response.json({ error: String(error?.message || error).slice(0, 300) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/performance') {
      // 상세보기와 예매 사이트에서 사용하는 공연 상세정보를 제공합니다.
      const id = url.searchParams.get('mt20id') || '';
      if (!/^PF\d+$/.test(id)) return Response.json({ error: 'Invalid performance ID' }, { status: 400 });
      const keyUrl = `detail-v3:${url.origin}${url.pathname}?mt20id=${encodeURIComponent(id)}`;
      const hit = await caches.default.match(cacheKey(keyUrl));
      if (hit) return hit;
      try {
        const api = new URL(`${KOPIS_BASE}/${encodeURIComponent(id)}`);
        api.searchParams.set('service', key);
        const xml = await kopis(api);
        const response = new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': `public, max-age=${DETAIL_CACHE_TTL}`
          }
        });
        await caches.default.put(cacheKey(keyUrl), response.clone());
        return response;
      } catch (error) {
        return Response.json({ error: String(error?.message || error).slice(0, 300) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/ticket-status') {
      // 예매처 URL 존재 여부를 확인하는 기존 호환 API입니다.
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, TICKET_BATCH_SIZE);
      const result = {};
      let cursor = 0;
      const worker = async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++];
          try {
            const api = new URL(`${KOPIS_BASE}/${encodeURIComponent(id)}`);
            api.searchParams.set('service', key);
            const xml = await kopis(api);
            const urls = xml.match(/<relateurl>[\s\S]*?<\/relateurl>/g) || [];
            result[id] = urls.some(v => /^https?:\/\//i.test(v.replace(/<\/?relateurl>/g, '').trim()));
          } catch (_) {
            result[id] = false;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, worker));
      return Response.json({ statuses: result });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // HTML은 그대로 제공하고 별도 정적 로더만 연결합니다.
      const asset = await env.ASSETS.fetch(request);
      const html = await asset.text();
      const injected = html.replace('</body>', '<script src="/loader.js?v=3" defer></script></body>');
      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(injected, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  },
  async scheduled() {}
};
