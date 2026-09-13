// MOVOKA 영화 화면
// 평소에는 KV에 저장된 일일 데이터를 즉시 읽고, 최초 1회만 빈 KV를 채웁니다.
(() => {
  const genreOrder = ['전체','공포','코미디','스릴러','액션','드라마','멜로/로맨스','애니메이션','SF','판타지','범죄','미스터리','모험','전쟁','다큐멘터리'];

  // 영화관 공식 예매 페이지입니다.
  // 저장된 cinemas 값이 비어 있어도 버튼 자체는 항상 표시해 사용자가 바로 이동할 수 있게 합니다.
  const official = {
    CGV: 'https://www.cgv.co.kr/cnm/movieBook/movie',
    롯데시네마: 'https://www.lottecinema.co.kr/NLCHS/Ticketing',
    메가박스: 'https://www.megabox.co.kr/booking/timetable'
  };
  const cinemaNames = Object.keys(official);

  let movies = [];
  let activeGenre = '전체';

  const list = document.getElementById('movies');
  const tabs = document.getElementById('tabs');
  const searchOld = document.getElementById('search');
  const updated = document.getElementById('updated');
  if (!list || !tabs || !searchOld) return;

  const search = searchOld.cloneNode(true);
  searchOld.replaceWith(search);

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));

  function renderTabs() {
    tabs.innerHTML = genreOrder.map(genre => {
      const exists = genre === '전체' || movies.some(movie => (movie.genres || []).includes(genre));
      return `<button class="tab ${genre === activeGenre ? 'active' : ''}" ${exists ? '' : 'disabled style="opacity:.45"'} data-genre="${esc(genre)}">${esc(genre)}</button>`;
    }).join('');
    tabs.querySelectorAll('.tab:not([disabled])').forEach(button => {
      button.addEventListener('click', () => {
        activeGenre = button.dataset.genre;
        renderTabs();
        renderMovies();
      });
    });
  }

  function renderMovies() {
    const keyword = search.value.trim().toLowerCase();
    const filtered = movies.filter(movie => {
      const genreMatch = activeGenre === '전체' || (movie.genres || []).includes(activeGenre);
      const searchMatch = !keyword || String(movie.title || '').toLowerCase().includes(keyword);
      return genreMatch && searchMatch;
    });

    const heading = document.getElementById('sectionTitle');
    if (heading) heading.textContent = `🎬 ${activeGenre === '전체' ? '전체 영화' : activeGenre}`;

    if (!filtered.length) {
      list.innerHTML = '<div class="empty">현재 조건에 맞는 영화가 없습니다.</div>';
      return;
    }

    list.innerHTML = filtered.map(movie => `
      <article class="card">
        <div class="poster">
          ${movie.poster ? `<img src="${esc(movie.poster)}" alt="${esc(movie.title)} 포스터">` : '포스터 준비 중'}
        </div>
        <div class="info">
          <div class="title">${esc(movie.title)}</div>
          <div class="meta">${esc(movie.date || '개봉일 정보 없음')}${movie.rating ? ` · ${esc(movie.rating)}` : ''}${movie.runtime ? ` · ${esc(movie.runtime)}분` : ''}</div>
          <div class="genre-list">${(movie.genres || []).map(g => `<span class="genre">${esc(g)}</span>`).join('')}</div>

          <!-- 영화관 공식 예매 버튼 3개를 항상 노출합니다. -->
          <div class="buttons cinema-buttons">
            ${cinemaNames.map(c => `<a class="btn cinema-btn" href="${official[c]}" target="_blank" rel="noopener">${esc(c)}</a>`).join('')}
          </div>
        </div>
      </article>`).join('');
  }

  async function load() {
    try {
      let response = await fetch('/api/movies', { headers: { Accept: 'application/json' } });
      let data = await response.json();

      // KV가 아직 비어 있으면 최초 1회만 수집 작업을 실행해 데이터를 저장합니다.
      if (response.status === 503 && data.code === 'MOVIE_DATA_NOT_READY') {
        if (updated) updated.textContent = '오늘의 영화 데이터를 처음 불러오는 중...';
        const seedResponse = await fetch('/internal/refresh-movies', { method: 'POST' });
        const seedData = await seedResponse.json();
        if (!seedResponse.ok || !seedData.ok) throw new Error(seedData.message || '초기 영화 데이터 생성 실패');
        response = await fetch('/api/movies', { headers: { Accept: 'application/json' } });
        data = await response.json();
      }

      if (!response.ok || !data.ok) throw new Error(data.message || '영화 데이터 연결 실패');
      movies = Array.isArray(data.movies) ? data.movies : [];
      if (updated) updated.textContent = `자료 기준일 ${data.basedAt.slice(0,4)}-${data.basedAt.slice(4,6)}-${data.basedAt.slice(6,8)} · ${movies.length}편`;
      renderTabs();
      renderMovies();
    } catch (error) {
      if (updated) updated.textContent = '영화 데이터 연결 실패';
      list.innerHTML = `<div class="error">영화 데이터를 불러오지 못했습니다.<br>${esc(error.message || '잠시 후 다시 시도해주세요.')}</div>`;
    }
  }

  search.addEventListener('input', renderMovies);
  load();
})();
