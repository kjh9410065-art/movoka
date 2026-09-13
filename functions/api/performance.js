export async function onRequestGet(context) {
  // 공연 상세 API는 mt20id별로 공식 KOPIS 데이터만 조회합니다.
  const key = context.env.KOPIS_API_KEY;
  const id = new URL(context.request.url).searchParams.get('mt20id');
  if (!key) return new Response('KOPIS_API_KEY is not configured', { status: 500 });
  if (!id || !/^PF\d{6,}$/.test(id)) return new Response('Invalid mt20id', { status: 400 });

  const api = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
  api.searchParams.set('service', key);

  const response = await fetch(api.toString());
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
