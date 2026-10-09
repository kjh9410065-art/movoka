// Git push 후 운영 파일이 이번 갱신 결과와 일치할 때만 배포 성공으로 처리합니다.
import { readFile } from 'node:fs/promises';
const expected = JSON.parse(await readFile('public/data/performances.json', 'utf8'));
const expectedXml = await readFile('public/sitemap.xml', 'utf8');
const base = process.env.MOVOKA_API_BASE || 'https://movoka.tcflick.com';
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  try {
    const responses = await Promise.all(['/data/performances.json', '/sitemap.xml'].map(path => {
      const url = new URL(path, base);
      url.searchParams.set('refresh', String(Date.now()));
      return fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    }));
    if (responses.some(response => !response.ok)) throw new Error('운영 파일 HTTP 오류');
    const [json, xml] = await Promise.all(responses.map(response => response.text()));
    if (JSON.stringify(JSON.parse(json)) === JSON.stringify(expected) && xml === expectedXml) {
      console.log(`운영 배포 확인 성공: ${expected.updatedAt}`);
      process.exit(0);
    }
    console.log('운영 배포 반영 대기 중');
  } catch (error) { console.log(`운영 확인 재시도: ${error.message}`); }
  await new Promise(resolve => setTimeout(resolve, 15000));
}
throw new Error('Git push는 완료됐지만 10분 내 운영 배포를 확인하지 못했습니다.');
