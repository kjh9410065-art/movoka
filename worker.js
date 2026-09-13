// MOVOKA Cloudflare Worker
// KOPIS API 요청을 서버에서 처리하고 나머지는 정적 자산으로 전달합니다.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/performances') {
      const key = env.KOPIS_API_KEY;
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const startDate = url.searchParams.get('stdate') || ymd(now);
      const endDateObj = new Date(now);
      endDateObj.setDate(endDateObj.getDate() + 30);
      const endDate = url.searchParams.get('eddate') || ymd(endDateObj);
      const page = Math.max(1, Number(url.searchParams.get('cpage') || 1));
      const rows = Math.min(100, Math.max(1, Number(url.searchParams.get('rows') || 100)));
      const genre = url.searchParams.get('shcate') || '';
      const area = url.searchParams.get('signgucodesub') || url.searchParams.get('signgucode') || '';
      const keyword = url.searchParams.get('shprfnm') || '';

      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service', key);
      api.searchParams.set('stdate', startDate);
      api.searchParams.set('eddate', endDate);
      api.searchParams.set('cpage', String(page));
      api.searchParams.set('rows', String(rows));
      if (genre) api.searchParams.set('shcate', genre);
      if (area) api.searchParams.set('signgucode', area);
      if (keyword) api.searchParams.set('shprfnm', keyword);

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

    return env.ASSETS.fetch(request);
  }
};
