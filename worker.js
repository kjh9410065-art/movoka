// MOVOKA Cloudflare Worker
// KOPIS 공연 데이터를 서버에서 받아 프론트에 전달합니다.
// 페이지네이션은 아직 적용하지 않고, 가져온 목록을 브라우저에 저장합니다.

const FETCH_ROWS = 100;

function getYmd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function fetchKopis(api) {
  const response = await fetch(api.toString());
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

async function proxyKopis(api) {
  try {
    const body = await fetchKopis(api);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch (_) {
    return Response.json({ error: 'KOPIS request failed' }, { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 30);

      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service', key);
      api.searchParams.set('stdate', url.searchParams.get('stdate') || getYmd(now));
      api.searchParams.set('eddate', url.searchParams.get('eddate') || getYmd(end));
      api.searchParams.set('cpage', '1');
      api.searchParams.set('rows', String(FETCH_ROWS));
      api.searchParams.set('prfstate', '02');

      // 선택한 카테고리/지역/검색어가 있을 때만 필터를 적용합니다.
      const genre = url.searchParams.get('shcate') || '';
      const area = url.searchParams.get('signgucode') || '';
      const keyword = url.searchParams.get('shprfnm') || '';
      if (genre) api.searchParams.set('shcate', genre);
      if (area) api.searchParams.set('signgucode', area);
      if (keyword) api.searchParams.set('shprfnm', keyword);

      // 전체 탭은 모든 카테고리를 하나의 KOPIS 목록으로 가져옵니다.
      return proxyKopis(api);
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

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();

      // 예매 버튼 문구를 통일합니다.
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');

      // 공연 목록 API 응답을 브라우저 localStorage에 저장합니다.
      // 현재 단계에서는 기존 화면 동작은 건드리지 않고 '가져온 데이터 저장'만 합니다.
      const storageScript = `
<script>
(function(){
  const originalFetch = window.fetch;
  window.fetch = async function(input, init){
    const response = await originalFetch.call(this, input, init);
    try {
      const requestUrl = typeof input === 'string' ? input : (input && input.url) || '';
      if (requestUrl.includes('/api/performances')) {
        const body = await response.clone().text();
        localStorage.setItem('movoka-performances-cache', JSON.stringify({
          url: requestUrl,
          data: body,
          savedAt: Date.now()
        }));
      }
    } catch (_) {}
    return response;
  };
})();
</script>`;
      html = html.replace('</body>', storageScript + '</body>');

      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(html, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled() {}
};
