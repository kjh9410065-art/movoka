// MOVOKA Cloudflare Worker
// KOPIS API 요청을 서버에서 처리하고 나머지는 정적 자산으로 전달합니다.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const startDate = url.searchParams.get('stdate') || ymd(now);
      const endDateObj = new Date(now);
      endDateObj.setDate(endDateObj.getDate() + 30);
      const endDate = url.searchParams.get('eddate') || ymd(endDateObj);
      const page = Math.max(1, Number(url.searchParams.get('cpage') || 1));
      const ticketable = url.searchParams.get('ticketable') === '1';
      const requestedRows = Math.min(100, Math.max(1, Number(url.searchParams.get('rows') || 100)));
      const rows = ticketable ? Math.min(30, requestedRows) : requestedRows;
      const genre = url.searchParams.get('shcate') || '';
      const area = url.searchParams.get('signgucodesub') || url.searchParams.get('signgucode') || '';
      const keyword = url.searchParams.get('shprfnm') || '';

      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service', key);
      api.searchParams.set('stdate', startDate);
      api.searchParams.set('eddate', endDate);
      api.searchParams.set('cpage', String(page));
      api.searchParams.set('rows', String(rows));
      api.searchParams.set('prfstate', '02');
      if (genre) api.searchParams.set('shcate', genre);
      if (area) api.searchParams.set('signgucode', area);
      if (keyword) api.searchParams.set('shprfnm', keyword);

      if (!ticketable) return proxyKopis(api);

      try {
        const response = await fetch(api.toString());
        const body = await response.text();
        if (!response.ok) return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });

        const blocks = body.match(/<db>[\s\S]*?<\/db>/g) || [];
        const filtered = await Promise.all(blocks.map(async block => {
          const id = block.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1]?.trim();
          if (!id || !/^PF\d+$/.test(id)) return null;
          const detailUrl = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
          detailUrl.searchParams.set('service', key);
          try {
            const detailResponse = await fetch(detailUrl.toString());
            const detail = await detailResponse.text();
            const hasTicketUrl = /<relates>[\s\S]*?<relate>[\s\S]*?<relateurl>https?:\/\//i.test(detail);
            return hasTicketUrl ? block : null;
          } catch {
            return null;
          }
        }));

        return new Response(`<dbs>${filtered.filter(Boolean).join('')}</dbs>`, {
          status: 200,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
      } catch {
        return Response.json({ error: 'KOPIS ticket availability check failed' }, { status: 502 });
      }
    }

    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });
      const id = url.searchParams.get('mt20id');
      if (!id || !/^PF\d+$/.test(id)) return Response.json({ error: 'Invalid mt20id' }, { status: 400 });
      const api = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
      api.searchParams.set('service', key);
      return proxyKopis(api);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();
      // 기존 버튼 문구가 정확히 '예매'인 경우에만 보정합니다.
      // 새 '예매처 비교' 문구는 그대로 유지해 UI 패치가 런타임에서 덮어써지지 않게 합니다.
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)예매(<\/button>)/gi, '$1예매처 비교$2');
      html = html.replace(/>예매<\/button>/g, '>예매처 비교</button>');
      html = html.replace("new URLSearchParams({rows:'100'})", "new URLSearchParams({rows:'30',ticketable:'1'})");
      html = html.replace(
        '공연정보는 KOPIS 공식 Open API를 통해 조회합니다. 데이터 갱신 시점에 따라 실제 공연·예매 정보와 차이가 있을 수 있습니다.',
        'MOVOKA는 공연 정보를 제공하는 서비스이며, 예매는 각 공식 예매처에서 진행됩니다.<br>공연정보는 KOPIS 공식 Open API를 통해 조회합니다. 데이터 갱신 시점에 따라 실제 공연·예매 정보와 차이가 있을 수 있습니다.'
      );
      return new Response(html, { status: asset.status, headers: asset.headers });
    }

    return env.ASSETS.fetch(request);
  }
};

async function proxyKopis(api) {
  try {
    const response = await fetch(api.toString());
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return Response.json({ error: 'KOPIS request failed' }, { status: 502 });
  }
}
