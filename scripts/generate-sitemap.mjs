// MOVOKA sitemap 생성 프로그램
// 유효한 현재/예정 공연만 사이트맵에 반영합니다.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { compactDate, refreshDate, validateData } from './refresh-utils.mjs';

const INPUT = 'public/data/performances.json';
const OUTPUT = 'public/sitemap.xml';
const TEMP = `${OUTPUT}.tmp`;
const BASE = 'https://movoka.tcflick.com';

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&'"]/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[char]));
}

const today = refreshDate();

const data = JSON.parse(await readFile(INPUT, 'utf8'));
if (!Array.isArray(data.current) || !Array.isArray(data.upcoming) || !Array.isArray(data.items)) {
  throw new Error('공연 데이터 스키마가 올바르지 않아 사이트맵 생성을 중단합니다.');
}

validateData(data, today);
const allItems = [...data.current, ...data.upcoming];
const validItems = allItems.filter(item => {
  const end = compactDate(item.prfpdto);
  return Boolean(item.mt20id && end && end >= today);
});
const ids = [...new Set(validItems.map(item => item.mt20id))];
if (ids.length === 0) throw new Error('사이트맵에 등록할 유효 공연이 0건입니다. 기존 사이트맵을 보존합니다.');

const staticUrls = ['/', '/terms.html', '/privacy.html', '/contact.html'];
const urls = [
  ...staticUrls.map(path => BASE + path),
  ...ids.map(id => BASE + '/performance/' + encodeURIComponent(id))
];
if (new Set(urls).size !== urls.length) throw new Error('사이트맵 URL 중복이 발견되었습니다.');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url><loc>${escapeXml(url)}</loc></url>`).join('\n')}
</urlset>
`;

await writeFile(TEMP, xml, 'utf8');
const verify = await readFile(TEMP, 'utf8');
const locs = [...verify.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
if (!verify.includes('<urlset') || locs.length !== urls.length || new Set(locs).size !== locs.length) {
  throw new Error('임시 사이트맵 검증 실패. 기존 사이트맵을 보존합니다.');
}
await rename(TEMP, OUTPUT);
console.log(`사이트맵 완료: 공연 ${ids.length}개 + 기본 페이지 ${staticUrls.length}개 / 종료 공연 제외 / KST 기준일 ${today}`);

