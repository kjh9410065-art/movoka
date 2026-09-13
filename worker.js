// MOVOKA Cloudflare Worker
// KOPIS API 요청을 서버에서 처리하고 나머지는 정적 자산으로 전달합니다.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    // 공연 목록 API
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
      // 예매 가능 여부를 상세정보의 공식 예매처 목록으로 확인하므로 한 번에 너무 많은 상세 요청을 만들지 않습니다.
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
      // 현재 공연중인 작품만 조회합니다. 예정작은 다음 단계에서 별도 영역으로 다룹니다.
      api.searchParams.set('prfstate', '02');
      if (genre) api.searchParams.set('shcate', genre);
      if (area) api.searchParams.set('signgucode', area);
      if (keyword) api.searchParams.set('shprfnm', keyword);

      if (!ticketable) return proxyKopis(api);

      // 목록에 포함된 각 공연의 상세정보에서 KOPIS가 제공하는 공식 예매처(relates)를 확인합니다.
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
            // 공식 예매처 URL이 실제로 등록된 공연만 노출합니다.
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

    // 공연 상세 API
    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });
      const id = url.searchParams.get('mt20id');
      if (!id || !/^PF\d+$/.test(id)) return Response.json({ error: 'Invalid mt20id' }, { status: 400 });
      const api = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
      api.searchParams.set('service', key);
      return proxyKopis(api);
    }

    // 화면은 기존 정적 자산을 사용하되, 예매 UX 문구와 예매 가능 필터를 최신 정책으로 맞춥니다.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();
      html = html.replace(/>예매<\/button>/g, '>예매처 바로가기</button>');
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

// KOPIS 응답을 그대로 전달하되 API 키는 서버에서만 사용합니다.
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
