// MOVOKA Cloudflare Worker
// KOPIS API 요청은 서버에서 처리하고, 기본 공연 목록은 하루 한 번 캐시로 갱신합니다.

const SNAPSHOT_PREFIX = 'https://movoka-cache.local/api/performances/snapshot/';
const SNAPSHOT_TTL_DAYS = 7;

function snapshotKey(date) {
  return `${SNAPSHOT_PREFIX}${date}`;
}

function dateStamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

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

      // 검색/장르/지역 필터가 없는 기본 목록은 가장 최근의 일일 스냅샷을 사용합니다.
      const isDefaultList = !genre && !area && !keyword && page === 1 && ticketable && rows <= 30 && !url.searchParams.has('stdate') && !url.searchParams.has('eddate');
      if (isDefaultList) {
        const latest = await findLatestSnapshot();
        if (latest) return latest;
      }

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

      return filterTicketable(api, key, false);
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
      // 카드의 예매 버튼 문구를 '예매 사이트'로 통일합니다.
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');
      html = html.replace("new URLSearchParams({rows:'100'})", "new URLSearchParams({rows:'30',ticketable:'1'})");
      html = html.replace(
        '공연정보는 KOPIS 공식 Open API를 통해 조회합니다. 데이터 갱신 시점에 따라 실제 공연·예매 정보와 차이가 있을 수 있습니다.',
        'MOVOKA는 공연 정보를 제공하는 서비스이며, 예매는 각 공식 예매처에서 진행됩니다.<br>공연정보는 KOPIS 공식 Open API를 통해 조회합니다. 데이터 갱신 시점에 따라 실제 공연·예매 정보와 차이가 있을 수 있습니다.'
      );
      return new Response(html, { status: asset.status, headers: asset.headers });
    }

    return env.ASSETS.fetch(request);
  },

  // Cloudflare Cron: 매일 KOPIS에서 기본 공연 목록을 받아 새 스냅샷을 만듭니다.
  async scheduled(controller, env, ctx) {
    if (!env.KOPIS_API_KEY) return;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const end = new Date(now);
    end.setDate(end.getDate() + 30);

    const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
    api.searchParams.set('service', env.KOPIS_API_KEY);
    api.searchParams.set('stdate', ymd(now));
    api.searchParams.set('eddate', ymd(end));
    api.searchParams.set('cpage', '1');
    api.searchParams.set('rows', '30');
    api.searchParams.set('prfstate', '02');

    // 기본 목록과 공식 예매 URL을 확인한 뒤 오늘 날짜의 스냅샷을 저장합니다.
    ctx.waitUntil(refreshSnapshot(api, env.KOPIS_API_KEY, now));
  }
};

async function findLatestSnapshot() {
  // 오늘부터 최대 7일 전까지 확인해 Cron 지연이 있어도 최신 데이터를 사용할 수 있게 합니다.
  for (let age = 0; age <= SNAPSHOT_TTL_DAYS; age++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - age);
    const cached = await caches.default.match(snapshotKey(dateStamp(date)));
    if (cached) return cached;
  }
  return null;
}

async function refreshSnapshot(api, key, now) {
  const response = await filterTicketable(api, key, false);
  if (!response.ok) return;

  const todayKey = snapshotKey(dateStamp(now));
  const snapshot = new Response(await response.clone().text(), {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // 각 일자 스냅샷은 최대 7일까지만 유효합니다.
      'Cache-Control': `public, max-age=${SNAPSHOT_TTL_DAYS * 86400}`
    }
  });
  await caches.default.put(todayKey, snapshot);

  // 7일보다 오래된 일자 스냅샷은 명시적으로 삭제합니다.
  const expired = new Date(now);
  expired.setUTCDate(expired.getUTCDate() - (SNAPSHOT_TTL_DAYS + 1));
  await caches.default.delete(snapshotKey(dateStamp(expired)));
}

async function filterTicketable(api, key, cacheSnapshot = false) {
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
