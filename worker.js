// MOVOKA Cloudflare Worker
// KOPIS API를 서버에서 중계하고, 메인 화면에 페이지 번호를 추가합니다.

const PAGE_SIZE = 10;

function proxyKopis(api) {
  return fetch(api.toString()).then(async response => {
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }).catch(() => Response.json({ error: 'KOPIS request failed' }, { status: 502 }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    // 공연 목록 API: 페이지 번호와 필터를 그대로 KOPIS에 전달합니다.
    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const end = new Date(now);
      end.setDate(end.getDate() + 30);

      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service', key);
      api.searchParams.set('stdate', url.searchParams.get('stdate') || ymd(now));
      api.searchParams.set('eddate', url.searchParams.get('eddate') || ymd(end));
      api.searchParams.set('cpage', String(Math.max(1, Number(url.searchParams.get('cpage') || 1))));
      api.searchParams.set('rows', String(PAGE_SIZE));
      api.searchParams.set('prfstate', '02');

      const genre = url.searchParams.get('shcate') || '';
      const area = url.searchParams.get('signgucodesub') || url.searchParams.get('signgucode') || '';
      const keyword = url.searchParams.get('shprfnm') || '';
      if (genre) api.searchParams.set('shcate', genre);
      if (area) api.searchParams.set('signgucode', area);
      if (keyword) api.searchParams.set('shprfnm', keyword);

      return proxyKopis(api);
    }

    // 공연 상세 API: 기존 상세보기 기능을 그대로 유지합니다.
    if (url.pathname === '/api/performance') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });
      const id = url.searchParams.get('mt20id');
      if (!id || !/^PF\d+$/.test(id)) return Response.json({ error: 'Invalid mt20id' }, { status: 400 });
      const api = new URL(`https://www.kopis.or.kr/openApi/restful/pblprfr/${encodeURIComponent(id)}`);
      api.searchParams.set('service', key);
      return proxyKopis(api);
    }

    // 메인 HTML은 Static Assets에서 가져온 뒤 페이지네이션 UI를 추가합니다.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      let html = await asset.text();

      // 기존 예매 버튼 문구를 통일합니다.
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');

      // 페이지 번호가 항상 보이도록 CSS를 주입합니다.
      const paginationCss = `<style>
.pagination{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;width:100%;margin:28px 0 50px;padding:0 0 10px}
.pagination button{min-width:40px;height:40px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800;padding:0 12px}
.pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}
.pagination button:disabled{opacity:.4;cursor:default}
.pagination button.nav{font-size:12px}
@media(max-width:480px){.pagination{gap:6px;margin:28px 0 35px}.pagination button{min-width:36px;height:36px;padding:0 8px}.pagination button.nav{padding:0 10px}}
</style>`;
      html = html.replace('</head>', paginationCss + '</head>');

      // footer 바로 앞에 페이지 번호 영역을 넣습니다.
      html = html.replace('<footer>', '<div class="pagination" id="pagination" aria-label="공연 목록 페이지 이동"></div><footer>');

      // 기존 페이지 스크립트가 먼저 실행된 다음 페이지네이션을 연결합니다.
      const paginationScript = `<script>
(function(){
  function filters(){
    var chip=document.querySelector('.chip.active');
    return {
      genre: chip ? (chip.dataset.id || '') : '',
      area: (document.querySelector('#area') || {}).value || '',
      keyword: ((document.querySelector('#q') || {}).value || '').trim()
    };
  }

  function renderPagination(page, hasNext){
    var el=document.querySelector('#pagination');
    if(!el) return;
    var out=[];
    out.push('<button class="nav" '+(page<=1?'disabled':'')+' data-page="'+(page-1)+'">‹ 이전</button>');
    // KOPIS 목록 API가 전체 건수를 제공하지 않는 경우에도 1~10 페이지를 바로 선택할 수 있게 합니다.
    for(var i=1;i<=10;i++){
      out.push('<button class="'+(i===page?'active':'')+'" data-page="'+i+'">'+i+'</button>');
    }
    out.push('<button class="nav" '+(!hasNext?'disabled':'')+' data-page="'+(page+1)+'">다음 ›</button>');
    el.innerHTML=out.join('');
    el.querySelectorAll('[data-page]').forEach(function(button){
      button.onclick=function(){
        if(!button.disabled) loadPage(Number(button.dataset.page));
      };
    });
  }

  function loadPage(page){
    page=Math.max(1,Number(page)||1);
    var grid=document.querySelector('#grid');
    if(!grid) return;
    grid.innerHTML='<div class="empty">공연 정보를 불러오는 중입니다.</div>';
    var f=filters();
    var params=new URLSearchParams({rows:'10',cpage:String(page)});
    if(f.genre) params.set('shcate',f.genre);
    if(f.area) params.set('signgucodesub',f.area);
    if(f.keyword) params.set('shprfnm',f.keyword);

    fetch('/api/performances?'+params.toString())
      .then(function(response){if(!response.ok) throw new Error(); return response.text();})
      .then(function(xml){
        var doc=new DOMParser().parseFromString(xml,'text/xml');
        var dbs=doc.querySelectorAll('db');
        var items=[];
        dbs.forEach(function(node){
          items.push({
            mt20id: node.querySelector('mt20id')?.textContent || '',
            prfnm: node.querySelector('prfnm')?.textContent || '',
            prfpdfrom: node.querySelector('prfpdfrom')?.textContent || '',
            prfpdto: node.querySelector('prfpdto')?.textContent || '',
            fcltynm: node.querySelector('fcltynm')?.textContent || '',
            poster: node.querySelector('poster')?.textContent || '',
            genrenm: node.querySelector('genrenm')?.textContent || '',
            prfcast: node.querySelector('prfcast')?.textContent || '',
            prfurl: node.querySelector('prfurl')?.textContent || ''
          });
        });
        // 기존 index.html의 카드 렌더러를 재사용합니다.
        if(typeof lastItems !== 'undefined') lastItems=items;
        if(typeof renderItems === 'function') renderItems(items);
        else grid.innerHTML='<div class="empty">공연 정보를 표시하지 못했습니다.</div>';
        renderPagination(page, items.length === 10);
        window.scrollTo({top:0,behavior:'smooth'});
      })
      .catch(function(){
        grid.innerHTML='<div class="empty">공연 정보를 불러오지 못했습니다.</div>';
        var el=document.querySelector('#pagination');
        if(el) el.innerHTML='';
      });
  }

  // 외부에서 페이지 이동을 호출할 수 있도록 공개합니다.
  window.movokaLoadPage=loadPage;

  // 원본 페이지의 초기 로딩이 끝난 뒤 페이지네이션을 표시합니다.
  window.addEventListener('load',function(){setTimeout(function(){loadPage(1);},50);});
})();
</script>`;
      html = html.replace('</body>', paginationScript + '</body>');

      const headers = new Headers(asset.headers);
      headers.delete('Content-Length');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(html, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  },

  // Cron은 현재 별도 데이터 스냅샷을 사용하지 않으므로 요청만 성공적으로 처리합니다.
  async scheduled() {}
};
