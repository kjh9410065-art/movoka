// Check real production responses for the performance URLs reported by Search Console.
// 404/410 may be legitimate for performances no longer available, but 5xx is a server failure.
const base = 'https://movoka.tcflick.com';
const ids = ["PF301988","PF301733","PF301861","PF302016","PF301933","PF301798","PF301852","PF302062","PF302164","PF302134","PF302073","PF301863","PF301994","PF302115","PF302281","PF301794","PF301514","PF301820","PF301882","PF302171"];
const results = [];
for (const id of ids) {
  const url = base + '/performance/' + id;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +https://www.google.com/bot.html)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000)
    });
    const body = await response.text();
    const summary = { id, status: response.status, type: response.headers.get('content-type'), bytes: body.length, canonical: body.includes('rel="canonical"'), redirect: response.headers.get('location') };
    results.push(summary);
    console.log(JSON.stringify(summary));
  } catch (error) {
    const summary = { id, error: String(error) };
    results.push(summary);
    console.error(JSON.stringify(summary));
  }
}
const errors = results.filter(x => x.error || (x.status >= 500 && x.status <= 599));
console.log('Checked', results.length, 'reported URLs; server failures:', errors.length, '200 OK:',results.filter(x=>x.status===200).length,'404/410:',results.filter(x=>x.status===404||x.status===410).length);
if (errors.length) process.exitCode = 1;
