// JSON과 사이트맵의 공연 ID가 정확히 일치하는지 확인합니다.
import { readFile } from 'node:fs/promises';
import { refreshDate, validateData } from './refresh-utils.mjs';
const data = JSON.parse(await readFile('public/data/performances.json', 'utf8'));
validateData(data, refreshDate());
const xml = await readFile('public/sitemap.xml', 'utf8');
const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
const expected = new Set(['/', '/terms.html', '/privacy.html', '/contact.html'].map(path => 'https://movoka.tcflick.com' + path));
for (const item of data.items) expected.add('https://movoka.tcflick.com/performance/' + encodeURIComponent(item.mt20id));
if (!xml.includes('<urlset') || urls.length !== expected.size || new Set(urls).size !== urls.length || urls.some(url => !expected.has(url))) throw new Error('사이트맵 URL 집합 불일치');
console.log(`검증 성공: 공연 ${data.items.length}건 / 사이트맵 ${urls.length}개`);
