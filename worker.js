// MOVOKA Cloudflare Worker
// KOPIS 공연 데이터를 받아 브라우저에 저장하고, 저장된 목록을 12개씩 표시합니다.

const FETCH_ROWS = 100;

function getYmd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function proxyKopis(api) {
  try {
    const response = await fetch(api.toString());
    if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
    return new Response(await response.text(), {headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store'}});
  } catch (_) {
    return Response.json({error:'KOPIS request failed'}, {status:502});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate()+30);
      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service',key);
      api.searchParams.set('stdate',url.searchParams.get('stdate')||getYmd(now));
      api.searchParams.set('eddate',url.searchParams.get('eddate')||getYmd(end));
      api.searchParams.set('cpage','1');
      api.searchParams.set('rows',String(FETCH_ROWS));
      api.searchParams.set('prfstate','02');
      const genre=url.searchParams.get('shcate')||'';
      const area=url.searchParams.get('signgucode')||'';
      const keyword=url.searchParams.get('shprfnm')||'';
      if(genre)api.searchParams.set('shcate',genre);
      if(area)api.searchParams.set('signgucode',area);
      if(keyword)api.searchParams.set('shprfnm',keyword);
      return proxyKopis(api);
    }

    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({error:'KOPIS_API_KEY is not configured'}, {status:500});
      const id=url.searchParams.get('mt20id');
      if(!id||!/^PF\d+$/.test(id))return Response.json({error:'Invalid mt20id'},{status:400});
      const api=new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
      api.searchParams.set('service',key);
      return proxyKopis(api);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset=await env.ASSETS.fetch(request);
      let html=await asset.text();
      html=html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi,'$1예매 사이트$3');
      html=html.replace(/>(예매|예매처 비교)<\/button>/g,'>예매 사이트</button>');

      // 공연 API 응답을 한 번 가져오면 브라우저에 저장합니다.
      const storageScript=`<script>(function(){const f=window.fetch;window.fetch=async function(i,n){const r=await f.call(this,i,n);try{const u=typeof i==='string'?i:(i&&i.url)||'';if(u.includes('/api/performances')){const d=await r.clone().text();localStorage.setItem('movoka-performances-cache',JSON.stringify({url:u,data:d,savedAt:Date.now()}));window.dispatchEvent(new Event('movoka-cache-updated'));}}catch(_){}return r;};})();</script>`;
      html=html.replace('</head>',storageScript+'</head>');

      // 기존 renderItems가 전체 목록을 받을 때 그 목록을 저장하고,
      // 화면에는 12개만 전달합니다. 페이지 이동은 API를 다시 호출하지 않습니다.
      const paginationScript=`<style>
#movoka-pagination{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;margin:-40px 0 70px}
#movoka-pagination button{min-width:40px;height:40px;padding:0 11px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800}
#movoka-pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}
</style><div id="movoka-pagination"></div><script>
(function(){
const SIZE=12;
let all=[];
let page=1;
let original=null;
let ready=false;

function pages(){return Math.ceil(all.length/SIZE)}
function show(){
  if(!original)return;
  const total=pages();
  if(page>total)page=total||1;
  const start=(page-1)*SIZE;
  original(all.slice(start,start+SIZE));
  const box=document.getElementById('movoka-pagination');
  if(!box)return;
  if(total<=1){box.innerHTML='';return;}
  box.innerHTML=Array.from({length:total},(_,i)=>{const p=i+1;return '<button type="button" data-page="'+p+'" class="'+(p===page?'active':'')+'">'+p+'</button>';}).join('');
  box.querySelectorAll('button').forEach(b=>b.onclick=()=>{page=Number(b.dataset.page);show();window.scrollTo({top:document.getElementById('grid').offsetTop-90,behavior:'smooth'});});
}
function install(){
  if(ready)return true;
  if(typeof window.renderItems!=='function')return false;
  original=window.renderItems;
  window.renderItems=function(items){
    // API에서 새 전체 목록이 들어왔을 때만 전체 배열을 교체합니다.
    if(!all.length || items.length!==all.length || items[0]?.mt20id!==all[0]?.mt20id){all=items.slice();page=1;}
    show();
  };
  ready=true;
  return true;
}
function boot(){if(!install())setTimeout(boot,50);}
window.addEventListener('load',boot);
setTimeout(boot,0);
})();
</script>`;
      html=html.replace('<footer>',paginationScript+'<footer>');

      const headers=new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control','no-store, no-cache, must-revalidate');
      return new Response(html,{status:asset.status,headers});
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(){}
};
