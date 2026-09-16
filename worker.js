// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 브라우저에서 사용할 수 있도록 중계합니다.

const KOPIS_PAGE_ROWS = 100;
const DETAIL_CONCURRENCY = 5;
const DETAIL_CACHE_TTL = 86400;
const LIST_CACHE_TTL = 900;
const TICKET_BATCH_SIZE = 20;

function getYmd(date) {
  // 날짜를 KOPIS가 요구하는 YYYYMMDD 형식으로 변환합니다.
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function proxyKopis(api) {
  // KOPIS 공식 canonical host를 직접 호출해 리다이렉트 문제를 피합니다.
  const response = await fetch(api.toString(), { redirect: 'follow' });
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

function extractDb(xml) {
  // KOPIS XML에서 공연 단위인 db 블록을 추출합니다.
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}

async function getAllPerformances(baseApi) {
  // KOPIS의 페이지당 최대 100개 제한을 넘어서 실제 마지막 페이지까지 전부 가져옵니다.
  const all = [];
  const seen = new Set();
  let page = 1;

  while (true) {
    const api = new URL(baseApi.toString());
    api.searchParams.set('cpage', String(page));
    api.searchParams.set('rows', String(KOPIS_PAGE_ROWS));

    const xml = await proxyKopis(api);
    const matches = extractDb(xml);

    for (const db of matches) {
      // 공연 ID를 기준으로 중복 공연을 제거합니다.
      const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(db);
      }
    }

    // 100개 미만이면 실제 마지막 페이지입니다.
    if (matches.length < KOPIS_PAGE_ROWS) break;
    page++;

    // 비정상 응답으로 무한 요청이 발생하지 않도록 안전 한도를 둡니다.
    if (page > 100) throw new Error('KOPIS pagination limit exceeded');
  }

  return all;
}

function cacheRequest(url) {
  // Cloudflare Cache API에 사용할 내부 캐시 키를 만듭니다.
  return new Request(`https://movoka-cache.invalid/${encodeURIComponent(url)}`);
}

async function getCachedText(url) {
  // 캐시된 KOPIS 응답이 있으면 외부 API 호출을 생략합니다.
  const cached = await caches.default.match(cacheRequest(url));
  return cached ? cached.text() : null;
}

async function putCachedText(url, text, ttl) {
  // KOPIS 응답을 지정된 시간 동안 캐시합니다.
  const response = new Response(text, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`
    }
  });
  await caches.default.put(cacheRequest(url), response);
}

async function hasTicketVendor(id, key) {
  // 공연 상세정보의 relateurl에 실제 예매처 URL이 있는지 확인합니다.
  const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
  api.searchParams.set('service', key);
  const apiUrl = api.toString();

  const cachedXml = await getCachedText(apiUrl);
  const xml = cachedXml || await proxyKopis(api);
  if (!cachedXml) await putCachedText(apiUrl, xml, DETAIL_CACHE_TTL);

  const urls = xml.match(/<relateurl>([\s\S]*?)<\/relateurl>/g) || [];
  return urls.some(item => {
    // 태그를 제거한 URL이 http/https 형식인지 확인합니다.
    const value = item.replace(/^<relateurl>/, '').replace(/<\/relateurl>$/, '').trim();
    return /^https?:\/\//i.test(value);
  });
}

async function getTicketStatuses(ids, key) {
  // 한 번에 최대 20개 공연만 상세 조회합니다.
  const uniqueIds = [...new Set(ids)].filter(id => /^PF\d+$/.test(id)).slice(0, TICKET_BATCH_SIZE);
  const statuses = {};
  let next = 0;

  async function worker() {
    // 상세 API를 동시에 5개씩만 호출합니다.
    while (true) {
      const index = next++;
      if (index >= uniqueIds.length) return;
      const id = uniqueIds[index];
      try {
        statuses[id] = await hasTicketVendor(id, key);
      } catch (_) {
        // 확인에 실패한 공연은 예매 가능으로 처리하지 않습니다.
        statuses[id] = false;
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(DETAIL_CONCURRENCY, uniqueIds.length)}, worker));
  return statuses;
}

export default {
  async fetch(request, env) {
    // 요청 URL과 KOPIS 인증키를 준비합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/debug-kopis') {
      // 배포된 Worker가 KOPIS에 실제로 접근할 수 있는지 확인하는 안전한 진단 API입니다.
      // 인증키 자체는 절대로 응답에 포함하지 않습니다.
      if (!key) return Response.json({ok:false, error:'KOPIS_API_KEY is not configured'}, {status:500});
      try {
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 30);
        const api = new URL('https://kopis.or.kr/openApi/restful/pblprfr');
        api.searchParams.set('service', key);
        api.searchParams.set('stdate', getYmd(now));
        api.searchParams.set('eddate', getYmd(end));
        api.searchParams.set('cpage', '1');
        api.searchParams.set('rows', '1');
        api.searchParams.set('prfstate', '01');
        const xml = await proxyKopis(api);
        return Response.json({
          ok: true,
          host: 'kopis.or.kr',
          responseLength: xml.length,
          dbCount: extractDb(xml).length,
          preview: xml.slice(0, 300)
        });
      } catch (error) {
        // 외부 API 오류 내용을 노출하되 인증키나 전체 요청 URL은 노출하지 않습니다.
        return Response.json({
          ok: false,
          host: 'kopis.or.kr',
          error: String(error?.message || error).slice(0, 200)
        }, {status:502});
      }
    }

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});

      const listCacheKey = `v6:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
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

        // 검색 조건이 있을 때만 KOPIS에 해당 조건을 전달합니다.
        const genre = url.searchParams.get('shcate') || '';
        const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || url.searchParams.get('shigucodesub') || '';
        const keyword = url.searchParams.get('shprfnm') || '';
        if (genre) baseApi.searchParams.set('shcate', genre);
        if (area) baseApi.searchParams.set('signgucode', area);
        if (keyword) baseApi.searchParams.set('shprfnm', keyword);

        // 공연예정과 공연중을 모두 수집합니다.
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

        const xml = `<dbs>${Array.from(merged.values()).join('')}</dbs>`;
        const response = new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`
          }
        });
        await caches.default.put(cacheRequest(listCacheKey), response.clone());
        return response;
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/api/ticket-status') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});

      // 브라우저가 20개 단위로 예매처 상태를 확인합니다.
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > TICKET_BATCH_SIZE) {
        return Response.json({error:`ids must contain 1-${TICKET_BATCH_SIZE} performance IDs`}, {status:400});
      }

      try {
        const statuses = await getTicketStatuses(ids, key);
        return Response.json({statuses}, {headers: {'Cache-Control': 'public, max-age=900'}});
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

      // API 캐시 버전을 올려 이전의 빈 결과 캐시를 사용하지 않게 합니다.
      html = html.replaceAll('movoka-performances-cache:', 'movoka-performances-cache-v12:');
      for (let i = 2; i <= 11; i++) html = html.replaceAll(`movoka-performances-cache-v${i}:`, 'movoka-performances-cache-v12:');
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');

      // 전체 공연을 가져온 뒤 브라우저에서 20개씩 예매처를 확인합니다.
      const ticketLoader = `
async function loadWithTicketFilter(){
  grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>';
  $('#go').disabled=true;
  const p=new URLSearchParams({rows:'100',ticketable:'1'});
  if(active)p.set('shcate',active);
  if($('#area').value)p.set('shigucodesub',$('#area').value);
  if($('#q').value.trim())p.set('shprfnm',$('#q').value.trim());
  const rawKey='movoka-performances-raw-cache-v12:'+p.toString();
  const bookableKey='movoka-performances-bookable-cache-v2:'+p.toString();
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
    const bookableXml='<dbs>'+bookable.map(x=>'<db><mt20id>'+esc(x.mt20id)+'</mt20id><prfnm>'+esc(x.prfnm)+'</prfnm><prfpdfrom>'+esc(x.prfpdfrom)+'</prfpdto>'+esc(x.prfpdto)+'</prfpdto><fcltynm>'+esc(x.fcltynm)+'</fcltynm><poster>'+esc(x.poster)+'</poster><genrenm>'+esc(x.genrenm)+'</genrenm><prfcast>'+esc(x.prfcast)+'</prfcast><prfurl>'+esc(x.prfurl)+'</prfurl></db>').join('')+'</dbs>';
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
