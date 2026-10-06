// MOVOKA Worker - 저장된 공연 데이터만 제공
// KOPIS API는 GitHub Actions의 일일 갱신 작업에서만 호출합니다.

function renderPerformancePage(item, detail = {}) {
  const title = escHtml(item.prfnm || '공연정보');
  const description = escHtml(`${item.prfnm || '공연'} | ${item.prfpdfrom || ''} ~ ${item.prfpdto || ''} | ${item.fcltynm || ''} - MOVOKA 공연정보`);
  const poster = item.poster ? `<meta property="og:image" content="${escHtml(item.poster)}">\n` : '';
  const status = item.prfstate === '02' ? '현재 공연' : '공연 예정';
  const eventData = {
    "@context":"https://schema.org",
    "@type":"Event",
    name:item.prfnm || "공연정보",
    startDate:toSchemaDate(item.prfpdfrom),
    endDate:toSchemaDate(item.prfpdto),
    location:{"@type":"Place",name:item.fcltynm || "공연장 정보 없음"},
    image:item.poster ? [item.poster] : undefined,
    url:`https://movoka.tcflick.com/performance/${encodeURIComponent(item.mt20id)}`,
    description:item.prfnm ? item.prfnm + " 공연정보" : "MOVOKA 공연정보"
  };

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | MOVOKA</title>
<meta name="description" content="${description}">
<meta name="robots" content="index,follow">
<script type="application/ld+json">${JSON.stringify(eventData)}</script>
<link rel="canonical" href="https://movoka.tcflick.com/performance/${encodeURIComponent(item.mt20id)}">
<meta property="og:title" content="${title} | MOVOKA">
<meta property="og:description" content="${description}">
${poster}<style>
*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:#171923;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.wrap{max-width:760px;margin:auto;padding:32px 18px 60px}.back{display:inline-block;color:#5b5bd6;text-decoration:none;font-weight:800}.card{background:#fff;border:1px solid #e5e7ee;border-radius:18px;padding:20px}.poster{max-width:280px;margin:auto}.poster img{display:block;width:100%;border-radius:12px}.tag{margin-top:20px;color:#5b5bd6;font-weight:800}.h1{font-size:32px;line-height:1.3;margin:8px 0 20px}.meta{line-height:1.9;color:#5f6575}.cast{margin-top:20px;padding-top:20px;border-top:1px solid #eee}.detail-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.action-btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 16px;border-radius:10px;border:1px solid #ddd;background:#fff;color:inherit;text-decoration:none;font-weight:800;cursor:pointer}.action-btn.primary{background:#5b5bd6;color:#fff;border-color:#5b5bd6}.theme-btn{border:1px solid #ddd;background:#fff;color:inherit;border-radius:10px;padding:9px 12px;font-weight:800;cursor:pointer}.booking-list{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:20px;z-index:20}.booking-box{width:min(420px,100%);background:#fff;color:#171923;border-radius:16px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.2)}.booking-box h3{margin:0 0 14px}.booking-links{display:grid;gap:9px}.booking-links button{width:100%;padding:12px;border:1px solid #ddd;background:#fff;color:inherit;border-radius:10px;text-align:left;font-weight:700;cursor:pointer}.booking-close{margin-top:12px;width:100%;padding:10px;border:0;border-radius:10px;background:#f1f2f6;color:inherit;cursor:pointer}.dark{background:#15171c;color:#f1f3f6}.dark .card,.dark .booking-box{background:#20232a;color:#f1f3f6;border-color:#343944}.dark .meta{color:#b8becb}.dark .cast{border-color:#343944}.dark .action-btn,.dark .theme-btn,.dark .booking-links button{background:#252932;color:#f1f3f6;border-color:#3a3f4b}.synopsis-box{margin-top:16px;padding:16px;border:1px solid #e5e7ee;border-radius:12px;line-height:1.8}.dark .synopsis-box{border-color:#343944}.dark .booking-close{background:#30343d}.dark .source-box{background:#252932 !important;color:#b8becb !important}.dark .source-box strong{color:#f1f3f6}.dark .synopsis-box{background:#20232a;color:#f1f3f6}.dark .synopsis-box div{color:#b8becb}.dark footer{color:#b8becb !important}.dark footer a{color:#8b8ff0 !important}.dark .back{color:#8b8ff0}.dark .tag{color:#8b8ff0}
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
<strong>지역</strong><br>${escHtml(item.area || '정보 없음')}<br>\n<strong>장르</strong><br>${escHtml(item.genrenm || '정보 없음')}
</div>
${item.prfcast ? `<div class="cast"><strong>출연진</strong><br>${escHtml(item.prfcast)}</div>` : ''}\n<div class="source-box" style="margin-top:20px;padding:14px;border-radius:12px;background:#f7f7fa;color:#666;font-size:13px;line-height:1.7"><strong>공연정보 출처</strong><br>KOPIS 공연예술통합전산망에서 제공하는 공연 등록 정보를 표시합니다.<br>공연 일정·장소·출연진·예매 가능 여부는 변경될 수 있으므로 최종 정보는 예매처에서 확인하세요.</div>
<div class="detail-actions">${item.prfurl ? '<a class="action-btn primary" href="'+escHtml(item.prfurl)+'" target="_blank" rel="noopener noreferrer">예매사이트</a>' : ''}<a class="action-btn" href="/">다른 공연 찾아보기</a></div>\n</article>

<div class="booking-list" id="bookingList" onclick="if(event.target===this)closeBookingList()"><div class="booking-box"><h3>예매사이트 선택</h3><div class="booking-links" id="bookingLinks"></div><button class="booking-close" onclick="closeBookingList()">닫기</button></div></div>
<script>
/* 버튼으로만 다크모드를 전환하고 선택값을 저장합니다. */
(function(){const key='movoka-theme';const apply=mode=>{document.body.classList.toggle('dark',mode==='dark');const b=document.getElementById('themeToggle');if(b)b.textContent=mode==='dark'?'☀️ 라이트모드':'🌙 다크모드';};apply(localStorage.getItem(key)||'light');document.getElementById('themeToggle').onclick=()=>{const next=document.body.classList.contains('dark')?'light':'dark';localStorage.setItem(key,next);apply(next);};})();

/* 상세 페이지의 모달 닫기만 처리합니다. 공연정보 링크는 저장된 prfurl을 사용합니다. */
function closeBookingList(){document.getElementById('bookingList').style.display='none';}
</script>
<footer style="margin-top:24px;color:#73798a;font-size:13px"><p style="margin:0 0 10px">데이터 출처: KOPIS 공연예술통합전산망</p>
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

    // robots.txt를 Worker에서 직접 반환해 네이버 검색로봇이 항상 200(text/plain)으로 읽도록 합니다.
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\\nAllow: /\\n\\nSitemap: https://movoka.tcflick.com/sitemap.xml\\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
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


    // 공연 상세 URL은 저장된 performances.json만 사용해 HTML을 제공합니다.
    const performanceMatch = url.pathname.match(/^\\/performance\\/(PF\\d+)\\/?$/);
    if (performanceMatch) {
      const item = await findPerformance(env, performanceMatch[1]);
      if (!item) return new Response('공연 정보를 찾을 수 없습니다.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response(renderPerformancePage(item), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
        }
      });
    }

    // 홈페이지 HTML에도 네이버 소유확인 태그를 강제로 삽입합니다.
    if (url.pathname === '/') {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.ok && (assetResponse.headers.get('content-type') || '').includes('text/html')) {
        const html = await assetResponse.text();
        const verificationTag = '<meta name="naver-site-verification" content="3b7dfe11888152c22b558b06f35998565807c086" />';
        let updatedHtml = html;
        const headFallback = [
          !updatedHtml.includes('name="naver-site-verification"') ? verificationTag : '',
          !updatedHtml.includes('property="og:title"') ? '<meta property="og:title" content="MOVOKA · 모보카 | 공연정보와 예매사이트">' : '',
          !updatedHtml.includes('property="og:description"') ? '<meta property="og:description" content="현재 공연과 공연 예정작을 찾고 공연기간·공연장·예매사이트를 확인하세요.">' : '',
          !updatedHtml.includes('property="og:image"') ? '<meta property="og:image" content="https://movoka.tcflick.com/og-image.png">' : '',
          !updatedHtml.includes('property="og:url"') ? '<meta property="og:url" content="https://movoka.tcflick.com/">' : '',
          !updatedHtml.includes('property="og:type"') ? '<meta property="og:type" content="website">' : ''
        ].filter(Boolean).join('\\n');
        if (headFallback) updatedHtml = updatedHtml.replace(/<head>/i, `<head>\\n${headFallback}`);
        const headers = new Headers(assetResponse.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.delete('etag');
        headers.set('content-type', 'text/html; charset=utf-8');
        headers.set('cache-control', 'no-store, no-cache, must-revalidate');
        return new Response(updatedHtml, { status: assetResponse.status, headers });
      }
    }

    // 공연 목록과 검색은 저장된 JSON만 사용합니다.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    console.log(`MOVOKA daily refresh: ${new Date().toISOString()}`);
  }
};