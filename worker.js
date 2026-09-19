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
function renderPerformancePage(item) {
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
${poster}<style>body{margin:0;background:#f5f6fa;color:#171923;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}.wrap{max-width:760px;margin:auto;padding:32px 18px 60px}.back{display:inline-block;margin-bottom:20px;color:#5b5bd6;text-decoration:none;font-weight:800}.card{background:#fff;border:1px solid #e5e7ee;border-radius:18px;padding:20px}.poster{max-width:280px;margin:auto}.poster img{display:block;width:100%;border-radius:12px}.tag{margin-top:20px;color:#5b5bd6;font-weight:800}.h1{font-size:32px;line-height:1.3;margin:8px 0 20px}.meta{line-height:1.9;color:#5f6575}.cast{margin-top:20px;padding-top:20px;border-top:1px solid #eee}.home{display:inline-block;margin-top:20px;padding:11px 16px;border-radius:10px;background:#5b5bd6;color:#fff;text-decoration:none;font-weight:800}</style>
</head>
<body><main class="wrap">
<a class="back" href="/">← MOVOKA 공연 목록</a>
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
<a class="home" href="/">다른 공연 찾아보기</a>
</article>
<footer style="margin-top:24px;color:#73798a;font-size:13px">
<a href="/terms.html" style="color:#5b5bd6;text-decoration:none;font-weight:700">이용약관</a> ·
<a href="/privacy.html" style="color:#5b5bd6;text-decoration:none;font-weight:700">개인정보처리방침</a> ·
<a href="/contact.html" style="color:#5b5bd6;text-decoration:none;font-weight:700">문의하기</a>
</footer>
</main></body></html>`;
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

    // 공연 상세 URL은 검색엔진이 직접 읽을 수 있는 HTML 페이지로 제공합니다.
    const performanceMatch = url.pathname.match(/^\/performance\/(PF\d+)\/?$/);
    if (performanceMatch) {
      const item = await findPerformance(env, performanceMatch[1]);
      if (!item) return new Response('공연 정보를 찾을 수 없습니다.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response(renderPerformancePage(item), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
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