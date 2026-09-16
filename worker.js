// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 브라우저에서 사용할 수 있도록 중계합니다.

const KOPIS_PAGE_ROWS = 100;

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

  // KOPIS는 페이지당 최대 100개만 반환하므로 마지막 페이지까지 반복 조회합니다.
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

        // KOPIS의 공연상태 01=공연예정, 02=공연중이므로 두 상태를 모두 수집합니다.
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

        // 조건에 맞는 공연을 중복 없이 모두 반환합니다.
        const xml = `<dbs>${Array.from(merged.values()).join('')}</dbs>`;

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

      // 기존 캐시를 우회하여 새 전체 데이터를 다시 받게 합니다.
      html = html.replaceAll('movoka-performances-cache:', 'movoka-performances-cache-v6:');
      html = html.replaceAll('movoka-performances-cache-v2:', 'movoka-performances-cache-v6:');
      html = html.replaceAll('movoka-performances-cache-v3:', 'movoka-performances-cache-v6:');
      html = html.replaceAll('movoka-performances-cache-v4:', 'movoka-performances-cache-v6:');
      html = html.replaceAll('movoka-performances-cache-v5:', 'movoka-performances-cache-v6:');
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
