import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const js = await readFile('worker.js', 'utf8');
const app = (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))).default;
const known = ['PF301988', 'PF301733', 'PF301861', 'PF302016'];
const records = known.map(id => ({
  mt20id: id, prfnm: '한글 공연 ' + id, prfpdfrom: '2026.10.01', prfpdto: '2026.11.20',
  fcltynm: '테스트 공연장', genrenm: '연극', prfstate: '02'
}));
let assetsFetched = 0;
const env = {
  ASSETS: { fetch: async () => {
    assetsFetched++;
    return Response.json({ current: records, upcoming: [] });
  } }
};
const responses = await Promise.all(known.map(id =>
  app.fetch(new Request('https://movoka.tcflick.com/performance/' + id), env)
));
for (const [i,response] of responses.entries()) {
  assert.equal(response.status, 200, known[i] + ': HTML response');
  assert.match(response.headers.get('content-type') || '', /text\/html/, known[i] + ': HTML type');
  assert.equal(response.headers.get('x-movoka-detail-handler'), 'resilient-20261026');
  const html = await response.text();
  assert(html.includes('<link rel="canonical" href="https://movoka.tcflick.com/performance/' + known[i] + '">'));
  assert(html.includes('한글 공연'));
}
assert.equal(assetsFetched, 1, 'Concurrent detail crawls must share catalog loading');
const missing = await app.fetch(new Request('https://movoka.tcflick.com/performance/PF999999999'), env);
assert.equal(missing.status, 404, 'Unknown performance returns 404, never a 500');
assert.equal(assetsFetched, 1, 'Repeated lookups should reuse a catalog snapshot');
console.log('MOVOKA worker tests passed: concurrent Hangul detail pages, canonical URLs, cache and missing IDs.');
