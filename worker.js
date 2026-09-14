// MOVOKA Cloudflare Worker
// KOPIS 데이터를 서버에서 모은 뒤, 브라우저에서는 12개씩 페이지로 나눠 보여줍니다.

const FETCH_ROWS = 100;
const PAGE_SIZE = 12;
const ALL_GENRES = ['AAAA', 'GGGA', 'CCCA', 'CCCC', 'CCCD', 'BBBC', 'BBBR', 'EEEB', 'EEEA', 'KID'];

// KOPIS 한 페이지를 가져옵니다.
async function fetchKopisPage(api) {
  const response = await fetch(api.toString());
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}`);
  return response.text();
}

// KOPIS XML에서 공연 <db> 블록만 뽑습니다.
function extractDbBlocks(xml) {
  return xml.match(/<db>[\s\S]*?<\/db>/g) || [];
}

// KOPIS 목록을 가져옵니다.
// 전체 탭은 모든 장르를 각각 조회해서 합치므로 한 장르에 데이터가 몰려도 빠지지 않습니다.
async function getPerformances(key, params) {
  const makeApi = genre => {
    const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
    api.searchParams.set('service', key);
    api.searchParams.set('stdate', params.get('stdate') || getYmd(new Date()));

    const end = new Date();
    end.setDate(end.getDate() + 30);
    api.searchParams.set('eddate', params.get('eddate') || getYmd(end));
    api.searchParams.set('cpage', '1');
    api.searchParams.set('rows', String(FETCH_ROWS));
    api.searchParams.set('prfstate', '02');

    if (genre) api.searchParams.set('shcate', genre);
    if (params.get('signgucode')) api.searchParams.set('signgucode', params.get('signgucode'));
    if (params.get('shprfnm')) api.searchParams.set('shprfnm', params.get('shprfnm'));
    return api;
  };

  const genre = params.get('shcate') || '';
  let blocks = [];

  if (genre) {
    // 특정 카테고리는 해당 카테고리만 조회합니다.
    blocks = extractDbBlocks(await fetchKopisPage(makeApi(genre)));
  } else {
    // 전체는 모든 카테고리를 순서대로 조회합니다.
    // 동시에 10개를 요청하지 않아 KOPIS/Cloudflare 요청 실패 가능성을 줄입니다.
    for (const code of ALL_GENRES) {
      try {
        const xml = await fetchKopisPage(makeApi(code));
        blocks.push(...extractDbBlocks(xml));
      } catch (_) {
        // 한 카테고리가 일시적으로 실패해도 다른 카테고리는 계속 표시합니다.
      }
    }
  }

  // 같은 공연이 여러 카테고리에 잡히는 경우 mt20id 기준으로 중복 제거합니다.
  const seen = new Set();
  blocks = blocks.filter(block => {
    const match = block.match(/<mt20id>([\s\S]*?)<\/mt20id>/);
    const id = match ? match[1].trim() : '';
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (!blocks.length) throw new Error('No KOPIS performances');
  return `<dbs>${blocks.join('')}</dbs>`;
}

function getYmd(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function proxyKopis(api) {
  try {
    const body = await fetchKopisPage(api);
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

    // 공연 목록 API
    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

      try {
        const xml = await getPerformances(key, url.searchParams);
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
      } catch (_) {
        return Response.json({ error: 'KOPIS request failed' }, { status: 502 });
      }
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

      // 페이지네이션 스타일
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

      // 공연 목록 바로 아래에 페이지 번호 영역을 넣습니다.
      html = html.replace('</section></main>', '</section><div id="pagination" aria-label="공연 목록 페이지 이동"></div></main>');
      // 위 구조가 다른 경우에도 footer 앞에 삽입되도록 보완합니다.
      if (!html.includes('id="pagination"')) {
        html = html.replace('<footer>', '<div id="pagination" aria-label="공연 목록 페이지 이동"></div><footer>');
      }

      const paginationScript = `<script>
(function(){
  const PAGE_SIZE = 12;
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

  async function loadAll(){
    const token = ++requestToken;
    const grid = document.querySelector('#grid');
    const pagination = document.querySelector('#pagination');
    if (!grid) return;

    grid.innerHTML = '<div class="empty">공연 정보를 불러오는 중입니다.</div>';
    if (pagination) pagination.innerHTML = '';

    const f = getFilters();
    const params = new URLSearchParams({ rows:'100', cpage:'1' });
    if (f.genre) params.set('shcate', f.genre);
    if (f.area) params.set('signgucode', f.area);
    if (f.keyword) params.set('shprfnm', f.keyword);

    try {
      const response = await fetch('/api/performances?' + params.toString());
      if (!response.ok) throw new Error('KOPIS request failed');
      const xml = await response.text();
      if (token !== requestToken) return;

      allItems = parseItems(xml);
      currentPage = 1;
      renderPage();
    } catch (_) {
      if (token !== requestToken) return;
      grid.innerHTML = '<div class="empty">공연 정보를 불러오지 못했습니다.</div>';
    }
  }

  function renderPage(){
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = allItems.slice(start, start + PAGE_SIZE);

    // 기존 카드 렌더러를 그대로 사용합니다.
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

    // 페이지 번호 자체는 10개씩 묶고, 공연은 항상 12개씩 표시합니다.
    const groupSize = window.innerWidth <= 480 ? 5 : 10;
    const groupStart = Math.floor((currentPage - 1) / groupSize) * groupSize + 1;
    const groupEnd = Math.min(totalPages, groupStart + groupSize - 1);
    let out = '<button class="nav" data-page="'+(currentPage-1)+'" '+(currentPage===1?'disabled':'')+'>‹ 이전</button>';
    out += '<div class="page-list">';
    for(let i=groupStart;i<=groupEnd;i++) {
      out += '<button class="'+(i===currentPage?'active':'')+'" data-page="'+i+'">'+i+'</button>';
    }
    out += '</div><button class="nav" data-page="'+(currentPage+1)+'" '+(currentPage===totalPages?'disabled':'')+'>다음 ›</button>';
    el.innerHTML = out;

    el.querySelectorAll('[data-page]').forEach(button => {
      button.onclick = () => {
        if (button.disabled) return;
        currentPage = Number(button.dataset.page);
        renderPage();
        window.scrollTo({top:0, behavior:'smooth'});
      };
    });
  }

  function interceptClick(element, handler){
    if (!element) return;
    element.addEventListener('click', function(e){
      e.preventDefault();
      e.stopImmediatePropagation();
      handler(e);
    }, true);
  }

  window.addEventListener('load', () => {
    // 기존 이벤트보다 먼저 필터 변경을 가로채 새 전체 데이터를 다시 가져옵니다.
    document.querySelectorAll('.chip').forEach(button => {
      button.addEventListener('click', e => {
        e.preventDefault();
        e.stopImmediatePropagation();
        document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === button));
        active = button.dataset.id || '';
        showFav = false;
        const fav = document.querySelector('#favFilter');
        if (fav) fav.classList.remove('active');
        loadAll();
      }, true);
    });

    interceptClick(document.querySelector('#go'), loadAll);

    const q = document.querySelector('#q');
    if (q) q.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        loadAll();
      }
    }, true);

    const area = document.querySelector('#area');
    if (area) area.addEventListener('change', e => {
      e.stopImmediatePropagation();
      loadAll();
    }, true);

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
