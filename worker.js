// MOVOKA Cloudflare Worker
// KOPIS 공연 API를 중계하고 초기 화면을 빠르게 표시합니다.
const ROWS = 100; // KOPIS가 허용하는 페이지당 최대 공연 수입니다.
const FIRST_ROWS = 28; // 첫 화면에 즉시 표시할 공연 수입니다.
const BATCH_PAGES = 6; // 한 번의 Worker 호출에서 가져올 KOPIS 페이지 수입니다. 무료 플랜의 외부 요청 제한을 피합니다.
const LIST_CACHE_TTL = 900; // 목록 캐시는 15분 동안 유지합니다.
const DETAIL_CACHE_TTL = 86400; // 상세 공연 캐시는 24시간 동안 유지합니다.
const TICKET_BATCH_SIZE = 20; // 한 번에 예매처 상태를 확인할 최대 공연 수입니다.
const DETAIL_CONCURRENCY = 5; // 상세 공연 정보를 동시에 조회할 수입니다.
function ymd(date) { const pad = n => String(n).padStart(2, '0'); return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`; } // 날짜를 KOPIS 형식으로 변환합니다.
function cacheKey(url) { return new Request(`https://movoka-cache.invalid/${encodeURIComponent(url)}`); } // Cloudflare 캐시 키를 만듭니다.
async function cachedText(url) { const hit = await caches.default.match(cacheKey(url)); return hit ? hit.text() : null; } // 캐시된 텍스트를 반환합니다.
async function saveText(url, text, ttl, type = 'application/xml; charset=utf-8') { await caches.default.put(cacheKey(url), new Response(text, {headers: {'Content-Type': type, 'Cache-Control': `public, max-age=${ttl}`}})); } // API 응답을 캐시합니다.
async function kopis(api) { const response = await fetch(api.toString(), {redirect: 'follow'}); if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`); return response.text(); } // KOPIS API를 호출합니다.
function dbs(xml) { return xml.match(/<db>[\s\S]*?<\/db>/g) || []; } // XML에서 공연 블록을 추출합니다.
function idOf(db) { return db.match(/<mt20id>[\s\S]*?<\/mt20id>/)?.[1] || ''; } // 공연 ID를 추출합니다.
function baseApi(url, key) { const now = new Date(); const end = new Date(now); end.setDate(end.getDate() + 30); const api = new URL('https://kopis.or.kr/openApi/restful/pblprfr'); api.searchParams.set('service', key); api.searchParams.set('stdate', url.searchParams.get('stdate') || ymd(now)); api.searchParams.set('eddate', url.searchParams.get('eddate') || ymd(end)); const genre = url.searchParams.get('shcate') || ''; const area = url.searchParams.get('signgucode') || url.searchParams.get('signgucodesub') || url.searchParams.get('shigucodesub') || ''; const keyword = url.searchParams.get('shprfnm') || ''; if (genre) api.searchParams.set('shcate', genre); if (area) api.searchParams.set('signgucode', area); if (keyword) api.searchParams.set('shprfnm', keyword); return api; } // 프론트 조건을 KOPIS 조회 조건으로 변환합니다.
async function firstPage(api, rows = FIRST_ROWS) { api = new URL(api.toString()); api.searchParams.set('cpage', '1'); api.searchParams.set('rows', String(Math.min(FIRST_ROWS, Math.max(1, Number(rows) || FIRST_ROWS)))); return kopis(api); } // 첫 화면용 페이지를 조회합니다.
async function batchPages(api, start) { const pages = []; for (let page = Number(start) || 1; page < (Number(start) || 1) + BATCH_PAGES; page++) { const request = new URL(api.toString()); request.searchParams.set('cpage', String(page)); request.searchParams.set('rows', String(ROWS)); pages.push(request); } const results = await Promise.all(pages.map(kopis)); const items = []; const seen = new Set(); let done = false; for (const xml of results) { const pageItems = dbs(xml); for (const db of pageItems) { const id = idOf(db); if (id && !seen.has(id)) { seen.add(id); items.push(db); } } if (pageItems.length < ROWS) { done = true; break; } } return {items, nextStart: (Number(start) || 1) + BATCH_PAGES, done}; } // 여러 페이지를 작은 묶음으로 수집합니다.
async function allPages(api) { const all = []; const seen = new Set(); let start = 1; while (start < 1000) { const batch = await batchPages(api, start); for (const db of batch.items) { const id = idOf(db); if (id && !seen.has(id)) { seen.add(id); all.push(db); } } if (batch.done) break; start = batch.nextStart; } return all; } // 전체 API 호출은 배치 단위로 수행합니다.
async function ticketStatus(ids, key) { const unique = [...new Set(ids)].filter(id => /^PF\d+$/.test(id)).slice(0, TICKET_BATCH_SIZE); const result = {}; let cursor = 0; const worker = async () => { while (cursor < unique.length) { const id = unique[cursor++]; try { const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`); api.searchParams.set('service', key); const url = api.toString(); const xml = (await cachedText(url)) || await kopis(api); await saveText(url, xml, DETAIL_CACHE_TTL); const urls = xml.match(/<relateurl>[\s\S]*?<\/relateurl>/g) || []; result[id] = urls.some(v => /^https?:\/\//i.test(v.replace(/<\/?relateurl>/g, '').trim())); } catch (_) { result[id] = false; } } }; await Promise.all(Array.from({length: Math.min(DETAIL_CONCURRENCY, unique.length)}, worker)); return result; } // 공연 상세정보에서 등록된 예매처 URL 존재 여부를 확인합니다.
export default { async fetch(request, env) { const url = new URL(request.url); const key = env.KOPIS_API_KEY; if (!key) return Response.json({error: 'KOPIS_API_KEY is not configured'}, {status: 500});
if (url.pathname === '/api/debug-kopis') { try { const api = baseApi(url, key); api.searchParams.set('cpage', '1'); api.searchParams.set('rows', '1'); const xml = await kopis(api); return Response.json({ok: true, host: 'kopis.or.kr', dbCount: dbs(xml).length, responseLength: xml.length}); } catch (error) { return Response.json({ok: false, error: String(error?.message || error).slice(0, 200)}, {status: 502}); } }
if (url.pathname === '/api/performances/first') { const keyUrl = `first-v9:${url.origin}${url.pathname}?${url.searchParams.toString()}`; const hit = await caches.default.match(cacheKey(keyUrl)); if (hit) return hit; try { const xml = await firstPage(baseApi(url, key), FIRST_ROWS); const response = new Response(xml, {headers: {'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300'}}); await caches.default.put(cacheKey(keyUrl), response.clone()); return response; } catch (error) { return Response.json({error: String(error?.message || error).slice(0, 200)}, {status: 502}); } }
if (url.pathname === '/api/performances/batch') { const start = Math.max(2, Number(url.searchParams.get('start') || 2)); const keyUrl = `batch-v1:${url.origin}${url.pathname}?${url.searchParams.toString()}`; const hit = await caches.default.match(cacheKey(keyUrl)); if (hit) return hit; try { const batch = await batchPages(baseApi(url, key), start); const body = JSON.stringify({xml: `<dbs>${batch.items.join('')}</dbs>`, nextStart: batch.nextStart, done: batch.done, count: batch.items.length}); const response = new Response(body, {headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`}}); await caches.default.put(cacheKey(keyUrl), response.clone()); return response; } catch (error) { return Response.json({error: String(error?.message || error).slice(0, 200)}, {status: 502}); } }
if (url.pathname === '/api/performances') { const keyUrl = `full-v17:${url.origin}${url.pathname}?${url.searchParams.toString()}`; const hit = await caches.default.match(cacheKey(keyUrl)); if (hit) return hit; try { const items = await allPages(baseApi(url, key)); const xml = `<dbs>${items.join('')}</dbs>`; const response = new Response(xml, {headers: {'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${LIST_CACHE_TTL}`}}); await caches.default.put(cacheKey(keyUrl), response.clone()); return response; } catch (error) { return Response.json({error: String(error?.message || error).slice(0, 200)}, {status: 502}); } }
if (url.pathname === '/api/ticket-status') { const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean); if (!ids.length || ids.length > TICKET_BATCH_SIZE) return Response.json({error: `ids must contain 1-${TICKET_BATCH_SIZE} performance IDs`}, {status: 400}); try { return Response.json({statuses: await ticketStatus(ids, key)}, {headers: {'Cache-Control': 'public, max-age=900'}}); } catch (_) { return Response.json({error: 'Ticket status request failed'}, {status: 502}); } }
if (url.pathname === '/api/performance') { const id = url.searchParams.get('mt20id'); if (!id || !/^PF\d+$/.test(id)) return Response.json({error: 'Invalid mt20id'}, {status: 400}); try { const api = new URL(`https://kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`); api.searchParams.set('service', key); const apiUrl = api.toString(); const xml = (await cachedText(apiUrl)) || await kopis(api); await saveText(apiUrl, xml, DETAIL_CACHE_TTL); return new Response(xml, {headers: {'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${DETAIL_CACHE_TTL}`}}); } catch (_) { return Response.json({error: 'KOPIS request failed'}, {status: 502}); } }
if (url.pathname === '/' || url.pathname === '/index.html') { const asset = await env.ASSETS.fetch(request); let html = await asset.text(); const loader = `
let movokaLoadToken=0;
function mergeMovokaXml(xml){
  // 새 배치의 공연을 기존 목록과 합치고 공연 ID 기준으로 중복을 제거합니다.
  const incoming=parse(xml); const map=new Map(lastItems.map(item=>[item.mt20id,item]));
  incoming.forEach(item=>{if(item.mt20id)map.set(item.mt20id,item);}); lastItems=[...map.values()]; renderItems(lastItems);
}
async function loadWithTicketFilter(){
  // 검색 버튼을 잠그고 초기 로딩 상태를 표시합니다.
  const token=++movokaLoadToken; $('#go').disabled=true; grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>'; currentPage=1;
  const p=new URLSearchParams({rows:'28'}); if(active)p.set('shcate',active); if($('#area').value)p.set('shigucodesub',$('#area').value); if($('#q').value.trim())p.set('shprfnm',$('#q').value.trim());
  const firstKey='movoka-first-list-v9:'+p.toString();
  try{ const saved=localStorage.getItem(firstKey); if(saved){ const parsed=JSON.parse(saved); if(Date.now()-Number(parsed.savedAt||0)<CACHE_TTL){lastItems=[];renderItems(parse(parsed.data));} else localStorage.removeItem(firstKey); } }catch(_){ try{localStorage.removeItem(firstKey);}catch(__){} }
  // 첫 28개는 별도 API로 즉시 가져와 화면을 먼저 보여줍니다.
  try{
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),8000); let response;
    try{ response=await fetch('/api/performances/first?'+p.toString(),{signal:controller.signal,cache:'no-store'}); } finally{ clearTimeout(timer); }
    if(!response.ok)throw new Error('first page failed'); const xml=await response.text();
    if(token!==movokaLoadToken)return; lastItems=parse(xml); renderItems(lastItems);
    try{localStorage.setItem(firstKey,JSON.stringify({data:xml,savedAt:Date.now()}));}catch(_){ }
  }catch(error){ if(token===movokaLoadToken&&!lastItems.length)grid.innerHTML='<div class="empty">공연 정보를 불러오지 못했습니다.<br><button class="primary" style="margin-top:14px;padding:10px 16px" onclick="loadWithTicketFilter()">다시 시도</button></div>'; }
  $('#go').disabled=false;
  // 전체 공연은 6페이지씩 백그라운드에서 계속 수집해 페이지 이동 시 추가 API 호출이 필요 없도록 합니다.
  if(token!==movokaLoadToken)return;
  let start=2;
  while(token===movokaLoadToken){
    try{
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),20000); let response;
      try{ response=await fetch('/api/performances/batch?'+p.toString()+'&start='+start,{signal:controller.signal,cache:'no-store'}); } finally{ clearTimeout(timer); }
      if(!response.ok)throw new Error('batch failed'); const data=await response.json();
      if(token!==movokaLoadToken)break; mergeMovokaXml(data.xml||'<dbs></dbs>');
      if(data.done)break; start=Number(data.nextStart)||start+6;
      await new Promise(resolve=>setTimeout(resolve,250));
    }catch(_){ break; }
  }
}
// 페이지가 로드되면 공연 목록 조회를 자동으로 시작합니다.
loadWithTicketFilter().catch(()=>{
  // 초기화 과정에서 예기치 않은 오류가 발생해도 로딩 화면에 멈추지 않게 합니다.
  if(!lastItems.length)grid.innerHTML='<div class="empty">공연 정보를 불러오지 못했습니다.<br><button class="primary" style="margin-top:14px;padding:10px 16px" onclick="loadWithTicketFilter()">다시 시도</button></div>';
  $('#go').disabled=false;
});
`;
html = html.replace('</script>', loader + '</script>'); const headers = new Headers(asset.headers); headers.delete('Content-Length'); headers.set('Cache-Control', 'no-store, no-cache, must-revalidate'); return new Response(html, {status: asset.status, headers}); }
return env.ASSETS.fetch(request); }, async scheduled() {} };