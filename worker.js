// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 브라우저에서 사용할 수 있도록 중계합니다.

const KOPIS_PAGE_ROWS = 100;
const DETAIL_CONCURRENCY = 5;
const DETAIL_CACHE_TTL = 86400;
const LIST_CACHE_TTL = 900;
const TICKET_BATCH_SIZE = 20;

function getYmd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function proxyKopis(api) {
  // KOPIS 공식 canonical host를 직접 호출합니다. www 호스트의 리다이렉트 문제를 피합니다.
  const response = await fetch(api.toString(), { redirect: 'follow' });
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

function extractDb(xml) {
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}

async function getAllPerformances(baseApi) {
  const all = [];
  const seen = new Set();
  let page = 1;

  // KOPIS는 페이지당 최대 100개만 반환하므로 실제 마지막 페이지까지 전부 조회합니다.
  while (true) {
    const api = new URL(baseApi.toString());
    api.searchParams.set('cpage', String(page));
    api.searchParams.set('rows', String(KOPIS_PAGE_ROWS));

    const xml = await proxyKopis(api);
    const matches = extractDb(xml);

    for (const db of matches) {
      const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(db);
      }
    }

    // 100개보다 적으면 해당 상태의 실제 마지막 페이지입니다.
    if (matches.length < KOPIS_PAGE_ROWS) break;
    page++;
  }

  return all;
}

function cacheRequest(url) {
  // Cloudflare Cache API에 저장할 내부 캐시 키를 만듭니다.
  return new Request(`https://movoka-cache.invalid/${encodeURIComponent(url)}`);
}

async function getCachedText(url) {
  // 이미 캐시된 KOPIS 상세 응답이 있으면 외부 API를 다시 호출하지 않습니다.
  const cached = await caches.default.match(cacheRequest(url));
  return cached ? cached.text() : null;
}

async function putCachedText(url, text, ttl) {
  // KOPIS 응답을 일정 시간 보관해 같은 공연의 반복 조회를 줄입니다.
  const response = new Response(text, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`
    }
  });
  await caches.default.put(cacheRequest(url), response);
}

async function hasTicketVendor(id, key) {
  // 공연 상세정보에서 KOPIS에 등록된 예매처 URL(relateurl)을 확인합니다.
  const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
  api.searchParams.set('service', key);
  const apiUrl = api.toString();

  // 같은 공연의 예매처 확인을 매 요청마다 KOPIS에 다시 보내지 않습니다.
  const cachedXml = await getCachedText(apiUrl);
  const xml = cachedXml || await proxyKopis(api);
  if (!cachedXml) await putCachedText(apiUrl, xml, DETAIL_CACHE_TTL);

  const urls = xml.match(/<relateurl>([\s\S]*?)<\/relateurl>/g) || [];

  // 실제 예매처 URL이 등록된 공연만 판매중 후보로 인정합니다.
  return urls.some(item => {
    const value = item.replace(/^<relateurl>/, '').replace(/<\/relateurl>$/, '').trim();
    return /^https?:\/\//i.test(value);
  });
}

async function getTicketStatuses(ids, key) {
  // 한 Worker 요청에서는 최대 20개 공연만 확인해 외부 요청 수를 제한합니다.
  const uniqueIds = [...new Set(ids)].filter(id => /^PF\d+$/.test(id)).slice(0, TICKET_BATCH_SIZE);
  const statuses = {};
  let next = 0;

  // 상세 API를 동시에 5개씩만 조회합니다.
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= uniqueIds.length) return;
      const id = uniqueIds[index];
      try {
        statuses[id] = await hasTicketVendor(id, key);
      } catch (_) {
        // 확인 실패는 예매 가능으로 간주하지 않습니다.
        statuses[id] = false;
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(DETAIL_CONCURRENCY, uniqueIds.length)}, worker));
  return statuses;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});

      // 목록 자체는 예매처 상세조회와 분리해 100개 초과 공연도 끝까지 수집합니다.
      const listCacheKey = `v5:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const cachedList = await caches.default.match(cacheRequest(listCacheKey));
      if (cachedList) return cachedList;

      try {
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 30);

        // KOPIS 공식 canonical host를 사용합니다.
        const baseApi = new URL('https://kopis.or.kr/openApi/restful/pblprfr');
        baseApi.searchParams.set('service', key);
        baseApi.searchParams.set('stdate', url.searchParams.get('stdate') || getYmd(now));
        baseApi.searchParams.set('eddate', url.searchParams.get('eddate') || getYmd(end));

        const genre = url.searchParams.get('shcate') || '';
        const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || url.searchParams.get('shigucodesub') || '';
        const keyword = url.searchParams.get('shprfnm') || '';
        if (genre) baseApi.searchParams.set('shcate', genre);
        if (area) baseApi.searchParams.set('signgucode', area);
        if (keyword) baseApi.searchParams.set('shprfnm', keyword);

        // KOPIS의 공연상태 01=공연예정, 02=공연중인 모든 공연을 수집합니다.
        const merged = new Map();
        for (const state of ['01', '02']) {
          const api = new URL(baseApi.toString());
          api.searchParams.set('prfstate', state);
          const performances = await getAllPerformances(api);
          for (const db of performances) {
            const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
            if (id && !merged.has(id)) merged.set(id, db);
          }
        }

        // 예매처 상세조회는 별도 배치 API에서 처리하므로 목록 요청에서는 전체 공연을 반환합니다.
        const xml = `<dbs>${Array.from(merged.values()).join('')}</dbs>`;
        const response = new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`
          }
        });

        // 검색조건별 전체 결과를 캐시합니다.
        await caches.default.put(cacheRequest(listCacheKey), response.clone());
        return response;
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/api/ticket-status') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});

      // 브라우저가 20개 단위로 예매처 상태를 확인할 수 있게 합니다.
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > TICKET_BATCH_SIZE) {
        return Response.json({error:`ids must contain 1-${TICKET_BATCH_SIZE} performance IDs`}, {status:400});
      }

      try {
        const statuses = await getTicketStatuses(ids, key);
        return Response.json({statuses}, {
          headers: {'Cache-Control': 'public, max-age=900'}
        });
      } catch (_) {
        return Response.json({error:'Ticket status request failed'}, {status:502});
      }
    }

    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});
      const id = url.searchParams.get('mt20id');
      if (!id || !/^PF\d+$/.test(id)) return Response.json({error:'Invalid mt20id'}, {status:400});

      try {
        const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
        api.searchParams.set('service', key);
        const apiUrl = api.toString();
        const cachedXml = await getCachedText(apiUrl);
        const xml = cachedXml || await proxyKopis(api);
        if (!cachedXml) await putCachedText(apiUrl, xml, DETAIL_CACHE_TTL);
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': `public, max-age=${DETAIL_CACHE_TTL}`
          }
        });
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();

      // 새 목록과 예매상태 캐시 버전을 적용합니다.
      html = html.replaceAll('movoka-performances-cache:', 'movoka-performances-cache-v11:');
      for (let i = 2; i <= 10; i++) html = html.replaceAll(`movoka-performances-cache-v${i}:`, 'movoka-performances-cache-v11:');
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');

      // 목록은 전부 가져온 뒤 브라우저가 20개씩 예매처 상태를 확인합니다.
      // 이렇게 해야 100개를 넘는 공연도 단일 Worker 요청 한도를 넘지 않습니다.
      const ticketLoader = `
async function loadWithTicketFilter(){
  grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>';
  $('#go').disabled=true;
  const p=new URLSearchParams({rows:'100',ticketable:'1'});
  if(active)p.set('shcate',active);
  if($('#area').value)p.set('shigucodesub',$('#area').value);
  if($('#q').value.trim())p.set('shprfnm',$('#q').value.trim());
  const rawKey='movoka-performances-raw-cache-v11:'+p.toString();
  const bookableKey='movoka-performances-bookable-cache-v1:'+p.toString();
  let rawXml=null;
  let cachedBookable=null;
  try{
    const savedBookable=localStorage.getItem(bookableKey);
    if(savedBookable){const parsed=JSON.parse(savedBookable);if(Date.now()-Number(parsed.savedAt||0)<CACHE_TTL)cachedBookable=parse(parsed.data);}
  }catch(_){localStorage.removeItem(bookableKey)}
  if(cachedBookable){currentPage=1;renderItems(cachedBookable);$('#go').disabled=false;return}
  try{
    const savedRaw=localStorage.getItem(rawKey);
    if(savedRaw){const parsed=JSON.parse(savedRaw);if(Date.now()-Number(parsed.savedAt||0)<CACHE_TTL)rawXml=parsed.data;}
    if(!rawXml){
      const r=await fetchWithTimeout('/api/performances?'+p.toString());
      if(!r.ok)throw new Error();
      rawXml=await r.text();
      localStorage.setItem(rawKey,JSON.stringify({data:rawXml,savedAt:Date.now()}));
    }
    const all=parse(rawXml);
    const ids=all.map(x=>x.mt20id).filter(Boolean);
    const bookable=[];
    for(let i=0;i<ids.length;i+=20){
      const batch=ids.slice(i,i+20);
      const r=await fetchWithTimeout('/api/ticket-status?ids='+encodeURIComponent(batch.join(',')));
      if(!r.ok)continue;
      const data=await r.json();
      const statuses=data.statuses||{};
      for(const item of all.filter(x=>batch.includes(x.mt20id))){if(statuses[item.mt20id]===true)bookable.push(item)}
      count.textContent='예매 가능한 공연 확인 중... '+Math.min(i+20,ids.length)+' / '+ids.length;
    }
    const bookableXml='<dbs>'+bookable.map(x=>'<db><mt20id>'+esc(x.mt20id)+'</mt20id><prfnm>'+esc(x.prfnm)+'</prfnm><prfpdfrom>'+esc(x.prfpdfrom)+'</prfpdfrom><prfpdto>'+esc(x.prfpdto)+'</prfpdto><fcltynm>'+esc(x.fcltynm)+'</fcltynm><poster>'+esc(x.poster)+'</poster><genrenm>'+esc(x.genrenm)+'</genrenm><prfcast>'+esc(x.prfcast)+'</prfcast><prfurl>'+esc(x.prfurl)+'</prfurl></db>').join('')+'</dbs>';
    localStorage.setItem(bookableKey,JSON.stringify({data:bookableXml,savedAt:Date.now()}));
    currentPage=1;renderItems(bookable);
  }catch(e){count.textContent='';grid.innerHTML='<div class="empty">공연 정보를 불러오지 못했습니다.</div>';$('#movoka-pagination').innerHTML=''}finally{$('#go').disabled=false}
}
`;
      html = html.replace('load();\n</script>', ticketLoader + 'loadWithTicketFilter();\n</script>');

      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(html, {status: asset.status, headers});
    }

    return env.ASSETS.fetch(request);
  },
  async scheduled(){}
};
