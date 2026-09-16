// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 브라우저에서 사용할 수 있도록 중계합니다.

const KOPIS_PAGE_ROWS = 100;
const DETAIL_CONCURRENCY = 5;
const DETAIL_CACHE_TTL = 86400;
const LIST_CACHE_TTL = 900;
const TICKET_BATCH_SIZE = 20;
const LIST_PAGE_CONCURRENCY = 8;

function getYmd(date) {
  // 날짜를 KOPIS가 요구하는 YYYYMMDD 형식으로 변환합니다.
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function proxyKopis(api) {
  // KOPIS 공식 API를 호출합니다.
  const response = await fetch(api.toString(), { redirect: 'follow' });
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

function extractDb(xml) {
  // KOPIS XML에서 공연 단위인 db 블록을 추출합니다.
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}

async function getAllPerformances(baseApi) {
  // 첫 페이지를 확인한 뒤 나머지 페이지를 8개씩 병렬 수집합니다.
  const all = [];
  const seen = new Set();

  const addResults = matches => {
    // 공연 ID를 기준으로 중복 공연을 제거합니다.
    for (const db of matches) {
      const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(db);
      }
    }
  };

  const fetchPage = async page => {
    // 지정한 페이지 하나를 KOPIS에서 가져옵니다.
    const api = new URL(baseApi.toString());
    api.searchParams.set('cpage', String(page));
    api.searchParams.set('rows', String(KOPIS_PAGE_ROWS));
    const xml = await proxyKopis(api);
    return extractDb(xml);
  };

  const first = await fetchPage(1);
  addResults(first);
  if (first.length < KOPIS_PAGE_ROWS) return all;

  // 마지막 페이지를 찾을 때까지 여러 페이지를 병렬 조회합니다.
  for (let start = 2; start <= 100; start += LIST_PAGE_CONCURRENCY) {
    const pages = Array.from(
      { length: Math.min(LIST_PAGE_CONCURRENCY, 101 - start) },
      (_, index) => start + index
    );
    const results = await Promise.all(pages.map(page => fetchPage(page)));
    let reachedLastPage = false;

    results.forEach(matches => {
      addResults(matches);
      if (matches.length < KOPIS_PAGE_ROWS) reachedLastPage = true;
    });

    if (reachedLastPage) break;
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
  // KOPIS 상세 응답을 지정된 시간 동안 캐시합니다.
  const response = new Response(text, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`
    }
  });
  await caches.default.put(cacheRequest(url), response);
}

async function hasTicketVendor(id, key) {
  // 공연 상세정보의 relateurl에 예매처 URL이 있는지 확인합니다.
  const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
  api.searchParams.set('service', key);
  const apiUrl = api.toString();
  const cachedXml = await getCachedText(apiUrl);
  const xml = cachedXml || await proxyKopis(api);
  if (!cachedXml) await putCachedText(apiUrl, xml, DETAIL_CACHE_TTL);
  const urls = xml.match(/<relateurl>([\s\S]*?)<\/relateurl>/g) || [];
  return urls.some(item => {
    // 태그를 제거한 URL이 실제 HTTP/HTTPS URL인지 확인합니다.
    const value = item.replace(/^<relateurl>/, '').replace(/<\/relateurl>$/, '').trim();
    return /^https?:\/\//i.test(value);
  });
}

async function getTicketStatuses(ids, key) {
  // 상세 예매처 확인 API를 직접 사용할 때만 실행합니다.
  const uniqueIds = [...new Set(ids)].filter(id => /^PF\d+$/.test(id)).slice(0, TICKET_BATCH_SIZE);
  const statuses = {};
  let next = 0;

  async function worker() {
    // 상세 API를 동시에 5개씩 호출합니다.
    while (true) {
      const index = next++;
      if (index >= uniqueIds.length) return;
      const id = uniqueIds[index];
      try { statuses[id] = await hasTicketVendor(id, key); }
      catch (_) { statuses[id] = false; }
    }
  }

  await Promise.all(Array.from({length: Math.min(DETAIL_CONCURRENCY, uniqueIds.length)}, worker));
  return statuses;
}

function buildBaseApi(url, key) {
  // 목록 조회에 공통으로 사용하는 KOPIS 요청을 만듭니다.
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);
  const baseApi = new URL('https://kopis.or.kr/openApi/restful/pblprfr');
  baseApi.searchParams.set('service', key);
  baseApi.searchParams.set('stdate', url.searchParams.get('stdate') || getYmd(now));
  baseApi.searchParams.set('eddate', url.searchParams.get('eddate') || getYmd(end));

  // 검색 조건이 있을 때만 KOPIS에 전달합니다.
  const genre = url.searchParams.get('shcate') || '';
  const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || url.searchParams.get('shigucodesub') || '';
  const keyword = url.searchParams.get('shprfnm') || '';
  if (genre) baseApi.searchParams.set('shcate', genre);
  if (area) baseApi.searchParams.set('signgucode', area);
  if (keyword) baseApi.searchParams.set('shprfnm', keyword);
  return baseApi;
}

async function getFirstPagePerformances(baseApi) {
  // 첫 화면에 즉시 사용할 페이지 1을 가져옵니다.
  const states = await Promise.all(['01', '02'].map(async state => {
    const api = new URL(baseApi.toString());
    api.searchParams.set('prfstate', state);
    api.searchParams.set('cpage', '1');
    api.searchParams.set('rows', String(KOPIS_PAGE_ROWS));
    return extractDb(await proxyKopis(api));
  }));

  // 공연예정과 공연중을 공연 ID 기준으로 합칩니다.
  const merged = new Map();
  for (const items of states) {
    for (const db of items) {
      const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
      if (id && !merged.has(id)) merged.set(id, db);
    }
  }
  return `<dbs>${Array.from(merged.values()).join('')}</dbs>`;
}

export default {
  async fetch(request, env) {
    // 요청 URL과 KOPIS 인증키를 준비합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/debug-kopis') {
      // Worker와 KOPIS 연결 상태를 확인하는 안전한 진단 API입니다.
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
        return Response.json({ok:true, host:'kopis.or.kr', responseLength:xml.length, dbCount:extractDb(xml).length, preview:xml.slice(0,300)});
      } catch (error) {
        return Response.json({ok:false, host:'kopis.or.kr', error:String(error?.message || error).slice(0,200)}, {status:502});
      }
    }

    if (url.pathname === '/api/performances/first') {
      // 첫 화면은 전체 집계를 기다리지 않고 즉시 보여줍니다.
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});
      const cacheKey = `v1-first:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const cached = await caches.default.match(cacheRequest(cacheKey));
      if (cached) return cached;
      try {
        const xml = await getFirstPagePerformances(buildBaseApi(url, key));
        const response = new Response(xml, {
          headers: {'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, max-age=300'}
        });
        await caches.default.put(cacheRequest(cacheKey), response.clone());
        return response;
      } catch (_) {
        return Response.json({error:'KOPIS first page request failed'}, {status:502});
      }
    }

    if (url.pathname === '/api/performances') {
      // 전체 공연을 끝 페이지까지 수집해 최종 집계합니다.
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});
      const listCacheKey = `v10:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const cachedList = await caches.default.match(cacheRequest(listCacheKey));
      if (cachedList) return cachedList;

      try {
        const baseApi = buildBaseApi(url, key);
        const stateResults = await Promise.all(['01', '02'].map(async state => {
          const api = new URL(baseApi.toString());
          api.searchParams.set('prfstate', state);
          return getAllPerformances(api);
        }));

        // 두 상태의 결과를 공연 ID 기준으로 합칩니다.
        const merged = new Map();
        for (const performances of stateResults) {
          for (const db of performances) {
            const id = db.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1] || '';
            if (id && !merged.has(id)) merged.set(id, db);
          }
        }

        const xml = `<dbs>${Array.from(merged.values()).join('')}</dbs>`;
        const response = new Response(xml, {
          headers: {'Content-Type':'application/xml; charset=utf-8','Cache-Control':`public, max-age=${LIST_CACHE_TTL}`}
        });
        await caches.default.put(cacheRequest(listCacheKey), response.clone());
        return response;
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/api/ticket-status') {
      // 필요할 때만 상세 예매처 상태를 확인합니다.
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > TICKET_BATCH_SIZE) return Response.json({error:`ids must contain 1-${TICKET_BATCH_SIZE} performance IDs`}, {status:400});
      try {
        const statuses = await getTicketStatuses(ids, key);
        return Response.json({statuses}, {headers:{'Cache-Control':'public, max-age=900'}});
      } catch (_) {
        return Response.json({error:'Ticket status request failed'}, {status:502});
      }
    }

    if (url.pathname === '/api/performance') {
      // 공연 상세정보는 카드에서 요청할 때만 가져옵니다.
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
        return new Response(xml, {headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':`public, max-age=${DETAIL_CACHE_TTL}`} });
      } catch (_) {
        return Response.json({error:'KOPIS request failed'}, {status:502});
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // 첫 페이지를 먼저 표시하고 전체 목록은 백그라운드에서 집계하도록 로더를 주입합니다.
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();
      const fastLoader = `
async function loadWithTicketFilter(){
  $('#go').disabled=true;
  grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>';
  const p=new URLSearchParams({rows:'100'});
  if(active)p.set('shcate',active);
  if($('#area').value)p.set('shigucodesub',$('#area').value);
  if($('#q').value.trim())p.set('shprfnm',$('#q').value.trim());
  const firstKey='movoka-first-list-v1:'+p.toString();
  const fullKey='movoka-full-list-v1:'+p.toString();

  const applyXml=(xml)=>{
    currentPage=1;
    renderItems(parse(xml));
  };

  try{
    const saved=localStorage.getItem(fullKey);
    if(saved){
      const parsed=JSON.parse(saved);
      if(Date.now()-Number(parsed.savedAt||0)<CACHE_TTL){
        applyXml(parsed.data);
        $('#go').disabled=false;
        return;
      }
    }
  }catch(_){localStorage.removeItem(fullKey)}

  try{
    const savedFirst=localStorage.getItem(firstKey);
    if(savedFirst){
      const parsed=JSON.parse(savedFirst);
      if(Date.now()-Number(parsed.savedAt||0)<CACHE_TTL) applyXml(parsed.data);
    }

    // 첫 100개는 별도 API로 즉시 표시합니다.
    const firstRequest=fetchWithTimeout('/api/performances/first?'+p.toString());
    const firstResponse=await firstRequest;
    if(firstResponse.ok){
      const firstXml=await firstResponse.text();
      localStorage.setItem(firstKey,JSON.stringify({data:firstXml,savedAt:Date.now()}));
      applyXml(firstXml);
    }
  }catch(_){
    // 첫 페이지 요청이 실패해도 전체 목록 요청을 계속 시도합니다.
  }

  // 전체 페이지 집계는 화면을 막지 않고 백그라운드에서 완료합니다.
  fetch('/api/performances?'+p.toString())
    .then(r=>{if(!r.ok)throw new Error('full list failed');return r.text()})
    .then(xml=>{
      localStorage.setItem(fullKey,JSON.stringify({data:xml,savedAt:Date.now()}));
      applyXml(xml);
    })
    .catch(()=>{})
    .finally(()=>{
      $('#go').disabled=false;
    });
}
`;
      html=html.replace('</script>',fastLoader+'</script>');
      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control','no-store, no-cache, must-revalidate');
      return new Response(html,{status:asset.status,headers});
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(){}
};