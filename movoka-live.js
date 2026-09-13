// MOVOKA 실시간 영화 화면
// KOBIS 데이터는 Cloudflare Pages Function(/api/movies)을 통해 안전하게 가져옵니다.
(() => {
  const genreOrder = ['전체','공포','코미디','스릴러','액션','드라마','멜로/로맨스','애니메이션','SF','판타지','범죄','미스터리','모험','전쟁','다큐멘터리'];
  const official = {
    CGV: 'https://www.cgv.co.kr/',
    롯데시네마: 'https://www.lottecinema.co.kr/',
    메가박스: 'https://www.megabox.co.kr/'
  };
  let movies = [];
  let activeGenre = '전체';

  const list = document.getElementById('movies');
  const tabs = document.getElementById('tabs');
  const searchOld = document.getElementById('search');
  const updated = document.getElementById('updated');
  if (!list || !tabs || !searchOld) return;

  // 기존 검색 이벤트와 충돌하지 않도록 검색창을 새 DOM으로 교체합니다.
  const search = searchOld.cloneNode(true);
  searchOld.replaceWith(search);

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));

  function renderTabs() {
    // 실제 데이터에 존재하는 장르만 활성화하고, 요청한 주요 장르는 기본 탭으로 유지합니다.
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
          <div class="cinemas">${(movie.cinemas || []).map(c => `<span class="cinema">${esc(c)}</span>`).join('')}</div>
          <div class="buttons">${(movie.cinemas || []).map(c => official[c] ? `<a class="btn" href="${official[c]}" target="_blank" rel="noopener">${esc(c)} 공식사이트</a>` : '').join('')}</div>
        </div>
      </article>`).join('');
  }

  async function load() {
    try {
      const response = await fetch('/api/movies', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || '영화 데이터 연결 실패');
      movies = Array.isArray(data.movies) ? data.movies : [];
      if (updated) updated.textContent = `자료 기준일 ${data.basedAt.slice(0,4)}-${data.basedAt.slice(4,6)}-${data.basedAt.slice(6,8)} · ${movies.length}편`;
      renderTabs();
      renderMovies();
    } catch (error) {
      if (updated) updated.textContent = '데이터 연결 준비 중';
      list.innerHTML = '<div class="error">실시간 영화 데이터 연결이 아직 완료되지 않았습니다.<br>Cloudflare 환경변수 <b>KOBIS_API_KEY</b> 등록 후 자동으로 표시됩니다.</div>';
    }
  }

  search.addEventListener('input', renderMovies);
  load();
})();
