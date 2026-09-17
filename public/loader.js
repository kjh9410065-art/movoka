// MOVOKA 공연 목록 로더
// 브라우저가 Worker API를 직접 호출해 초기 화면과 전체 목록을 가져옵니다.

let movokaLoadToken = 0;

// XML 공연 목록을 기존 배열과 합치고 공연 ID 중복을 제거합니다.
function mergeMovokaXml(xml) {
  const incoming = parse(xml);
  const map = new Map(lastItems.map(item => [item.mt20id, item]));
  incoming.forEach(item => {
    if (item.mt20id) map.set(item.mt20id, item);
  });
  lastItems = [...map.values()];
  renderItems(lastItems);
}

// 검색 조건을 현재 화면에 반영해 공연 데이터를 조회합니다.
async function loadWithTicketFilter() {
  const token = ++movokaLoadToken;
  const p = new URLSearchParams({ rows: '28' });
  if (active) p.set('shcate', active);
  if ($('#area').value) p.set('shigucodesub', $('#area').value);
  if ($('#q').value.trim()) p.set('shprfnm', $('#q').value.trim());

  $('#go').disabled = true;
  grid.innerHTML = '<div class="empty">공연 정보를 불러오는 중입니다.</div>';
  count.textContent = '공연 정보를 불러오는 중...';
  currentPage = 1;

  try {
    // 첫 28개를 별도 요청해 화면을 즉시 채웁니다.
    const response = await fetch('/api/performances/first?' + p.toString(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || '공연 목록 요청 실패');
    }
    const xml = await response.text();
    if (token !== movokaLoadToken) return;

    lastItems = parse(xml);
    if (!lastItems.length) throw new Error('KOPIS 응답에 공연이 없습니다.');
    renderItems(lastItems);
  } catch (error) {
    // 실패 원인을 화면에 바로 표시해 무한 로딩을 막습니다.
    if (token === movokaLoadToken) {
      grid.innerHTML = '<div class="empty">공연 정보를 불러오지 못했습니다.<br><small style="display:block;margin-top:10px">' + esc(String(error?.message || error).slice(0, 240)) + '</small><button class="primary" style="margin-top:14px;padding:10px 16px" onclick="loadWithTicketFilter()">다시 시도</button></div>';
      count.textContent = '공연 정보를 불러오지 못했습니다.';
    }
    $('#go').disabled = false;
    return;
  }

  $('#go').disabled = false;

  // 첫 화면 이후 6페이지씩 백그라운드에서 계속 가져옵니다.
  let start = 2;
  while (token === movokaLoadToken) {
    try {
      const response = await fetch('/api/performances/batch?' + p.toString() + '&start=' + start, {
        cache: 'no-store',
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) break;

      const data = await response.json();
      if (token !== movokaLoadToken) break;
      mergeMovokaXml(data.xml || '<dbs></dbs>');

      if (data.done) break;
      start = Number(data.nextStart) || start + 6;
    } catch (_) {
      // 전체 백그라운드 조회가 실패해도 이미 표시된 공연은 그대로 유지합니다.
      break;
    }
  }
}

// 페이지가 준비되면 공연 목록을 자동으로 조회합니다.
loadWithTicketFilter().catch(() => {
  $('#go').disabled = false;
});
