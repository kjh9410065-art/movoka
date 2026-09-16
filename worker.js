// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 중계하고 초기 화면을 빠르게 표시합니다.

const ROWS = 100; // KOPIS가 허용하는 페이지당 최대 공연 수입니다.
const FIRST_ROWS = 28; // 첫 화면에는 실제 표시량만 받아 초기 응답을 줄입니다.
const LIST_CACHE_TTL = 900; // 전체 목록 캐시 시간은 15분입니다.
const DETAIL_CACHE_TTL = 86400; // 상세 공연 캐시는 24시간입니다.
const PAGE_CONCURRENCY = 8; // 전체 목록을 가져올 때 동시에 조회할 페이지 수입니다.
const TICKET_BATCH_SIZE = 20; // 예매처 확인 요청의 최대 공연 수입니다.
const DETAIL_CONCURRENCY = 5; // 예매처 상세정보를 동시에 조회할 수입니다.

function ymd(date) {
  // 날짜를 KOPIS의 YYYYMMDD 형식으로 변환합니다.
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function cacheKey(url) {
  // Cloudflare Cache API에서 사용할 내부 URL을 만듭니다.
  return new Request(`https://movoka-cache.invalid/${encodeURIComponent(url)}`);
}

async function cachedText(url) {
  // 캐시된 텍스트 응답을 반환합니다.
  const hit = await caches.default.match(cacheKey(url));
  return hit ? hit.text() : null;
}

async function saveText(url, text, ttl, type = 'application/xml; charset=utf-8') {
  // 외부 API 응답을 Cloudflare 캐시에 저장합니다.
  await caches.default.put(cacheKey(url), new Response(text, {
    headers: {'Content-Type': type, 'Cache-Control': `public, max-age=${ttl}`}
  }));
}

async function kopis(api) {
  // KOPIS API를 호출하고 XML 본문을 반환합니다.
  const response = await fetch(api.toString(), {redirect: 'follow'});
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

function dbs(xml) {
  // KOPIS XML에서 공연별 db 블록만 추출합니다.
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}

function idOf(db) {
  // 공연의 고유 ID를 추출합니다.
  return db.match(/<mt20id>[\s\S]*?<\/mt20id>/)?.[1] || '';
}

function baseApi(url, key) {
  // 프론트엔드 조건을 KOPIS 목록 조회 URL로 변환합니다.
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);
  const api = new URL('https://kopis.or.kr/openApi/restful/pblprfr');
  api.searchParams.set('service', key);
  api.searchParams.set('stdate', url.searchParams.get('stdate') || ymd(now));
  api.searchParams.set('eddate', url.searchParams.get('eddate') || ymd(end));
  const genre = url.searchParams.get('shcate') || '';
  const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || url.searchParams.get('shigucodesub') || '';
  const keyword = url.searchParams.get('shprfnm') || '';
  if (genre) api.searchParams.set('shcate', genre);
  if (area) api.searchParams.set('signgucode', area);
  if (keyword) api.searchParams.set('shprfnm', keyword);
  return api;
}

async function firstPage(api, rows = FIRST_ROWS) {
  // 첫 화면은 필요한 공연 수만 한 번에 받아 응답 크기와 대기시간을 줄입니다.
  api = new URL(api.toString());
  api.searchParams.set('cpage', '1');
  api.searchParams.set('rows', String(Math.min(FIRST_ROWS, Math.max(1, Number(rows) || FIRST_ROWS))));
  return kopis(api);
}

async function allPages(api) {
  // 전체 목록을 100개 단위로 끝 페이지까지 수집합니다.
  const all = [];
  const seen = new Set();

  const add = items => {
    // 공연 ID를 기준으로 중복을 제거합니다.
    for (const db of items) {
      const id = idOf(db);
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(db);
      }
    }
  };

  const getPage = async page => {
    // 지정한 페이지를 KOPIS에서 조회합니다.
    const request = new URL(api.toString());
    request.searchParams.set('cpage', String(page));
    request.searchParams.set('rows', String(ROWS));
    return dbs(await kopis(request));
  };

  const first = await getPage(1);
  add(first);
  if (first.length < ROWS) return all;

  // 마지막 페이지가 나올 때까지 여러 페이지를 병렬 조회합니다.
  for (let start = 2; start <= 100; start += PAGE_CONCURRENCY) {
    const pages = Array.from({length: Math.min(PAGE_CONCURRENCY, 101 - start)}, (_, i) => start + i);
    const results = await Promise.all(pages.map(getPage));
    let last = false;
    for (const items of results) {
      add(items);
      if (items.length < ROWS) last = true;
    }
    if (last) break;
  }
  return all;
}

async function ticketStatus(ids, key) {
  // 공연 상세정보의 예매처 URL 존재 여부를 확인합니다.
  const unique = [...new Set(ids)].filter(id => /^PF\d+$/.test(id)).slice(0, TICKET_BATCH_SIZE);
  const result = {};
  let cursor = 0;

  const worker = async () => {
    // 상세 API를 최대 5개씩 동시에 호출합니다.
    while (cursor < unique.length) {
      const id = unique[cursor++];
      try {
        const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
        api.searchParams.set('service', key);
        const url = api.toString();
        const xml = (await cachedText(url)) || await kopis(api);
        await saveText(url, xml, DETAIL_CACHE_TTL);
        const urls = xml.match(/<relateurl>[\s\S]*?<\/relateurl>/g) || [];
        result[id] = urls.some(v => /^https?:\/\//i.test(v.replace(/<\/?relateurl>/g, '').trim()));
      } catch (_) {
        result[id] = false;
      }
    }
  };

  await Promise.all(Array.from({length: Math.min(DETAIL_CONCURRENCY, unique.length)}, worker));
  return result;
}

export default {
  async fetch(request, env) {
    // 현재 요청과 KOPIS 인증키를 준비합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;
    if (!key) return Response.json({error: 'KOPIS_API_KEY is not configured'}, {status: 500});

    if (url.pathname === '/api/debug-kopis') {
      // KOPIS 연결 상태를 한 건만 조회해 진단합니다.
      try {
        const api = baseApi(url, key);
        api.searchParams.set('cpage', '1');
        api.searchParams.set('rows', '1');
        const xml = await kopis(api);
        return Response.json({ok: true, host: 'kopis.or.kr', dbCount: dbs(xml).length, responseLength: xml.length});
      } catch (error) {
        return Response.json({ok: false, error: String(error?.message || error).slice(0, 200)}, {status: 502});
      }
    }

    if (url.pathname === '/api/performances/first') {
      // 첫 화면은 28개만 요청해 KOPIS 응답을 최대한 작게 만듭니다.
      const keyUrl = `first-v3:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const hit = await caches.default.match(cacheKey(keyUrl));
      if (hit) return hit;
      try {
        const xml = await firstPage(baseApi(url, key), FIRST_ROWS);
        const response = new Response(xml, {headers: {'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300'}});
        await caches.default.put(cacheKey(keyUrl), response.clone());
        return response;
      } catch (_) {
        return Response.json({error: 'KOPIS first page request failed'}, {status: 502});
      }
    }

    if (url.pathname === '/api/performances') {
      // 전체 공연을 페이지 끝까지 수집해 캐시합니다.
      const keyUrl = `full-v11:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const hit = await caches.default.match(cacheKey(keyUrl));
      if (hit) return hit;
      try {
        const items = await allPages(baseApi(url, key));
        const xml = `<dbs>${items.join('')}</dbs>`;
        const response = new Response(xml, {headers: {'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`}});
        await caches.default.put(cacheKey(keyUrl), response.clone());
        return response;
      } catch (_) {
        return Response.json({error: 'KOPIS request failed'}, {status: 502});
      }
    }

    if (url.pathname === '/api/ticket-status') {
      // 필요한 공연만 상세 예매처 여부를 확인합니다.
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > TICKET_BATCH_SIZE) return Response.json({error: `ids must contain 1-${TICKET_BATCH_SIZE} performance IDs`}, {status: 400});
      try {
        return Response.json({statuses: await ticketStatus(ids, key)}, {headers: {'Cache-Control': 'public, max-age=900'}});
      } catch (_) {
        return Response.json({error: 'Ticket status request failed'}, {status: 502});
      }
    }

    if (url.pathname === '/api/performance') {
      // 카드에서 요청한 공연 상세정보만 조회하고 24시간 캐시합니다.
      const id = url.searchParams.get('mt20id');
      if (!id || !/^PF\d+$/.test(id)) return Response.json({error: 'Invalid mt20id'}, {status: 400});
      try {
        const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
        api.searchParams.set('service', key);
        const apiUrl = api.toString();
        const xml = (await cachedText(apiUrl)) || await kopis(api);
        await saveText(apiUrl, xml, DETAIL_CACHE_TTL);
        return new Response(xml, {headers: {'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${DETAIL_CACHE_TTL}`}});
      } catch (_) {
        return Response.json({error: 'KOPIS request failed'}, {status: 502});
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // 첫 화면을 먼저 표시하고 전체 목록은 백그라운드에서 가져오도록 로더를 주입합니다.
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();
      const loader = `
async function loadWithTicketFilter(){
  $('#go').disabled=true;
  grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>';
  const p=new URLSearchParams({rows:'28'});
  if(active)p.set('shcate',active);
  if($('#area').value)p.set('shigucodesub',$('#area').value);
  if($('#q').value.trim())p.set('shprfnm',$('#q').value.trim());
  const firstKey='movoka-first-list-v3:'+p.toString();
  const fullKey='movoka-full-list-v2:'+p.toString();
  const apply=xml=>{currentPage=1;renderItems(parse(xml));};

  try{
    const saved=localStorage.getItem(fullKey);
    if(saved){
      const parsed=JSON.parse(saved);
      if(Date.now()-Number(parsed.savedAt||0)<CACHE_TTL){apply(parsed.data);$('#go').disabled=false;return;}
    }
  }catch(_){localStorage.removeItem(fullKey);}

  // 이전 첫 페이지가 있으면 네트워크보다 먼저 즉시 표시합니다.
  try{
    const saved=localStorage.getItem(firstKey);
    if(saved){
      const parsed=JSON.parse(saved);
      if(Date.now()-Number(parsed.savedAt||0)<CACHE_TTL)apply(parsed.data);
    }
  }catch(_){localStorage.removeItem(firstKey);}

  // 첫 화면은 28개만 받아 8초 이상 초기 화면이 기다리지 않게 합니다.
  try{
    const response=await fetchWithTimeout('/api/performances/first?'+p.toString(),8000);
    if(response.ok){
      const xml=await response.text();
      localStorage.setItem(firstKey,JSON.stringify({data:xml,savedAt:Date.now()}));
      apply(xml);
    }
  }catch(_){
    // 첫 요청이 느리거나 실패해도 전체 목록 요청은 계속 백그라운드에서 진행합니다.
  }

  // 전체 목록은 화면을 막지 않고 백그라운드에서 완성합니다.
  fetch('/api/performances?'+p.toString())
    .then(r=>{if(!r.ok)throw new Error('full list failed');return r.text();})
    .then(xml=>{
      localStorage.setItem(fullKey,JSON.stringify({data:xml,savedAt:Date.now()}));
      apply(xml);
    })
    .catch(()=>{})
    .finally(()=>{$('#go').disabled=false;});
}

// 페이지가 로드되면 공연 목록 조회를 자동으로 시작합니다.
loadWithTicketFilter();
`;
      html = html.replace('</script>', loader + '</script>');
      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(html, {status: asset.status, headers});
    }

    // 나머지 요청은 정적 자산으로 전달합니다.
    return env.ASSETS.fetch(request);
  },

  async scheduled() {}
};