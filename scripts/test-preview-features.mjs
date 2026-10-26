import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile("public/preview-features.js", "utf8");
const html = await readFile("public/index.html", "utf8");
const worker = await readFile("worker.js", "utf8");
const config = await readFile("wrangler.jsonc", "utf8");
const robots = await readFile("public/robots.txt", "utf8");
const storage = new Map([["movoka-favorites-v1", JSON.stringify(["PF300001"])]]);
const window = {};
vm.runInNewContext(source, { window, localStorage: { getItem(k){return storage.get(k)||null;}, setItem(k,v){storage.set(k,v);} }, Date });
const features = window.MovokaExtras;
assert(features && typeof features.apply === "function", "preview feature module loaded");
assert.match(features.favoriteButton("PF300001"), /찜 완료/, "favorite state restored");
assert.match(features.favoriteButton("PF300002"), /찜하기/, "favorite button for non-saved performances");
assert.equal(features.favoriteButton("invalid-id"), "", "invalid IDs excluded");
const today = features.kstToday();
const pad = n => String(n).padStart(2, "0");
function plusDays(n) {
  const d=new Date(today.slice(0,4)+"-"+today.slice(4,6)+"-"+today.slice(6,8)+"T00:00:00Z");
  d.setUTCDate(d.getUTCDate()+n);
  return d.getUTCFullYear()+"."+pad(d.getUTCMonth()+1)+"."+pad(d.getUTCDate());
}
const items = [
  { mt20id:"PF300002",prfnm:"공연 가나다",prfpdfrom:plusDays(5),prfpdto:plusDays(7) },
  { mt20id:"PF300001",prfnm:"공연 라마바",prfpdfrom:plusDays(1),prfpdto:plusDays(4) }
];
assert.deepEqual(Array.from(features.apply(items), x => x.mt20id), ["PF300001","PF300002"], "performance dates sorted ascending");
assert.equal(features.asDay("2026.10.26"),"20261026", "KOPIS dates recognized");
assert.equal(features.asDay("2026-10-26"),"20261026", "ISO dates recognized");
assert.equal(features.asDay("nonsense"),"","invalid dates excluded");
assert.equal(features.weekend().length,2,"weekend range");
assert.match(html, /noindex,nofollow/, "preview not indexed");
assert.match(html, /MovokaExtras.mount\(filterData\)/, "UI mounted");
assert.match(html, /MovokaExtras.apply\(base/, "filter wired");
assert.match(html, /MovokaExtras.favoriteButton\(x.mt20id\)/, "card favorite wired");
assert.match(config, /"name"\s*:\s*"movoka-preview"/, "separate worker");
assert.match(config, /"workers_dev"\s*:\s*true/, "preview worker url enabled");
assert.doesNotMatch(config, /"routes"\s*:/, "no production routes");
assert.match(robots, /Disallow:\s*\//, "preview crawlers blocked");
assert.match(worker, /id="movokaDetailFavorite"/, "detail favorite");
assert.match(worker, /id="movokaDetailShare"/, "detail sharing");
assert.match(worker, /id="movokaDetailCalendar"/, "detail calendar");
assert.match(worker, /noindex,nofollow/, "detail noindex");
console.log("MOVOKA preview tests passed: worker isolation, favorites, dates, filters, share/calendar and noindex.");
