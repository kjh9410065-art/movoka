// Build a self-contained browser preview without any production deployment.
import { readFile, writeFile } from "node:fs/promises";
import { Script } from "node:vm";
let html=await readFile("public/index.html","utf8");
const css=await readFile("public/preview-features.css","utf8");
const js=await readFile("public/preview-features.js","utf8");
const data=JSON.parse(await readFile("public/data/performances.json","utf8"));
const byEnd=(a,b)=>String(a.prfpdto||"").localeCompare(String(b.prfpdto||""));
const byStart=(a,b)=>String(a.prfpdfrom||"").localeCompare(String(b.prfpdfrom||""));
function choose(items, sorted) {
  const short=items.slice().sort(sorted).slice(0,65);
  const other=items.slice(0,35);
  return [...new Map([...short,...other].map(item=>[item.mt20id,item])).values()].slice(0,90);
}
const sample={current:choose(data.current||[],byEnd),upcoming:choose(data.upcoming||[],byStart)};
if(!sample.current.length || !sample.upcoming.length) throw new Error("No KOPIS preview fixtures");
const safeJson=JSON.stringify(sample).replace(/</g,"\\u003c");
const sheet='<link rel="stylesheet" href="/preview-features.css">';
const tag='<script src="/preview-features.js"></script>';
if(!html.includes(sheet) || !html.includes(tag)) throw new Error("Preview source tags missing");
html=html.replace(sheet,"<style>\n"+css+"\n</style>");
html=html.replace(tag,"<script>\n"+js+"\n</script>");
const marker="// 페이지가 열리면 저장된 일일 데이터만 읽습니다.\nload();";
if(!html.includes(marker)) throw new Error("Data loading marker missing");
const injected=[
  "// Standalone preview: sample data is embedded so file:// opens without network.",
  "const sample=" + safeJson + ";",
  "window.__rawCurrent=sample.current;",
  "window.__rawUpcoming=sample.upcoming;",
  "$('updated').textContent='미리보기 데이터 샘플 · 현재 '+sample.current.length+'건 / 예정 '+sample.upcoming.length+'건';",
  "filterData();",
  "// The offline demo cannot use the live detail Worker route.",
  "document.getElementById('grid').addEventListener('click', function(e) {",
  "  const anchor=e.target.closest('a.detail-link');",
  "  if(!anchor)return;",
  "  e.preventDefault();",
  "  const id=anchor.getAttribute('href').split('/').pop();",
  "  const x=[...sample.current,...sample.upcoming].find(v=>v.mt20id===id);",
  "  alert((x?.prfnm||'공연')+'\\n\\n기간: '+(x?.prfpdfrom||'')+' ~ '+(x?.prfpdto||'')+",
  "    '\\n공연장: '+(x?.fcltynm||'')+'\\n\\n이 파일은 오프라인 미리보기입니다. 공연 상세 공유·캘린더는 별도 Cloudflare 미리보기 사이트에서 확인할 수 있습니다.');",
  "});"
].join("\n");
html=html.replace(marker,injected);
html=html.replace('</title>','</title>\n<!-- Standalone preview sample, not a production site. -->');
for(const [,attrs,body] of html.matchAll(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g)){
  if(/application\/ld\+json/i.test(attrs))continue;
  new Script(body,{filename:"MOVOKA-demo-embedded.js"});
}
await writeFile("public/preview-demo.html",html,"utf8");
console.log("Standalone MOVOKA demo built: "+sample.current.length+" current, "+sample.upcoming.length+" upcoming performances.");
