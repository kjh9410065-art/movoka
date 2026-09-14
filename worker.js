// MOVOKA Cloudflare Worker
// KOPIS 공연 데이터를 서버에서 받아 프론트에 전달합니다.
// 가져온 공연 목록은 브라우저에 저장하고, 저장된 목록의 화면 표시만 페이지로 나눕니다.

const FETCH_ROWS = 100;

function getYmd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function fetchKopis(api) {
  const response = await fetch(api.toString());
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

async function proxyKopis(api) {
  try {
    const body = await fetchKopis(api);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch (_) {
    return Response.json({ error: 'KOPIS request failed' }, { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 30);

      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service', key);
      api.searchParams.set('stdate', url.searchParams.get('stdate') || getYmd(now));
      api.searchParams.set('eddate', url.searchParams.get('eddate') || getYmd(end));
      api.searchParams.set('cpage', '1');
      api.searchParams.set('rows', String(FETCH_ROWS));
      api.searchParams.set('prfstate', '02');

      const genre = url.searchParams.get('shcate') || '';
      const area = url.searchParams.get('signgucode') || '';
      const keyword = url.searchParams.get('shprfnm') || '';
      if (genre) api.searchParams.set('shcate', genre);
      if (area) api.searchParams.set('signgucode', area);
      if (keyword) api.searchParams.set('shprfnm', keyword);

      return proxyKopis(api);
    }

    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });
      const id = url.searchParams.get('mt20id');
      if (!id || !/^PF\d+$/.test(id)) return Response.json({ error: 'Invalid mt20id' }, { status: 400 });
      const api = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
      api.searchParams.set('service', key);
      return proxyKopis(api);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();

      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');

      // 공연 목록을 가져오면 원본 XML을 브라우저에 저장합니다.
      const storageScript = `<script>
(function(){
  const originalFetch=window.fetch;
  window.fetch=async function(input,init){
    const response=await originalFetch.call(this,input,init);
    try{
      const requestUrl=typeof input==='string'?input:(input&&input.url)||'';
      if(requestUrl.includes('/api/performances')){
        const body=await response.clone().text();
        localStorage.setItem('movoka-performances-cache',JSON.stringify({url:requestUrl,data:body,savedAt:Date.now()}));
        window.dispatchEvent(new Event('movoka-cache-updated'));
      }
    }catch(_){}
    return response;
  };
})();
</script>`;
      html = html.replace('</head>', storageScript + '</head>');

      // 저장된 공연 목록을 12개씩 나눠 표시합니다.
      // 페이지 이동에서는 API를 다시 호출하지 않고 이미 표시된 목록만 전환합니다.
      const paginationScript = `<style>
#movoka-pagination{display:flex;justify-content:center;align-items:center;gap:7px;flex-wrap:wrap;margin:-40px 0 70px}
#movoka-pagination button{min-width:38px;height:38px;padding:0 10px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800}
#movoka-pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}
</style><div id="movoka-pagination"></div><script>
(function(){
  const PAGE_SIZE=12;
  let currentPage=1;
  let renderTimer=null;
  let lastSignature='';

  function getCards(){
    return [...document.querySelectorAll('#grid > .card')];
  }

  function draw(){
    const grid=document.getElementById('grid');
    const box=document.getElementById('movoka-pagination');
    if(!grid||!box)return;

    const cards=getCards();
    const signature=cards.map(x=>x.querySelector('.title')?.textContent||'').join('|');
    if(signature!==lastSignature){
      lastSignature=signature;
      currentPage=1;
    }

    const totalPages=Math.ceil(cards.length/PAGE_SIZE);
    if(totalPages<=1){
      cards.forEach(card=>card.style.display='');
      box.innerHTML='';
      return;
    }

    if(currentPage>totalPages)currentPage=totalPages;

    // 저장된 전체 목록 중 현재 페이지의 12개만 보입니다.
    cards.forEach((card,index)=>{
      const first=(currentPage-1)*PAGE_SIZE;
      card.style.display=index>=first&&index<first+PAGE_SIZE?'':'none';
    });

    box.innerHTML=Array.from({length:totalPages},(_,index)=>{
      const page=index+1;
      return '<button type="button" data-page="'+page+'" class="'+(page===currentPage?'active':'')+'">'+page+'</button>';
    }).join('');

    box.querySelectorAll('button').forEach(button=>button.onclick=function(){
      currentPage=Number(button.dataset.page);
      draw();
      window.scrollTo({top:grid.offsetTop-90,behavior:'smooth'});
    });
  }

  function schedule(){
    clearTimeout(renderTimer);
    renderTimer=setTimeout(draw,50);
  }

  window.addEventListener('load',schedule);
  window.addEventListener('movoka-cache-updated',schedule);

  const gridObserver=new MutationObserver(schedule);
  window.addEventListener('DOMContentLoaded',function(){
    const grid=document.getElementById('grid');
    if(grid)gridObserver.observe(grid,{childList:true,subtree:false});
    schedule();
  });
})();
</script>`;
      html = html.replace('<footer>', paginationScript + '<footer>');

      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(html, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled() {}
};
