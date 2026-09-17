// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 중계하고 초기 화면을 빠르게 표시합니다.
const ROWS = 100;
const FIRST_ROWS = 28;
const BATCH_PAGES = 6;
const LIST_CACHE_TTL = 900;
const DETAIL_CACHE_TTL = 86400;
const TICKET_BATCH_SIZE = 20;
const DETAIL_CONCURRENCY = 5;

// KOPIS의 canonical HTTPS 호스트를 직접 사용해 www 리다이렉트 문제를 피합니다.
const KOPIS_BASE = 'https://kopis.or.kr/openApi/restful/pblprfr';

function ymd(date) {
  // 날짜를 KOPIS 형식인 YYYYMMDD로 변환합니다.
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}
function cacheKey(url) {
  // Cloudflare Cache API에서 사용할 고유 캐시 키를 만듭니다.
  return new Request(`https://movoka-cache.invalid/${encodeURIComponent(url)}`);
}
function dbs(xml) {
  // KOPIS XML에서 공연 단위인 db 태그를 추출합니다.
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}
function idOf(db) {
  // 공연 ID를 추출합니다.
  return db.match(/<mt20id>[\s\S]*?<\/mt20id>/)?.[1] || '';
}
async function kopis(api) {
  // KOPIS API를 호출하고 HTTP 오류 내용을 함께 반환합니다.
  const response = await fetch(api.toString(), {redirect: 'follow'});
  const text = await response.text();
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}: ${text.slice(0, 180)}`);
  return text;
}
function baseApi(url, key) {
  // 화면의 검색 조건을 KOPIS 공연목록 API 조건으로 변환합니다.
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);
  const api = new URL(KOPIS_BASE);
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
async function firstPage(api) {
  // 첫 화면용 28개만 조회합니다.
  const request = new URL(api);
  request.searchParams.set('cpage', '1');
  request.searchParams.set('rows', String(FIRST_ROWS));
  return kopis(request);
}
async function batchPages(api, start) {
  // Cloudflare 외부 요청 제한을 피하기 위해 6페이지씩 조회합니다.
  const first = Number(start) || 2;
  const requests = [];
  for (let page = first; page < first + BATCH_PAGES; page++) {
    const request = new URL(api);
    request.searchParams.set('cpage', String(page));
    request.searchParams.set('rows', String(ROWS));
    requests.push(request);
  }
  const results = await Promise.all(requests.map(kopis));
  const items = [];
  const seen = new Set();
  let done = false;
  for (const xml of results) {
    const pageItems = dbs(xml);
    for (const db of pageItems) {
      const id = idOf(db);
      if (id && !seen.has(id)) { seen.add(id); items.push(db); }
    }
    if (pageItems.length < ROWS) { done = true; break; }
  }
  return {items, nextStart: first + BATCH_PAGES, done};
}
async function ticketStatus(ids, key) {
  // 상세정보의 예매처 URL 존재 여부를 확인합니다.
  const unique = [...new Set(ids)].filter(id => /^PF\d+$/.test(id)).slice(0, TICKET_BATCH_SIZE);
  const result = {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const id = unique[cursor++];
      try {
        const api = new URL(`${KOPIS_BASE}/${encodeURIComponent(id)}`);
        api.searchParams.set('service', key);
        const response = await fetch(api.toString(), {redirect: 'follow'});
        const xml = await response.text();
        const urls = xml.match(/<relateurl>[\s\S]*?<\/relateurl>/g) || [];
        result[id] = urls.some(v => /^https?:\/\//i.test(v.replace(/<\/?relateurl>/g, '').trim()));
      } catch (_) { result[id] = false; }
    }
  };
  await Promise.all(Array.from({length: Math.min(DETAIL_CONCURRENCY, unique.length)}, worker));
  return result;
}
export default {
  async fetch(request, env) {
    // Worker 환경과 요청 URL을 준비합니다.
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;
    if (!key) return Response.json({error: 'KOPIS_API_KEY is not configured'}, {status: 500});

    if (url.pathname === '/api/debug-kopis') {
      // KOPIS 연결 상태를 직접 확인할 수 있는 디버그 API입니다.
      try {
        const api = baseApi(url, key);
        api.searchParams.set('cpage', '1');
        api.searchParams.set('rows', '1');
        const xml = await kopis(api);
        return Response.json({ok: true, host: 'https://kopis.or.kr', dbCount: dbs(xml).length, responseLength: xml.length});
      } catch (error) {
        return Response.json({ok: false, error: String(error?.message || error).slice(0, 300)}, {status: 502});
      }
    }

    if (url.pathname === '/api/performances/first') {
      // 첫 화면 API는 별도 캐시로 보호합니다.
      const keyUrl = `first-v12:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const hit = await caches.default.match(cacheKey(keyUrl));
      if (hit) return hit;
      try {
        const xml = await firstPage(baseApi(url, key));
        if (!dbs(xml).length) throw new Error('KOPIS returned 0 performances');
        const response = new Response(xml, {headers: {'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300'}});
        await caches.default.put(cacheKey(keyUrl), response.clone());
        return response;
      } catch (error) {
        return Response.json({error: String(error?.message || error).slice(0, 300)}, {status: 502});
      }
    }

    if (url.pathname === '/api/performances/batch') {
      // 전체 목록을 6페이지씩 나눠 조회합니다.
      const start = Math.max(2, Number(url.searchParams.get('start') || 2));
      const keyUrl = `batch-v4:${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      const hit = await caches.default.match(cacheKey(keyUrl));
      if (hit) return hit;
      try {
        const batch = await batchPages(baseApi(url, key), start);
        const body = JSON.stringify({xml: `<dbs>${batch.items.join('')}</dbs>`, nextStart: batch.nextStart, done: batch.done, count: batch.items.length});
        const response = new Response(body, {headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`}});
        await caches.default.put(cacheKey(keyUrl), response.clone());
        return response;
      } catch (error) {
        return Response.json({error: String(error?.message || error).slice(0, 300)}, {status: 502});
      }
    }

    if (url.pathname === '/api/ticket-status') {
      // 요청된 공연들의 예매처 상태를 확인합니다.
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > TICKET_BATCH_SIZE) return Response.json({error: `ids must contain 1-${TICKET_BATCH_SIZE} performance IDs`}, {status: 400});
      try { return Response.json({statuses: await ticketStatus(ids, key)}); }
      catch (_) { return Response.json({error: 'Ticket status request failed'}, {status: 502}); }
    }

    if (url.pathname === '/') {
      // 정적 사이트에 초기 로더를 주입합니다.
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();
      const loader = `
let movokaLoadToken=0;
function mergeMovokaXml(xml){
  // 새 배치 공연을 기존 목록과 합치고 공연 ID로 중복을 제거합니다.
  const incoming=parse(xml); const map=new Map(lastItems.map(item=>[item.mt20id,item])); incoming.forEach(item=>{if(item.mt20id)map.set(item.mt20id,item);}); lastItems=[...map.values()]; renderItems(lastItems);
}
async function loadWithTicketFilter(){
  // 첫 28개를 먼저 가져와 화면을 표시합니다.
  const token=++movokaLoadToken; $('#go').disabled=true; grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>'; currentPage=1;
  const p=new URLSearchParams({rows:'28'}); if(active)p.set('shcate',active); if($('#area').value)p.set('shigucodesub',$('#area').value); if($('#q').value.trim())p.set('shprfnm',$('#q').value.trim());
  try{
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),12000);
    let response;
    try{response=await fetch('/api/performances/first?'+p.toString(),{signal:controller.signal,cache:'no-store'});}finally{clearTimeout(timer);}
    if(!response.ok){const text=await response.text(); throw new Error(text||'first page failed');}
    const xml=await response.text(); if(token!==movokaLoadToken)return;
    lastItems=parse(xml); if(!lastItems.length)throw new Error('KOPIS 응답에 공연이 없습니다.'); renderItems(lastItems);
  }catch(error){
    // 실패 원인을 화면에 표시해 무한 로딩을 방지합니다.
    if(token===movokaLoadToken) grid.innerHTML='<div class="empty">공연 정보를 불러오지 못했습니다.<br><small style="display:block;margin-top:10px">'+esc(String(error?.message||error).slice(0,220))+'</small><button class="primary" style="margin-top:14px;padding:10px 16px" onclick="loadWithTicketFilter()">다시 시도</button></div>';
  }
  $('#go').disabled=false;
  // 첫 화면 이후 전체 공연을 6페이지씩 백그라운드에서 계속 가져옵니다.
  if(token!==movokaLoadToken)return;
  let start=2;
  while(token===movokaLoadToken){
    try{
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),20000); let response;
      try{response=await fetch('/api/performances/batch?'+p.toString()+'&start='+start,{signal:controller.signal,cache:'no-store'});}finally{clearTimeout(timer);}
      if(!response.ok)throw new Error('batch failed');
      const data=await response.json();
      if(token!==movokaLoadToken)break;
      mergeMovokaXml(data.xml||'<dbs></dbs>');
      if(data.done)break;
      start=Number(data.nextStart)||start+6;
      await new Promise(resolve=>setTimeout(resolve,250));
    }catch(_){break;}
  }
}
// 페이지가 로드되면 공연 목록 조회를 시작합니다.
loadWithTicketFilter().catch(()=>{
  $('#go').disabled=false;
});
`;
      html = html.replace('</script>', loader + '</script>');
      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(html, {status: asset.status, headers});
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled() {}
};