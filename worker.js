// MOVOKA Cloudflare Worker
// KOPIS API 요청은 서버에서 처리하고 기본 공연 목록은 하루 한 번 캐시로 갱신합니다.

const SNAPSHOT_PREFIX = 'https://movoka-cache.local/v4/performances/snapshot/';
const SNAPSHOT_TTL_DAYS = 7;
const PAGE_SIZE = 10;

function snapshotKey(date) { return `${SNAPSHOT_PREFIX}${date}`; }
function dateStamp(date) { const pad=n=>String(n).padStart(2,'0'); return `${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}`; }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'},{status:500});
      const now=new Date(), pad=n=>String(n).padStart(2,'0'), ymd=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
      const startDate=url.searchParams.get('stdate')||ymd(now);
      const endObj=new Date(now); endObj.setDate(endObj.getDate()+30);
      const endDate=url.searchParams.get('eddate')||ymd(endObj);
      const page=Math.max(1,Number(url.searchParams.get('cpage')||1));
      const rows=PAGE_SIZE;
      const genre=url.searchParams.get('shcate')||'';
      const area=url.searchParams.get('signgucodesub')||url.searchParams.get('signgucode')||'';
      const keyword=url.searchParams.get('shprfnm')||'';

      const isDefault=!genre&&!area&&!keyword&&page===1&&!url.searchParams.has('stdate')&&!url.searchParams.has('eddate');
      if(isDefault){const latest=await findLatestSnapshot();if(latest)return latest;}

      const api=new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service',key); api.searchParams.set('stdate',startDate); api.searchParams.set('eddate',endDate);
      api.searchParams.set('cpage',String(page)); api.searchParams.set('rows',String(rows)); api.searchParams.set('prfstate','02');
      if(genre)api.searchParams.set('shcate',genre); if(area)api.searchParams.set('signgucode',area); if(keyword)api.searchParams.set('shprfnm',keyword);
      return proxyKopis(api);
    }

    if(url.pathname==='/api/performance'){
      if(!key)return Response.json({error:'KOPIS_API_KEY is not configured'},{status:500});
      const id=url.searchParams.get('mt20id'); if(!id||!/^PF\d+$/.test(id))return Response.json({error:'Invalid mt20id'},{status:400});
      const api=new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`); api.searchParams.set('service',key); return proxyKopis(api);
    }

    if(url.pathname==='/'||url.pathname==='/index.html'){
      const asset=await env.ASSETS.fetch(request); let html=await asset.text();
      html=html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi,'$1예매 사이트$3');
      html=html.replace(/>(예매|예매처 비교)<\/button>/g,'>예매 사이트</button>');
      html=html.replace("new URLSearchParams({rows:'100'})",`new URLSearchParams({rows:'${PAGE_SIZE}'})`);
      html=html.replace('</style></head>',`.ad-slot{display:none;width:100%;min-height:90px;margin:0 0 24px;align-items:center;justify-content:center;overflow:hidden}.ad-slot.has-ad{display:flex}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;width:100%;margin:28px 0 50px;padding:0 0 10px}.pagination button{min-width:40px;height:40px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800;padding:0 12px}.pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}.pagination button:disabled{opacity:.4;cursor:default}.pagination button.nav{font-size:12px}@media(max-width:480px){.ad-slot{min-height:60px;margin-bottom:18px}.pagination{gap:6px;margin:28px 0 35px}.pagination button{min-width:36px;height:36px;padding:0 8px}.pagination button.nav{font-size:12px;padding:0 10px}}`+'</style></head>');
      html=html.replace('<div class="toolbar">','<div class="ad-slot" id="ad-top" data-ad-slot="top" aria-label="광고"></div><div class="toolbar">');
      // 페이지네이션을 main 내부의 footer 바로 위에 넣어 DOM 위치를 확실하게 고정합니다.
      html=html.replace('<footer>','<div class="ad-slot" id="ad-bottom" data-ad-slot="bottom" aria-label="광고"></div><div class="pagination" id="pagination" aria-label="공연 목록 페이지 이동"></div><footer>');

      // HTML을 수정했으므로 원본 ASSET의 Content-Length는 폐기합니다.
      const headers=new Headers(asset.headers); headers.delete('Content-Length');

      const paginationScript=`<script>(function(){
function getFilters(){var a=document.querySelector('.chip.active');return {genre:a?(a.dataset.id||''):'',area:(document.querySelector('#area')||{}).value||'',keyword:((document.querySelector('#q')||{}).value||'').trim()};}
function loadPage(page){page=Math.max(1,Number(page)||1);var grid=document.querySelector('#grid'),count=document.querySelector('#count'),el=document.querySelector('#pagination');if(!grid)return;grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>';var f=getFilters(),p=new URLSearchParams({rows:'10',cpage:String(page)});if(f.genre)p.set('shcate',f.genre);if(f.area)p.set('signgucodesub',f.area);if(f.keyword)p.set('shprfnm',f.keyword);fetch('/api/performances?'+p).then(function(r){if(!r.ok)throw new Error();return r.text()}).then(function(xml){var items=typeof parse==='function'?parse(xml):[];if(typeof lastItems!=='undefined')lastItems=items;if(typeof renderItems==='function')renderItems(items);var doc=new DOMParser().parseFromString(xml,'text/xml'),total=Number(doc.querySelector('totalcount')?.textContent||0),pages=total?Math.ceil(total/10):(items.length===10?page+1:page);renderPagination(page,pages);}).catch(function(){if(count)count.textContent='';grid.innerHTML='<div class="empty">공연 정보를 불러오지 못했습니다.</div>';if(el)el.innerHTML='';});}
function renderPagination(page,pages){var el=document.querySelector('#pagination');if(!el)return;if(pages<=1){el.innerHTML='';return;}var start=Math.floor((page-1)/10)*10+1,end=Math.min(pages,start+9),out=[];out.push('<button class="nav" '+(page<=1?'disabled':'')+' data-page="'+(page-1)+'">‹ 이전</button>');for(var i=start;i<=end;i++)out.push('<button class="'+(i===page?'active':'')+'" data-page="'+i+'">'+i+'</button>');out.push('<button class="nav" '+(page>=pages?'disabled':'')+' data-page="'+(page+1)+'">다음 ›</button>');el.innerHTML=out.join('');el.querySelectorAll('[data-page]').forEach(function(b){b.onclick=function(){if(!b.disabled)loadPage(Number(b.dataset.page));};});}
function bind(){document.querySelectorAll('.chip').forEach(function(b){b.onclick=function(){document.querySelectorAll('.chip').forEach(function(x){x.classList.toggle('active',x===b);});loadPage(1);};});var go=document.querySelector('#go');if(go)go.onclick=function(){loadPage(1);};var area=document.querySelector('#area');if(area)area.onchange=function(){loadPage(1);};var q=document.querySelector('#q');if(q)q.onkeydown=function(e){if(e.key==='Enter')loadPage(1);};}
window.movokaLoadPage=loadPage;bind();loadPage(1);})();</script>`;
      html=html.replace('</body>',paginationScript+'</body>');
      const adScript=`<script>(function(){function refresh(){document.querySelectorAll('.ad-slot').forEach(function(s){s.classList.toggle('has-ad',!!s.querySelector('ins,iframe,img,a,[data-ad-loaded]'));});}refresh();new MutationObserver(refresh).observe(document.body,{childList:true,subtree:true});})();</script>`;
      html=html.replace('</body>',adScript+'</body>');
      return new Response(html,{status:asset.status,headers});
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller,env,ctx){if(!env.KOPIS_API_KEY)return;const now=new Date(),pad=n=>String(n).padStart(2,'0'),ymd=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;const end=new Date(now);end.setDate(end.getDate()+30);const api=new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');api.searchParams.set('service',env.KOPIS_API_KEY);api.searchParams.set('stdate',ymd(now));api.searchParams.set('eddate',ymd(end));api.searchParams.set('cpage','1');api.searchParams.set('rows',String(PAGE_SIZE));api.searchParams.set('prfstate','02');ctx.waitUntil(refreshSnapshot(api,env.KOPIS_API_KEY,now));}
};
async function findLatestSnapshot(){for(let age=0;age<=SNAPSHOT_TTL_DAYS;age++){const d=new Date();d.setUTCDate(d.getUTCDate()-age);const cached=await caches.default.match(snapshotKey(dateStamp(d)));if(cached)return cached;}return null;}
async function refreshSnapshot(api,key,now){const response=await proxyKopis(api);if(!response.ok)return;const snapshot=new Response(await response.clone().text(),{status:200,headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':`public, max-age=${SNAPSHOT_TTL_DAYS*86400}`}});await caches.default.put(snapshotKey(dateStamp(now)),snapshot);const expired=new Date(now);expired.setUTCDate(expired.getUTCDate()-(SNAPSHOT_TTL_DAYS+1));await caches.default.delete(snapshotKey(dateStamp(expired)));}
async function proxyKopis(api){try{const response=await fetch(api.toString());const body=await response.text();return new Response(body,{status:response.status,headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store'}});}catch{return Response.json({error:'KOPIS request failed'},{status:502});}}
