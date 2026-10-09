// 갱신 작업 전체가 동일한 KST 기준일과 검증 규칙을 공유합니다.
export function compactDate(value) {
  const digits = String(value ?? '').trim().replace(/[.\/-]/g, '');
  if (!/^\d{8}$/.test(digits)) return '';
  const date = new Date(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll('-', '') === digits ? digits : '';
}
export function refreshDate() {
  const value = process.env.MOVOKA_REFRESH_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  if (!compactDate(value)) throw new Error('잘못된 갱신 기준일');
  return value;
}
export function validateData(data, today) {
  for (const key of ['items', 'current', 'upcoming']) {
    if (!Array.isArray(data[key])) throw new Error(`데이터 배열 누락: ${key}`);
    const ids = new Set();
    for (const item of data[key]) {
      const start = compactDate(item.prfpdfrom), end = compactDate(item.prfpdto);
      if (!/^PF\d+$/.test(item.mt20id) || ids.has(item.mt20id) || !start || !end || start > end || end < today) throw new Error(`공연 검증 실패: ${item.mt20id}`);
      if (key === 'current' && (start > today || item.prfstate !== '02')) throw new Error('현재 공연 분류 오류');
      if (key === 'upcoming' && (start <= today || item.prfstate !== '01')) throw new Error('예정 공연 분류 오류');
      ids.add(item.mt20id);
    }
  }
  const combined = [...data.current, ...data.upcoming];
  const map = new Map(combined.map(item => [item.mt20id, JSON.stringify(item)]));
  if (!data.items.length || map.size !== combined.length || data.items.length !== map.size || data.items.some(item => map.get(item.mt20id) !== JSON.stringify(item))) throw new Error('공연 배열 내용 불일치');
  const updated = Date.parse(data.updatedAt);
  if (!Number.isFinite(updated) || updated > Date.now() + 60000 || (process.env.MOVOKA_REFRESH_STARTED_AT && updated < Date.parse(process.env.MOVOKA_REFRESH_STARTED_AT))) throw new Error('갱신 시각 검증 실패');
}
