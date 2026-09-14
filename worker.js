// MOVOKA Cloudflare Worker
// KOPIS API 요청은 서버에서 처리하고, 기본 공연 목록은 하루 한 번 캐시로 갱신합니다.

const SNAPSHOT_PREFIX = 'https://movoka-cache.local/api/performances/snapshot/';
const SNAPSHOT_TTL_DAYS = 7;

function snapshotKey(date) { return `${SNAPSHOT_PREFIX}${date}`; }
function dateStamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'},{status:500});
      const now = new Date();
      const pad = n => String(n).padStart(2,'0');
      const ymd = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
      const startDate = url.searchParams.get('stdate') || ymd(now);
      const endObj = new Date(now); endObj.setDate(endObj.getDate()+30);
      const endDate = url.searchParams.get('eddate') || ymd(endObj);
      const page = Math.max(1,Number(url.searchParams.get('cpage')||1));
      const ticketable = url.searchParams.get('ticketable') === '1';
      const requestedRows = Math.min(100,Math.max(1,Number(url.searchParams.get('rows')||100)));
      const rows = ticketable ? Math.min(30,requestedRows) : requestedRows;
      const genre = url.searchParams.get('shcate') || '';
      const area = url.searchParams.get('signgucodesub') || url.searchParams.get('signgucode') || '';
      const keyword = url.searchParams.get('shprfnm') || '';

      const isDefault = !genre&&!area&&!keyword&&page===1&&ticketable&&rows<=30&&!url.searchParams.has('stdate')&&!url.searchParams.has('eddate');
      if (isDefault) { const latest=await findLatestSnapshot(); if(latest)return latest; }

      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service',key); api.searchParams.set('stdate',startDate); api.searchParams.set('eddate',endDate);
      api.searchParams.set('cpage',String(page)); api.searchParams.set('rows',String(rows)); api.searchParams.set('prfstate','02');
      if(genre)api.searchParams.set('shcate',genre); if(area)api.searchParams.set('signgucode',area); if(keyword)api.searchParams.set('shprfnm',keyword);
      return ticketable ? filterTicketable(api,key) : proxyKopis(api);
    }

    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'},{status:500});
      const id=url.searchParams.get('mt20id');
      if(!id||!/^PF\d+$/.test(id))return Response.json({error:'Invalid mt20id'},{status:400});
      const api=new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
      api.searchParams.set('service',key); return proxyKopis(api);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset=await env.ASSETS.fetch(request); let html=await asset.text();
      html=html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi,'$1예매 사이트$3');
      html=html.replace(/>(예매|예매처 비교)<\/button>/g,'>예매 사이트</button>');
      html=html.replace("new URLSearchParams({rows:'100'})","new URLSearchParams({rows:'30',ticketable:'1'})");
      html=html.replace('</style></head>','.ad-slot{display:none;width:100%;min-height:90px;margin:0 0 24px;align-items:center;justify-content:center;overflow:hidden}.ad-slot.has-ad{display:flex}.ad-slot ins,.ad-slot iframe{max-width:100%;display:block}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;width:100%;margin:0 0 50px;padding:0 0 10px}.pagination button{min-width:40px;height:40px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800}.pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}.pagination button:disabled{opacity:.4;cursor:default}@media(max-width:480px){.ad-slot{min-height:60px;margin-bottom:18px}.pagination{gap:6px;margin-bottom:35px}.pagination button{min-width:36px;height:36px}}'+ '</style></head>');
      html=html.replace('<div class="toolbar">','<div class="ad-slot" id="ad-top" data-ad-slot="top" aria-label="광고"></div><div class="toolbar">');
      html=html.replace('<footer>','<div class="ad-slot" id="ad-bottom" data-ad-slot="bottom" aria-label="광고"></div><footer>');
      // 광고가 삽입된 경우에만 슬롯을 표시합니다.
      html=html.replace('</script></body>','<script>(function(){function refresh(){document.querySelectorAll(".ad-slot").forEach(function(s){s.classList.toggle("has-ad",!!s.querySelector("ins,iframe,img,a,[data-ad-loaded]"));});}refresh();new MutationObserver(refresh).observe(document.body,{childList:true,subtree:true});})();</script></body>');
      // 공연 목록 바로 아래에 페이지 번호 영역을 고정으로 배치합니다.
      html=html.replace('</section></main>','</section><div class="pagination" id="pagination" aria-label="공연 목록 페이지 이동"></div></main>');
      const paginationScript='<script>(function(){var currentPage=1;function loadPage(page){currentPage=Math.max(1,page);var grid=document.querySelector("#grid"),count=document.querySelector("#count"),pagination=document.querySelector("#pagination");if(!grid)return;grid.innerHTML="<div class=\\"empty\\">공연 정보를 불러오는 중입니다.</div>";var p=new URLSearchParams({rows:"30",ticketable:"1",cpage:String(currentPage)});var active=Array.from(document.querySelectorAll(".chip")).find(function(b){return b.classList.contains("active")});var genre=active?active.dataset.id:"",area=document.querySelector("#area")?.value||"",keyword=document.querySelector("#q")?.value.trim()||"";if(genre)p.set("shcate",genre);if(area)p.set("signgucodesub",area);if(keyword)p.set("shprfnm",keyword);fetch("/api/performances?"+p.toString()).then(function(r){if(!r.ok)throw new Error();return r.text()}).then(function(xml){var items=typeof parse==="function"?parse(xml):[];if(typeof lastItems!=="undefined")lastItems=items;if(typeof renderItems==="function")renderItems(items);var doc=new DOMParser().parseFromString(xml,"text/xml"),total=Number(doc.querySelector("totalcount")?.textContent||0),pages=total?Math.max(1,Math.ceil(total/30)):(items.length===30?currentPage+1:currentPage);renderPagination(pages);if(count&&total)count.textContent="공연 "+total.toLocaleString()+"개";}).catch(function(){if(count)count.textContent="";grid.innerHTML="<div class=\\"empty\\">공연 정보를 불러오지 못했습니다.</div>";if(pagination)pagination.innerHTML="";});}function renderPagination(totalPages){var el=document.querySelector("#pagination");if(!el)return;if(totalPages<=1){el.innerHTML="";return;}var start=Math.max(1,Math.floor((currentPage-1)/10)*10+1),end=Math.min(totalPages,start+9),out=[];out.push("<button "+(currentPage===1?"disabled":"")+" data-page=\\""+(currentPage-1)+"\\">‹</button>");for(var i=start;i<=end;i++)out.push("<button class=\\""+(i===currentPage?"active":"")+"\\" data-page=\\""+i+"\\">"+i+"</button>");out.push("<button "+(currentPage===totalPages?"disabled":"")+" data-page=\\""+(currentPage+1)+"\\">›</button>");el.innerHTML=out.join("");el.querySelectorAll("button[data-page]").forEach(function(b){b.onclick=function(){if(!b.disabled)loadPage(Number(b.dataset.page));};});}window.movokaLoadPage=loadPage;loadPage(1);})();</script></body>';
      html=html.replace('</script></body>',paginationScript);
      return new Response(html,{status:asset.status,headers:asset.headers});
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller,env,ctx){
    if(!env.KOPIS_API_KEY)return;
    const now=new Date(),pad=n=>String(n).padStart(2,'0'),ymd=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
    const end=new Date(now);end.setDate(end.getDate()+30);
    const api=new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');api.searchParams.set('service',env.KOPIS_API_KEY);api.searchParams.set('stdate',ymd(now));api.searchParams.set('eddate',ymd(end));api.searchParams.set('cpage','1');api.searchParams.set('rows','30');api.searchParams.set('prfstate','02');
    ctx.waitUntil(refreshSnapshot(api,env.KOPIS_API_KEY,now));
  }
};

async function findLatestSnapshot(){for(let age=0;age<=SNAPSHOT_TTL_DAYS;age++){const d=new Date();d.setUTCDate(d.getUTCDate()-age);const cached=await caches.default.match(snapshotKey(dateStamp(d)));if(cached)return cached;}return null;}
async function refreshSnapshot(api,key,now){const response=await filterTicketable(api,key);if(!response.ok)return;const snapshot=new Response(await response.clone().text(),{status:200,headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':`public, max-age=${SNAPSHOT_TTL_DAYS*86400}`}});await caches.default.put(snapshotKey(dateStamp(now)),snapshot);const expired=new Date(now);expired.setUTCDate(expired.getUTCDate()-(SNAPSHOT_TTL_DAYS+1));await caches.default.delete(snapshotKey(dateStamp(expired)));}
async function filterTicketable(api,key){try{const response=await fetch(api.toString()),body=await response.text();if(!response.ok)return new Response(body,{status:response.status,headers:{'Content-Type':'application/xml; charset=utf-8'}});const totalCount=body.match(/<totalcount>([\s\S]*?)<\/totalcount>/i)?.[1]?.trim()||'',blocks=body.match(/<db>[\s\S]*?<\/db>/g)||[];const filtered=await Promise.all(blocks.map(async block=>{const id=block.match(/<mt20id>([\s\S]*?)<\/mt20id>/)?.[1]?.trim();if(!id||!/^PF\d+$/.test(id))return null;const d=new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);d.searchParams.set('service',key);try{const r=await fetch(d.toString()),detail=await r.text();return /<relates>[\s\S]*?<relate>[\s\S]*?<relateurl>https?:\/\//i.test(detail)?block:null;}catch{return null;}}));return new Response(`<dbs><totalcount>${totalCount}</totalcount>${filtered.filter(Boolean).join('')}</dbs>`,{status:200,headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store'}});}catch{return Response.json({error:'KOPIS ticket availability check failed'},{status:502});}}
async function proxyKopis(api){try{const response=await fetch(api.toString()),body=await response.text();return new Response(body,{status:response.status,headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store'}});}catch{return Response.json({error:'KOPIS request failed'},{status:502});}}
