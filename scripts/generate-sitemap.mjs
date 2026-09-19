// MOVOKA sitemap 생성 프로그램입니다.
// 매일 갱신된 공연 데이터에서 현재/예정 공연의 상세 URL을 자동으로 만듭니다.

import { readFile, writeFile } from 'node:fs/promises';

const INPUT = 'public/data/performances.json';
const OUTPUT = 'public/sitemap.xml';
const BASE = 'https://movoka.tcflick.com';

// XML에 안전하게 넣을 수 있도록 문자열을 이스케이프합니다.
function escapeXml(value) {
  return String(value ?? '').replace(/[<>&'"]/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[char]));
}

// 현재/예정 공연을 중복 없이 수집합니다.
const data = JSON.parse(await readFile(INPUT, 'utf8'));
const items = [...(data.current || []), ...(data.upcoming || [])];
const ids = [...new Set(items.map(item => item.mt20id).filter(Boolean))];

// 홈과 공연 상세 페이지를 모두 sitemap에 등록합니다.
const staticUrls = ['/', '/terms.html', '/privacy.html', '/contact.html'];
const urls = [
  ...staticUrls.map(path => `  <url><loc>${escapeXml(BASE + path)}</loc></url>`),
  ...ids.map(id => `  <url><loc>${escapeXml(BASE + '/performance/' + encodeURIComponent(id))}</loc></url>`)
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

// 검색엔진이 발견할 수 있도록 최신 공연 URL 목록을 저장합니다.
await writeFile(OUTPUT, xml, 'utf8');
console.log(`sitemap 완료: ${ids.length}개 공연 상세 URL + 서비스 기본 페이지`);
