export async function onRequestGet(context) {
  // KOPIS 서비스 키는 Cloudflare 환경변수에만 보관합니다.
  const key = context.env.KOPIS_API_KEY;
  if (!key) return new Response('KOPIS_API_KEY is not configured', { status: 500 });

  const req = new URL(context.request.url);
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

  // 기본값은 오늘부터 31일입니다. KOPIS 공식 목록 API의 최대 기간도 31일입니다.
  const startDate = req.searchParams.get('stdate') || ymd(now);
  const end = new Date(now);
  end.setDate(end.getDate() + 30);
  const endDate = req.searchParams.get('eddate') || ymd(end);

  const page = Math.max(1, Number(req.searchParams.get('cpage') || 1));
  const rows = Math.min(100, Math.max(1, Number(req.searchParams.get('rows') || 100)));
  const genre = req.searchParams.get('shcate') || '';
  const area = req.searchParams.get('signgucodesub') || req.searchParams.get('signgucode') || '';
  const keyword = req.searchParams.get('shprfnm') || '';

  const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
  api.searchParams.set('service', key);
  api.searchParams.set('stdate', startDate);
  api.searchParams.set('eddate', endDate);
  api.searchParams.set('cpage', String(page));
  api.searchParams.set('rows', String(rows));
  if (genre) api.searchParams.set('shcate', genre);
  if (area) api.searchParams.set('signgucode', area);
  if (keyword) api.searchParams.set('shprfnm', keyword);

  const response = await fetch(api.toString());
  const body = await response.text();

  return new Response(body, {
    status: response.status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // KOPIS 데이터는 공식 갱신 주기에 맞춰 매번 최신값을 요청합니다.
      'Cache-Control': 'no-store'
    }
  });
}
