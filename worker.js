// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 브라우저에서 사용할 수 있도록 중계합니다.

const KOPIS_PAGE_ROWS = 100;
const DETAIL_CONCURRENCY = 5;

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

  // 공연예정(01)과 공연중(02)을 모두 조회합니다.
  for (const state of ['01', '02']) {
    let page = 1;

    // KOPIS는 페이지당 최대 100개만 반환하므로 마지막 페이지까지 반복 조회합니다.
    while (true) {
      const api = new URL(baseApi.toString());
      api.searchParams.set('prfstate', state);
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

      // 100개보다 적으면 해당 상태의 마지막 페이지입니다.
      if (matches.length < KOPIS_PAGE_ROWS) break;
      page++;
    }
  }

  return all;
}

function hasBookableTicket(xml) {
  // KOPIS 상세정보의 예매처 목록에서 실제 URL이 있는 공연만 예매 가능 공연으로 봅니다.
  return /<relateurl>https?:\/\//i.test(xml);
}

async function filterBookablePerformances(dbList, baseApi) {
  const bookable = [];
  let cursor = 0;

  // KOPIS 호출량을 과도하게 늘리지 않도록 상세 조회를 5개씩 처리합니다.
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= dbList.length) return;

      const id = dbList[index].match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
      if (!id) continue;

      try {
        const detailApi = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
        detailApi.searchParams.set('service', baseApi.searchParams.get('service') || '');
        const detailXml = await proxyKopis(detailApi);
        if (hasBookableTicket(detailXml)) bookable.push(dbList[index]);
      } catch (_) {
        // 개별 공연 조회 실패는 전체 목록 조회 실패로 처리하지 않습니다.
      }
    }
  }

  await Promise.all(Array.from({length: DETAIL_CONCURRENCY}, worker));
  return bookable;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});

      try {
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 30);

        const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
        api.searchParams.set('service', key);
        api.searchParams.set('stdate', url.searchParams.get('stdate') || getYmd(now));
        api.searchParams.set('eddate', url.searchParams.get('eddate') || getYmd(end));

        const genre = url.searchParams.get('shcate') || '';
        const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || '';
        const keyword = url.searchParams.get('shprfnm') || '';
        if (genre) api.searchParams.set('shcate', genre);
        if (area) api.searchParams.set('signgucode', area);
        if (keyword) api.searchParams.set('shprfnm', keyword);

        // 조건에 맞는 공연예정/공연중 공연을 모든 페이지에서 가져옵니다.
        const performances = await getAllPerformances(api);

        // 각 공연의 상세정보에서 실제 예매처 URL이 있는 공연만 남깁니다.
        const bookable = await filterBookablePerformances(performances, api);
        const xml = `<dbs>${bookable.join('')}</dbs>`;

        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
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
        const xml = await proxyKopis(api);
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();

      // 기존 캐시를 우회하여 수정된 전체 공연 데이터를 다시 받게 합니다.
      html = html.replaceAll('movoka-performances-cache:', 'movoka-performances-cache-v4:');
      html = html.replaceAll('movoka-performances-cache-v2:', 'movoka-performances-cache-v4:');
      html = html.replaceAll('movoka-performances-cache-v3:', 'movoka-performances-cache-v4:');
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
