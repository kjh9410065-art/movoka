// MOVOKA Cloudflare Worker
// KOPIS 공연 데이터를 충분히 가져온 뒤, 화면에서는 12개씩 나눠 보여줍니다.

const FETCH_ROWS = 100;
const PAGE_SIZE = 12;

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

    // 공연 목록 API: 한 번에 최대 100개를 가져옵니다.
    // 실제 화면의 12개 페이지 분할은 브라우저에서 처리합니다.
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

    // 공연 상세 API
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

      // 예매 버튼 문구 통일
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');

      // 페이지 번호 스타일
      const paginationCss = `<style>
#pagination{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;width:100%;margin:0 0 50px;padding:0 8px}
#pagination .page-list{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center}
#pagination button{min-width:40px;height:40px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800;padding:0 10px}
#pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}
#pagination button:disabled{opacity:.35;cursor:default}
#pagination .nav{padding:0 13px}
@media(max-width:480px){#pagination{gap:5px;margin-bottom:35px}#pagination .page-list{gap:4px}#pagination button{min-width:36px;height:36px;padding:0 8px;font-size:13px}#pagination .nav{padding:0 9px;font-size:12px}}
</style>`;
      html = html.replace('</head>', paginationCss + '</head>');

      // 공연 목록 아래에 페이지 번호를 삽입
      html = html.replace('<footer>', '<div id="pagination" aria-label="공연 목록 페이지 이동"></div><footer>');

      // 기존 index.html의 load()를 덮어쓰고, 전체 카테고리는 모든 장르를 합쳐서 가져옵니다.
      const paginationScript = `<script>
(function(){
  const PAGE_SIZE = 12;
  const ALL_GENRES = ['', 'AAAA', 'GGGA', 'CCCA', 'CCCC', 'CCCD', 'BBBC', 'BBBR', 'EEEB', 'EEEA', 'KID'];
  let allItems = [];
  let currentPage = 1;
  let requestToken = 0;

  function getFilters(){
    const chip = document.querySelector('.chip.active');
    return {
      genre: chip ? (chip.dataset.id || '') : '',
      area: (document.querySelector('#area') || {}).value || '',
      keyword: ((document.querySelector('#q') || {}).value || '').trim()
    };
  }

  function parseItems(xml){
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return [...doc.querySelectorAll('db')].map(n => Object.fromEntries(
      ['mt20id','prfnm','prfpdfrom','prfpdto','fcltynm','poster','genrenm','prfcast','prfurl']
        .map(k => [k, n.querySelector(k)?.textContent || ''])
    ));
  }

  async function fetchGenre(genre, filters){
    const p = new URLSearchParams({ rows:'100', cpage:'1' });
    if (genre) p.set('shcate', genre);
    if (filters.area) p.set('signgucode', filters.area);
    if (filters.keyword) p.set('shprfnm', filters.keyword);
    const response = await fetch('/api/performances?' + p.toString());
    if (!response.ok) throw new Error('KOPIS request failed');
    return parseItems(await response.text());
  }

  async function loadAll(){
    const token = ++requestToken;
    const grid = document.querySelector('#grid');
    const pagination = document.querySelector('#pagination');
    if (!grid) return;

    grid.innerHTML = '<div class="empty">공연 정보를 불러오는 중입니다.</div>';
    if (pagination) pagination.innerHTML = '';

    const filters = getFilters();
    let items = [];

    try {
      if (filters.genre) {
        // 특정 카테고리: 해당 카테고리 데이터를 최대 100개 가져옵니다.
        items = await fetchGenre(filters.genre, filters);
      } else {
        // 전체: 모든 카테고리 데이터를 각각 가져와 하나의 목록으로 합칩니다.
        const results = await Promise.all(ALL_GENRES.slice(1).map(genre => fetchGenre(genre, filters)));
        const seen = new Set();
        results.flat().forEach(item => {
          if (item.mt20id && !seen.has(item.mt20id)) {
            seen.add(item.mt20id);
            items.push(item);
          }
        });
      }

      if (token !== requestToken) return;

      allItems = items;
      currentPage = 1;
      renderPage();
    } catch (error) {
      if (token !== requestToken) return;
      grid.innerHTML = '<div class="empty">공연 정보를 불러오지 못했습니다.</div>';
    }
  }

  function renderPage(){
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = allItems.slice(start, start + PAGE_SIZE);

    // 기존 카드 렌더러를 사용하므로 상세보기/즐겨찾기 기능은 그대로 유지됩니다.
    if (typeof lastItems !== 'undefined') lastItems = pageItems;
    if (typeof renderItems === 'function') renderItems(pageItems);

    renderPagination();
  }

  function renderPagination(){
    const el = document.querySelector('#pagination');
    if (!el) return;

    const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
    if (totalPages <= 1) {
      el.innerHTML = '';
      return;
    }

    // 페이지 수가 많아져도 번호가 무한히 늘어나지 않도록 10개씩 묶습니다.
    const groupSize = window.innerWidth <= 480 ? 5 : 10;
    const groupStart = Math.floor((currentPage - 1) / groupSize) * groupSize + 1;
    const groupEnd = Math.min(totalPages, groupStart + groupSize - 1);
    let html = '';

    html += '<button class="nav" data-page="'+(currentPage-1)+'" '+(currentPage===1?'disabled':'')+'>‹ 이전</button>';
    html += '<div class="page-list">';
    for(let i=groupStart; i<=groupEnd; i++) {
      html += '<button class="'+(i===currentPage?'active':'')+'" data-page="'+i+'">'+i+'</button>';
    }
    html += '</div>';
    html += '<button class="nav" data-page="'+(currentPage+1)+'" '+(currentPage===totalPages?'disabled':'')+'>다음 ›</button>';

    el.innerHTML = html;
    el.querySelectorAll('[data-page]').forEach(button => {
      button.onclick = () => {
        if (button.disabled) return;
        currentPage = Number(button.dataset.page);
        renderPage();
        window.scrollTo({top:0, behavior:'smooth'});
      };
    });
  }

  function reloadFromFilter(e){
    e.stopImmediatePropagation();
    loadAll();
  }

  window.addEventListener('load', () => {
    // 기존 onclick보다 먼저 동작하도록 캡처 단계에서 필터 이벤트를 가로챕니다.
    document.querySelectorAll('.chip').forEach(button => {
      button.addEventListener('click', e => {
        e.stopImmediatePropagation();
        document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === button));
        if (typeof active !== 'undefined') active = button.dataset.id || '';
        showFav = false;
        const fav = document.querySelector('#favFilter');
        if (fav) fav.classList.remove('active');
        loadAll();
      }, true);
    });

    const go = document.querySelector('#go');
    if (go) go.addEventListener('click', reloadFromFilter, true);

    const q = document.querySelector('#q');
    if (q) q.addEventListener('keydown', e => {
      if (e.key === 'Enter') reloadFromFilter(e);
    }, true);

    const area = document.querySelector('#area');
    if (area) area.addEventListener('change', reloadFromFilter, true);

    loadAll();
  });

  window.addEventListener('resize', () => {
    if (allItems.length > PAGE_SIZE) renderPagination();
  });
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

  async scheduled() {}
};
