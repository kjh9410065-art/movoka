// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 브라우저에서 사용할 수 있도록 중계합니다.

const FETCH_ROWS = 100;

function getYmd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function proxyKopis(api) {
  const response = await fetch(api.toString());
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

async function getAllPerformances(baseApi) {
  const all = [];
  let page = 1;

  // 공연 수에 인위적인 상한을 두지 않고 KOPIS의 마지막 페이지까지 모두 가져옵니다.
  while (true) {
    const api = new URL(baseApi.toString());
    api.searchParams.set('cpage', String(page));
    api.searchParams.set('rows', String(FETCH_ROWS));

    const xml = await proxyKopis(api);
    const matches = xml.match(/<db>[\s\S]*?<\/db>/g) || [];
    all.push(...matches);

    // 현재 페이지가 100개보다 적으면 KOPIS의 마지막 페이지입니다.
    if (matches.length < FETCH_ROWS) break;
    page++;
  }

  return `<dbs>${all.join('')}</dbs>`;
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
        api.searchParams.set('prfstate', '02');

        const genre = url.searchParams.get('shcate') || '';
        const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || '';
        const keyword = url.searchParams.get('shprfnm') || '';
        if (genre) api.searchParams.set('shcate', genre);
        if (area) api.searchParams.set('signgucode', area);
        if (keyword) api.searchParams.set('shprfnm', keyword);

        // 조건에 맞는 예매 가능 공연을 페이지 끝까지 모두 가져옵니다.
        const xml = await getAllPerformances(api);
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

      // 예매 버튼 문구만 통일하고, 페이지네이션은 index.html의 실제 데이터에서 처리합니다.
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
