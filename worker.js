// MOVOKA Cloudflare Worker
// KOPIS API 요청은 서버에서 처리하고, 기본 공연 목록은 하루 한 번 캐시로 갱신합니다.

const SNAPSHOT_PREFIX = 'https://movoka-cache.local/v4/performances/snapshot/';
const SNAPSHOT_TTL_DAYS = 7;
const PAGE_SIZE = 10;

function snapshotKey(date) { return `${SNAPSHOT_PREFIX}${date}`; }
function dateStamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    if (url.pathname === '/api/performances') {
      if (!key) return Response.json({ error: 'KOPIS_API_KEY is not configured' }, { status: 500 });

      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const startDate = url.searchParams.get('stdate') || ymd(now);
      const endObj = new Date(now);
      endObj.setDate(endObj.getDate() + 30);
      const endDate = url.searchParams.get('eddate') || ymd(endObj);
      const page = Math.max(1, Number(url.searchParams.get('cpage') || 1));
      const requestedRows = Math.min(100, Math.max(1, Number(url.searchParams.get('rows') || PAGE_SIZE)));
      const rows = Math.min(PAGE_SIZE, requestedRows);
      const genre = url.searchParams.get('shcate') || '';
      const area = url.searchParams.get('signgucodesub') || url.searchParams.get('signgucode') || '';
      const keyword = url.searchParams.get('shprfnm') || '';

      // 전체 탭은 장르 조건 없이 KOPIS 전체 공연을 조회합니다.
      const isDefault = !genre && !area && !keyword && page === 1 && !url.searchParams.has('stdate') && !url.searchParams.has('eddate');
      if (isDefault) {
        const latest = await findLatestSnapshot();
        if (latest) return latest;
      }

      const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
      api.searchParams.set('service', key);
      api.searchParams.set('stdate', startDate);
      api.searchParams.set('eddate', endDate);
      api.searchParams.set('cpage', String(page));
      api.searchParams.set('rows', String(rows));
      api.searchParams.set('prfstate', '02');
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

      // 버튼 문구를 예매 사이트로 통일합니다.
      html = html.replace(/(<button[^>]*class=["'][^"']*ticket[^"']*["'][^>]*>)(예매|예매처 비교|예매 사이트)(<\/button>)/gi, '$1예매 사이트$3');
      html = html.replace(/>(예매|예매처 비교)<\/button>/g, '>예매 사이트</button>');
      html = html.replace("new URLSearchParams({rows:'100'})", `new URLSearchParams({rows:'${PAGE_SIZE}'})`);

      // 광고 영역은 실제 광고 요소가 들어오기 전까지 숨겨 둡니다.
      html = html.replace('</style></head>', `.ad-slot{display:none;width:100%;min-height:90px;margin:0 0 24px;align-items:center;justify-content:center;overflow:hidden}.ad-slot.has-ad{display:flex}.ad-slot ins,.ad-slot iframe{max-width:100%;display:block}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;width:100%;margin:0 0 50px;padding:0 0 10px}.pagination button{min-width:40px;height:40px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;cursor:pointer;font-weight:800;padding:0 12px}.pagination button.active{background:var(--primary);border-color:var(--primary);color:#fff}.pagination button:disabled{opacity:.4;cursor:default}.pagination button.nav{font-size:12px}@media(max-width:480px){.ad-slot{min-height:60px;margin-bottom:18px}.pagination{gap:6px;margin-bottom:35px}.pagination button{min-width:36px;height:36px;padding:0 8px}.pagination button.nav{font-size:12px;padding:0 10px}}` + '</style></head>');
      html = html.replace('<div class="toolbar">', '<div class="ad-slot" id="ad-top" data-ad-slot="top" aria-label="광고"></div><div class="toolbar">');
      html = html.replace('<footer>', '<div class="ad-slot" id="ad-bottom" data-ad-slot="bottom" aria-label="광고"></div><footer>');

      // 목록 아래에 페이지 이동 영역을 항상 삽입합니다.
      html = html.replace('</main>', '<div class="pagination" id="pagination" aria-label="공연 목록 페이지 이동"></div></main>');

      // 기존 load() 이벤트와 충돌하지 않도록 페이지네이션용 로더가 검색/카테고리/지역 변경도 직접 처리합니다.
      const paginationScript = `<script>
(function(){
  var currentPage = 1;

  function loadPage(page){
    currentPage = Math.max(1, Number(page) || 1);
    var grid = document.querySelector('#grid');
    var count = document.querySelector('#count');
    var pagination = document.querySelector('#pagination');
    if (!grid) return;

    grid.innerHTML = '<div class="empty">공연 정보를 불러오는 중입니다.</div>';

    var params = new URLSearchParams({rows: '10', cpage: String(currentPage)});
    var active = Array.from(document.querySelectorAll('.chip')).find(function(b){ return b.classList.contains('active'); });
    var genre = active ? (active.dataset.id || '') : '';
    var area = document.querySelector('#area') ? document.querySelector('#area').value : '';
    var keyword = document.querySelector('#q') ? document.querySelector('#q').value.trim() : '';

    if (genre) params.set('shcate', genre);
    if (area) params.set('signgucodesub', area);
    if (keyword) params.set('shprfnm', keyword);

    fetch('/api/performances?' + params.toString())
      .then(function(r){ if (!r.ok) throw new Error('request failed'); return r.text(); })
      .then(function(xml){
        var items = typeof parse === 'function' ? parse(xml) : [];
        if (typeof lastItems !== 'undefined') lastItems = items;
        if (typeof renderItems === 'function') renderItems(items);

        var doc = new DOMParser().parseFromString(xml, 'text/xml');
        var total = Number(doc.querySelector('totalcount') ? doc.querySelector('totalcount').textContent : 0);
        var totalPages = total ? Math.max(1, Math.ceil(total / 10)) : (items.length === 10 ? currentPage + 1 : currentPage);

        renderPagination(totalPages);
        if (count) count.textContent = '공연 ' + (total || items.length).toLocaleString() + '개';
      })
      .catch(function(){
        if (count) count.textContent = '';
        grid.innerHTML = '<div class="empty">공연 정보를 불러오지 못했습니다.</div>';
        if (pagination) pagination.innerHTML = '';
      });
  }

  function renderPagination(totalPages){
    var el = document.querySelector('#pagination');
    if (!el) return;
    if (totalPages <= 1) { el.innerHTML = ''; return; }

    // 페이지 번호는 10개 단위로 묶고, 이전/다음 버튼은 한 페이지(공연 10개)씩 이동합니다.
    var start = Math.max(1, Math.floor((currentPage - 1) / 10) * 10 + 1);
    var end = Math.min(totalPages, start + 9);
    var out = [];

    out.push('<button class="nav" ' + (currentPage === 1 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '">‹ 이전 10개</button>');
    for (var i = start; i <= end; i++) {
      out.push('<button class="' + (i === currentPage ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>');
    }
    out.push('<button class="nav" ' + (currentPage === totalPages ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '">다음 10개 ›</button>');

    el.innerHTML = out.join('');
    el.querySelectorAll('button[data-page]').forEach(function(button){
      button.onclick = function(){ if (!button.disabled) loadPage(Number(button.dataset.page)); };
    });
  }

  // 원본 페이지의 이벤트를 페이지네이션 로더로 교체해 필터를 바꿔도 1페이지부터 정상 갱신되게 합니다.
  document.querySelectorAll('.chip').forEach(function(button){
    button.onclick = function(){
      document.querySelectorAll('.chip').forEach(function(x){ x.classList.toggle('active', x === button); });
      loadPage(1);
    };
  });
  var go = document.querySelector('#go');
  if (go) go.onclick = function(){ loadPage(1); };
  var area = document.querySelector('#area');
  if (area) area.onchange = function(){ loadPage(1); };
  var q = document.querySelector('#q');
  if (q) q.onkeydown = function(e){ if (e.key === 'Enter') loadPage(1); };

  window.movokaLoadPage = loadPage;
  loadPage(1);
})();
</script>`;

      // </body> 앞에 직접 삽입해 기존 스크립트의 공백/줄바꿈 여부와 무관하게 실행되게 합니다.
      html = html.replace('</body>', paginationScript + '</body>');

      // 광고 슬롯은 광고 요소가 실제로 들어왔을 때만 표시합니다.
      const adScript = `<script>(function(){function refresh(){document.querySelectorAll('.ad-slot').forEach(function(s){s.classList.toggle('has-ad',!!s.querySelector('ins,iframe,img,a,[data-ad-loaded]'));});}refresh();new MutationObserver(refresh).observe(document.body,{childList:true,subtree:true});})();</script>`;
      html = html.replace('</body>', adScript + '</body>');

      return new Response(html, { status: asset.status, headers: asset.headers });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    if (!env.KOPIS_API_KEY) return;
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const end = new Date(now);
    end.setDate(end.getDate() + 30);

    const api = new URL('https://www.kopis.or.kr/openApi/restful/pblprfr');
    api.searchParams.set('service', env.KOPIS_API_KEY);
    api.searchParams.set('stdate', ymd(now));
    api.searchParams.set('eddate', ymd(end));
    api.searchParams.set('cpage', '1');
    api.searchParams.set('rows', String(PAGE_SIZE));
    api.searchParams.set('prfstate', '02');
    ctx.waitUntil(refreshSnapshot(api, env.KOPIS_API_KEY, now));
  }
};

async function findLatestSnapshot(){
  for (let age = 0; age <= SNAPSHOT_TTL_DAYS; age++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - age);
    const cached = await caches.default.match(snapshotKey(dateStamp(d)));
    if (cached) return cached;
  }
  return null;
}

async function refreshSnapshot(api, key, now){
  const response = await proxyKopis(api);
  if (!response.ok) return;
  const snapshot = new Response(await response.clone().text(), {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${SNAPSHOT_TTL_DAYS * 86400}`
    }
  });
  await caches.default.put(snapshotKey(dateStamp(now)), snapshot);
  const expired = new Date(now);
  expired.setUTCDate(expired.getUTCDate() - (SNAPSHOT_TTL_DAYS + 1));
  await caches.default.delete(snapshotKey(dateStamp(expired)));
}

async function proxyKopis(api){
  try {
    const response = await fetch(api.toString());
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return Response.json({ error: 'KOPIS request failed' }, { status: 502 });
  }
}
