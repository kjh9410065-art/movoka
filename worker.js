// MOVOKA Cloudflare Worker
// KOPIS 공연 데이터를 받아 브라우저에 저장하고, 화면에서 12개씩 페이지로 나눕니다.

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

      // 공연 API 응답은 한 번 가져오면 브라우저에 저장합니다.
      const storageScript=`<script>(function(){const f=window.fetch;window.fetch=async function(i,n){const r=await f.call(this,i,n);try{const u=typeof i==='string'?i:(i&&i.url)||'';if(u.includes('/api/performances')){const d=await r.clone().text();localStorage.setItem('movoka-performances-cache',JSON.stringify({url:u,data:d,savedAt:Date.now()}));window.dispatchEvent(new Event('movoka-cache-updated'));}}catch(_){}return r;};})();</script>`;
      html=html.replace('</head>',storageScript+'</head>');

      // 실제 화면에 렌더링된 공연 카드만 12개씩 나눕니다.
      // 페이지 이동 시 API를 다시 호출하지 않고 현재 렌더링된 목록만 표시합니다.
      const paginationScript=`<style>
#movoka-pagination{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;margin:-40px 0 70px}
#movoka-pagination button{min-width:40px;height:40px;padding:0 11px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800}
#movoka-pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}
</style><div id="movoka-pagination"></div><script>
(function(){
  const SIZE=12;
  let page=1;
  let applying=false;
  const grid=document.getElementById('grid');
  const box=document.getElementById('movoka-pagination');

  // 현재 grid에 들어온 카드 수를 기준으로 페이지를 만듭니다.
  function apply(){
    if(!grid||!box||applying)return;
    applying=true;
    const cards=[...grid.querySelectorAll('.card')];
    const total=Math.ceil(cards.length/SIZE);
    if(page>total)page=total||1;

    // 현재 페이지의 12개만 보이고 나머지는 숨깁니다.
    cards.forEach((card,i)=>{
      const start=(page-1)*SIZE;
      card.style.display=(i>=start&&i<start+SIZE)?'':'none';
    });

    // 12개 이하라면 페이지 버튼을 표시하지 않습니다.
    if(total<=1){box.innerHTML='';applying=false;return;}

    box.innerHTML=Array.from({length:total},(_,i)=>{
      const p=i+1;
      return '<button type="button" data-page="'+p+'" class="'+(p===page?'active':'')+'">'+p+'</button>';
    }).join('');

    box.querySelectorAll('button').forEach(button=>button.onclick=()=>{
      page=Number(button.dataset.page);
      apply();
      window.scrollTo({top:grid.offsetTop-90,behavior:'smooth'});
    });
    applying=false;
  }

  // load(), 검색, 카테고리 변경, 관심공연 변경으로 카드가 새로 그려질 때 자동으로 다시 페이지를 계산합니다.
  if(grid){
    new MutationObserver(()=>{
      page=1;
      apply();
    }).observe(grid,{childList:true,subtree:true});
    apply();
  }
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
