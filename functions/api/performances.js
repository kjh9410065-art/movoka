export async function onRequestGet(context) {
  // KOPIS 서비스 키는 Cloudflare 환경변수에만 보관하고 브라우저에는 노출하지 않습니다.
  const key = context.env.KOPIS_API_KEY;
  if (!key) return new Response('KOPIS_API_KEY is not configured', { status: 500 });

  const url = new URL(context.request.url);
  const today = new Date();
  const start = url.searchParams.get('stdate') || today.toISOString().slice(0, 10).replaceAll('-', '');
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 30);
  const end = url.searchParams.get('eddate') || endDate.toISOString().slice(0, 10).replaceAll('-', '');
  const page = url.searchParams.get('cpage') || '1';
  const rows = url.searchParams.get('rows') || '100';
  const genre = url.searchParams.get('shcate') || '';
  const area = url.searchParams.get('signgucode') || '';

  // 공식 KOPIS Open API의 공연목록 조회 서비스만 호출합니다.
  const api = new URL('http://www.kopis.or.kr/openApi/restful/pblprfr');
  api.searchParams.set('service', key);
  api.searchParams.set('stdate', start);
  api.searchParams.set('eddate', end);
  api.searchParams.set('cpage', page);
  api.searchParams.set('rows', rows);
  if (genre) api.searchParams.set('shcate', genre);
  if (area) api.searchParams.set('signgucode', area);

  const response = await fetch(api.toString(), { headers: { 'User-Agent': 'MOVOKA/1.0' } });
  const body = await response.text();

  return new Response(body, {
    status: response.status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
