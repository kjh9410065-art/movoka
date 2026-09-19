// MOVOKA Worker - KOPIS 공연 데이터 관리
const KOPIS_BASE = 'http://www.kopis.or.kr/openApi/restful/pblprfr';
const ROWS = 100;

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// KOPIS 목록 XML을 공연 객체 배열로 변환합니다.
function parseList(xml) {
  const matches = xml.match(/<db>[\s\S]*?<\/db>/g) || [];
  return matches.map(db => {
    const get = tag => db.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() || '';
    const state = get('prfstate');
    return {
      mt20id: get('mt20id'),
      prfnm: get('prfnm'),
      prfpdfrom: get('prfpdfrom'),
      prfpdto: get('prfpdto'),
      fcltynm: get('fcltynm'),
      poster: get('poster'),
      genrenm: get('genrenm'),
      prfcast: get('prfcast'),
      prfstate: state === '공연중' ? '02' : state === '공연예정' ? '01' : state,
      area: get('area'),
      prfurl: get('prfurl')
    };
  }).filter(x => x.mt20id);
}

// KOPIS API를 호출하고 XML 응답 형식을 검증합니다.
async function callKopis(url) {
  const response = await fetch(url.toString(), { redirect: 'follow' });
  const text = await response.text();
  if (!response.ok) throw new Error(`KOPIS HTTP ${response.status}: ${text.slice(0, 300)}`);
  if (!text.includes('<dbs') && !text.includes('<db>')) throw new Error(`KOPIS 응답 형식 오류: ${text.slice(0, 300)}`);
  return text;
}

// 목록 API URL에 페이지와 날짜 조건을 붙입니다.
function makeListUrl(requestUrl, key, page, rows) {
  const target = new URL(KOPIS_BASE, requestUrl);
  target.searchParams.set('service', key);
  target.searchParams.set('stdate', requestUrl.searchParams.get('stdate') || ymd(new Date()));
  target.searchParams.set('eddate', requestUrl.searchParams.get('eddate') || ymd(new Date()));
  target.searchParams.set('cpage', String(page));
  target.searchParams.set('rows', String(rows));
  target.searchParams.set('sharea', requestUrl.searchParams.get('sharea') || '');
  target.searchParams.set('shcate', requestUrl.searchParams.get('shcate') || '');
  return target;
}

// 외부 예매 URL을 안전한 HTTP/HTTPS 주소로 정규화합니다.
function normalizeBookingUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

// 목록 표시 단계에서는 예매사이트에 실제 접속하지 않아 지연을 만들지 않습니다.
async function isReachable(url) {
  return Boolean(normalizeBookingUrl(url));
}

// KOPIS 상세 XML의 예매처를 중복 제거하고 정상 URL만 남깁니다.
async function cleanBookingSites(xml) {
  const block = xml.match(/<relates>[\s\S]*?<\/relates>/)?.[0];
  if (!block) return xml;

  const pairs = [];
  const pairRegex = /<relatenm>([\s\S]*?)<\/relatenm>[\s\S]*?<relateurl>([\s\S]*?)<\/relateurl>/g;

  for (const match of block.matchAll(pairRegex)) {
    const name = match[1].trim();
    const url = normalizeBookingUrl(match[2]);
    if (!url) continue;
    pairs.push({ name, url });
  }

  const seenHosts = new Set();
  const valid = [];

  for (const site of pairs) {
    try {
      const host = new URL(site.url).hostname.replace(/^www\./, '').toLowerCase();
      if (seenHosts.has(host)) continue;
      if (!(await isReachable(site.url))) continue;
      seenHosts.add(host);
      valid.push(site);
    } catch {}
  }

  const cleanBlock = `<relates>${valid.map(site => `<relatenm>${site.name}</relatenm><relateurl>${site.url}</relateurl>`).join('')}</relates>`;
  return xml.replace(block, cleanBlock);
}

// HTML에 넣을 문자열을 안전하게 이스케이프합니다.
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  }[char]));
}

// 공연 상세 페이지용 기본 템플릿을 생성합니다.
function renderPerformancePage(item, detail = {}) {
  const title = escHtml(item.prfnm || '공연정보');
  const description = escHtml(`${item.prfnm || '공연'} | ${item.prfpdfrom || ''} ~ ${item.prfpdto || ''} | ${item.fcltynm || ''} - MOVOKA 공연정보`);
  const poster = item.poster ? `<meta property="og:image" content="${escHtml(item.poster)}">\n` : '';
  const status = item.prfstate === '02' ? '현재 공연' : '공연 예정';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | MOVOKA</title>
<meta name="description" content="${description}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://movoka.tcflick.com/performance/${encodeURIComponent(item.mt20id)}">
<meta property="og:title" content="${title} | MOVOKA">
<meta property="og:description" content="${description}">
${poster}<style>
*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:#171923;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.wrap{max-width:760px;margin:auto;padding:32px 18px 60px}.back{display:inline-block;color:#5b5bd6;text-decoration:none;font-weight:800}.card{background:#fff;border:1px solid #e5e7ee;border-radius:18px;padding:20px}.poster{max-width:280px;margin:auto}.poster img{display:block;width:100%;border-radius:12px}.tag{margin-top:20px;color:#5b5bd6;font-weight:800}.h1{font-size:32px;line-height:1.3;margin:8px 0 20px}.meta{line-height:1.9;color:#5f6575}.cast{margin-top:20px;padding-top:20px;border-top:1px solid #eee}.detail-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.action-btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 16px;border-radius:10px;border:1px solid #ddd;background:#fff;color:inherit;text-decoration:none;font-weight:800;cursor:pointer}.action-btn.primary{background:#5b5bd6;color:#fff;border-color:#5b5bd6}.theme-btn{border:1px solid #ddd;background:#fff;color:inherit;border-radius:10px;padding:9px 12px;font-weight:800;cursor:pointer}.booking-list{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:20px;z-index:20}.booking-box{width:min(420px,100%);background:#fff;color:#171923;border-radius:16px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.2)}.booking-box h3{margin:0 0 14px}.booking-links{display:grid;gap:9px}.booking-links button{width:100%;padding:12px;border:1px solid #ddd;background:#fff;color:inherit;border-radius:10px;text-align:left;font-weight:700;cursor:pointer}.booking-close{margin-top:12px;width:100%;padding:10px;border:0;border-radius:10px;background:#f1f2f6;color:inherit;cursor:pointer}.dark{background:#15171c;color:#f1f3f6}.dark .card,.dark .booking-box{background:#20232a;color:#f1f3f6;border-color:#343944}.dark .meta{color:#b8becb}.dark .cast{border-color:#343944}.dark .action-btn,.dark .theme-btn,.dark .booking-links button{background:#252932;color:#f1f3f6;border-color:#3a3f4b}.synopsis-box{margin-top:16px;padding:16px;border:1px solid #e5e7ee;border-radius:12px;line-height:1.8}.dark .synopsis-box{border-color:#343944}.dark .booking-close{background:#30343d}
</style>
</head>
<body><main class="wrap">
<div class="topbar"><a class="back" href="/">← MOVOKA 공연 목록</a><button class="theme-btn" id="themeToggle" type="button">🌙 다크모드</button></div>
<article class="card">
${item.poster ? `<div class="poster"><img src="${escHtml(item.poster)}" alt="${title} 포스터"></div>` : ''}
<div class="tag">${escHtml(status)} · ${escHtml(item.genrenm || '공연')}</div>
<h1 class="h1">${title}</h1>
<div class="meta">
<strong>공연기간</strong><br>${escHtml(item.prfpdfrom)} ~ ${escHtml(item.prfpdto)}<br>
<strong>공연장</strong><br>${escHtml(item.fcltynm || '정보 없음')}<br>
<strong>지역</strong><br>${escHtml(item.area || '정보 없음')}
</div>
${item.prfcast ? `<div class="cast"><strong>출연진</strong><br>${escHtml(item.prfcast)}</div>` : ''}
<div class="detail-actions"><button class="action-btn primary" type="button" onclick="openSynopsis()">줄거리</button><button class="action-btn primary" type="button" onclick="openBookingFor('${escHtml(item.mt20id)}')">예매사이트</button><a class="action-btn" href="/">다른 공연 찾아보기</a></div>
<div class="synopsis-box" id="synopsisBox" style="display:none"><strong>줄거리</strong><div id="synopsisText" style="margin-top:10px;line-height:1.8">${detail.sty ? escHtml(detail.sty).replace(/\n/g, '<br>') : '등록된 줄거리 정보가 없습니다.'}</div></div>
</article>
<div class="booking-list" id="bookingList" onclick="if(event.target===this)closeBookingList()"><div class="booking-box"><h3>예매사이트 선택</h3><div class="booking-links" id="bookingLinks"></div><button class="booking-close" onclick="closeBookingList()">닫기</button></div></div>
<script>
/* 버튼으로만 다크모드를 전환하고 선택값을 저장합니다. */
(function(){const key='movoka-theme';const apply=mode=>{document.body.classList.toggle('dark',mode==='dark');const b=document.getElementById('themeToggle');if(b)b.textContent=mode==='dark'?'☀️ 라이트모드':'🌙 다크모드';};apply(localStorage.getItem(key)||'light');document.getElementById('themeToggle').onclick=()=>{const next=document.body.classList.contains('dark')?'light':'dark';localStorage.setItem(key,next);apply(next);};})();

/* 줄거리 버튼을 눌렀을 때만 내용을 펼칩니다. */
function openSynopsis(){const box=document.getElementById('synopsisBox');if(!box)return;const willOpen=box.style.display==='none';box.style.display=willOpen?'block':'none';}

/* 상세 페이지에서도 KOPIS 예매처를 불러옵니다. */
async function openBookingFor(id){try{const r=await fetch('/api/performance?mt20id='+encodeURIComponent(id),{cache:'force-cache'});const text=await r.text();if(!r.ok)throw new Error('예매사이트 정보를 불러오지 못했습니다.');const doc=new DOMParser().parseFromString(text,'text/xml');const names=Array.from(doc.querySelectorAll('relatenm')).map(x=>x.textContent.trim());const urls=Array.from(doc.querySelectorAll('relateurl')).map(x=>x.textContent.trim());const links=urls.map((url,i)=>({name:names[i]||'예매사이트',url})).filter(x=>/^https?:\\/\\//.test(x.url));if(!links.length)throw new Error('등록된 외부 예매사이트가 없습니다.');document.getElementById('bookingLinks').innerHTML=links.map(x=>'<button type="button" onclick="window.open(\\''+x.url.replace(/'/g,'%27')+'\\',\\'_blank\\',\\'noopener,noreferrer\\');closeBookingList()">'+x.name.replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))+'</button>').join('');document.getElementById('bookingList').style.display='flex';}catch(e){alert(e.message||'예매사이트 정보를 불러오지 못했습니다.');}}
function closeBookingList(){document.getElementById('bookingList').style.display='none';}
</script>
<footer style="margin-top:24px;color:#73798a;font-size:13px">
<a href="/terms.html" style="color:#5b5bd6;text-decoration:none;font-weight:700">이용약관</a> ·
<a href="/privacy.html" style="color:#5b5bd6;text-decoration:none;font-weight:700">개인정보처리방침</a> ·
<a href="/contact.html" style="color:#5b5bd6;text-decoration:none;font-weight:700">문의하기</a>
</footer>
</main></body></html>`;
}

// KOPIS 상세 XML에서 줄거리(sty)와 소개 이미지를 읽습니다.
function parsePerformanceDetail(xml) {
  // KOPIS 상세 XML에서 태그 이름을 대소문자와 속성 여부에 관계없이 찾습니다.
  const get = tag => {
    const match = String(xml || '').match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
    return match?.[1]?.trim() || '';
  };

  // KOPIS가 반환하는 CDATA 표기를 제거합니다.
  const clean = value => String(value || '')
    .replace(/^<!\\[CDATA\\[/i, '')
    .replace(/\\]\\]>$/i, '')
    .trim();

  // 줄거리와 소개 이미지 목록을 반환합니다.
  return {
    sty: clean(get('sty')),
    styurls: clean(get('styurls'))
  };
}

// 공연 상세 페이지에서 사용할 줄거리를 KOPIS 상세 API로 가져옵니다.
async function fetchPerformanceDetail(key, id) {
  if (!key) return { sty: '', styurls: '' };

  try {
    // 상세 API는 목록 API와 응답 구조가 다를 수 있으므로 별도로 직접 읽습니다.
    const detailUrl = new URL(KOPIS_BASE + '/' + id);
    detailUrl.searchParams.set('service', key);

    // KOPIS 상세 XML 원문을 그대로 받아 줄거리 태그를 파싱합니다.
    const response = await fetch(detailUrl.toString(), { redirect: 'follow' });
    const xml = await response.text();

    // HTTP 오류가 발생하면 빈 상세정보를 반환합니다.
    if (!response.ok) return { sty: '', styurls: '' };

    // XML 응답에 줄거리 태그가 없더라도 상세 페이지 자체는 정상 표시합니다.
    return parsePerformanceDetail(xml);
  } catch {
    // KOPIS 장애나 네트워크 오류가 있어도 상세 페이지가 깨지지 않게 합니다.
    return { sty: '', styurls: '' };
  }
}
// 정적 공연 JSON에서 특정 공연을 찾아 상세 페이지를 만듭니다.
async function findPerformance(env, id) {
  const response = await env.ASSETS.fetch(new Request('https://movoka.tcflick.com/data/performances.json'));
  if (!response.ok) return null;
  const data = await response.json();
  return [...(data.current || []), ...(data.upcoming || [])].find(item => item.mt20id === id) || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = env.KOPIS_API_KEY;

    // robots.txt를 Worker에서 직접 반환해 네이버 검색로봇이 항상 200(text/plain)으로 읽도록 합니다.
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\\nAllow: /\\n\\nSitemap: https://movoka.tcflick.com/sitemap.xml\\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // 링크 미리보기 이미지도 안정적인 MOVOKA URL로 제공합니다.
    if (url.pathname === '/og-image.png') {
      return Response.redirect('https://raw.githubusercontent.com/kjh9410065-art/movoka/main/%EB%AA%A8%EB%B3%B4%EC%B9%B4%20%EB%A7%81%ED%81%AC%20%EB%AF%B8%EB%A6%AC%EB%B3%B4%EA%B8%B0.png', 302);
    }

    // 브라우저가 자동으로 요청하는 /favicon.ico도 직접 처리해 파비콘 누락을 방지합니다.
    if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
      // 저장소에 보관된 실제 MOVOKA 파비콘으로 연결해 임의로 만든 아이콘이 표시되지 않게 합니다.
      return Response.redirect('https://raw.githubusercontent.com/kjh9410065-art/movoka/main/%EB%AA%A8%EB%B3%B4%EC%B9%B4%20%ED%8C%8C%EB%B9%84%EC%BD%98.png', 302);
    }


    // 공연 상세 URL은 검색엔진이 직접 읽을 수 있는 HTML 페이지로 제공합니다.
    const performanceMatch = url.pathname.match(/^\/performance\/(PF\d+)\/?$/);
    if (performanceMatch) {
      const item = await findPerformance(env, performanceMatch[1]);
      if (!item) return new Response('공연 정보를 찾을 수 없습니다.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const detail = await fetchPerformanceDetail(key, performanceMatch[1]);
      return new Response(renderPerformancePage(item, detail), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // 홈페이지 HTML에도 네이버 소유확인 태그를 강제로 삽입해 배포된 실제 페이지에서 항상 확인되도록 합니다.
    if (url.pathname === '/') {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.ok && (assetResponse.headers.get('content-type') || '').includes('text/html')) {
        const html = await assetResponse.text();
        const verificationTag = '<meta name="naver-site-verification" content="3b7dfe11888152c22b558b06f35998565807c086" />';
        let updatedHtml = html;
        const headFallback = [
          !updatedHtml.includes('name="naver-site-verification"') ? verificationTag : '',
          !updatedHtml.includes('property="og:title"') ? '<meta property="og:title" content="MOVOKA · 모보카 | 공연정보와 예매사이트">' : '',
          !updatedHtml.includes('property="og:description"') ? '<meta property="og:description" content="현재 공연과 공연 예정작을 장르별로 찾고 공연기간·공연장·예매사이트를 확인하세요.">' : '',
          !updatedHtml.includes('property="og:image"') ? '<meta property="og:image" content="https://movoka.tcflick.com/og-image.png">' : '',
          !updatedHtml.includes('property="og:url"') ? '<meta property="og:url" content="https://movoka.tcflick.com/">' : '',
          !updatedHtml.includes('property="og:type"') ? '<meta property="og:type" content="website">' : ''
        ].filter(Boolean).join('\\n');
        if (headFallback) updatedHtml = updatedHtml.replace(/<head>/i, `<head>\\n${headFallback}`);
        // 원본 HTML의 길이/압축/ETag 헤더가 변경된 HTML과 충돌하지 않도록 제거합니다.
        const headers = new Headers(assetResponse.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.delete('etag');
        headers.set('content-type', 'text/html; charset=utf-8');
        headers.set('cache-control', 'no-store, no-cache, must-revalidate');

        return new Response(updatedHtml, {
          status: assetResponse.status,
          headers
        });
      }
    }


    if (!key) return Response.json({ ok: false, error: 'KOPIS_API_KEY가 Worker에 없습니다.' }, { status: 500 });

    if (url.pathname === '/api/performances') {
      const page = Number(url.searchParams.get('page') || url.searchParams.get('cpage') || 1);
      const rows = Number(url.searchParams.get('rows') || ROWS);
      const target = makeListUrl(url, key, page, rows);

      try {
        const xml = await callKopis(target);
        return Response.json({ ok: true, items: parseList(xml) }, {
          headers: { 'Cache-Control': 'public, max-age=300' }
        });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/test') {
      try {
        const target = new URL(KOPIS_BASE + '/PF0000000000');
        target.searchParams.set('service', key);
        const response = await fetch(target);
        return new Response(await response.text(), { status: response.status, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/performance') {
      const id = url.searchParams.get('mt20id') || '';
      if (!/^PF\d+$/.test(id)) return Response.json({ ok: false, error: '잘못된 공연 ID입니다.' }, { status: 400 });

      // 같은 공연의 상세 예매정보는 Cloudflare와 브라우저 양쪽에서 캐시할 수 있게 합니다.
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const detailUrl = new URL(KOPIS_BASE + '/' + id);
        detailUrl.searchParams.set('service', key);
        const xml = await callKopis(detailUrl);
        const cleaned = await cleanBookingSites(xml);
        const response = new Response(cleaned, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=1800'
          }
        });
        await cache.put(cacheKey, response.clone());
        return response;
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    console.log(`MOVOKA daily refresh: ${new Date().toISOString()}`);
  }
};