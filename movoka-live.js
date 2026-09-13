// MOVOKA 영화 화면
// 영화 데이터는 KOBIS 공식 실시간 데이터만 사용합니다.
(() => {
  const genreOrder = ['전체','공포','코미디','스릴러','액션','드라마','멜로/로맨스','애니메이션','SF','판타지','범죄','미스터리','모험','전쟁','다큐멘터리'];
  const official = {
    CGV:'https://www.cgv.co.kr/cnm/movieBook/movie',
    롯데시네마:'https://www.lottecinema.co.kr/NLCHS/Ticketing',
    메가박스:'https://www.megabox.co.kr/booking/timetable'
  };
  let movies=[];
  let activeGenre='전체';
  let screeningDate='';
  const list=document.getElementById('movies');
  const tabs=document.getElementById('tabs');
  const searchOld=document.getElementById('search');
  const updated=document.getElementById('updated');
  if(!list||!tabs||!searchOld)return;

  const search=searchOld.cloneNode(true);
  searchOld.replaceWith(search);
  const esc=value=>String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

  function ensureModalStyle(){
    if(document.getElementById('movoka-modal-style'))return;
    const style=document.createElement('style');
    style.id='movoka-modal-style';
    style.textContent=`
      .movie-modal-backdrop{position:fixed;inset:0;z-index:9999;background:#0008;display:flex;align-items:center;justify-content:center;padding:20px}
      .movie-modal{position:relative;width:min(560px,100%);max-height:min(82vh,760px);overflow:auto;background:#fff;border-radius:18px;padding:22px;box-shadow:0 20px 60px #0004}
      .movie-modal-close{position:absolute;top:10px;right:12px;width:34px;height:34px;border:0;border-radius:50%;background:#f1f2f5;font-size:24px;line-height:1;cursor:pointer;z-index:2}
      .movie-modal-head{display:flex;gap:16px;padding-right:35px;align-items:flex-start}
      .movie-modal-poster{width:100px;height:auto;max-height:145px;object-fit:contain;border-radius:8px;background:#f5f5f5}
      .movie-modal h3{margin:5px 0 8px;font-size:22px;line-height:1.35}
      .movie-modal-meta{margin:0;color:#777;font-size:12px;line-height:1.5}
      .movie-modal-section{margin-top:20px}.movie-modal-section strong{display:block;font-size:15px;margin-bottom:8px}.movie-modal-section p{margin:0;color:#444;font-size:13px;line-height:1.8;white-space:pre-line}
      @media(max-width:480px){.movie-modal-backdrop{padding:12px}.movie-modal{padding:18px;border-radius:15px;max-height:88vh}.movie-modal-poster{width:82px;max-height:120px}.movie-modal h3{font-size:18px}}
    `;
    document.head.appendChild(style);
  }

  // 영화 정보 버튼을 누르면 개봉일과 오늘 상영일을 함께 보여줍니다.
  async function openMovieInfo(movie){
    ensureModalStyle();
    document.getElementById('movieInfoModal')?.remove();
    const modal=document.createElement('div');
    modal.id='movieInfoModal';
    modal.innerHTML=`<div class="movie-modal-backdrop" data-close="1"><div class="movie-modal" role="dialog" aria-modal="true" aria-label="영화 정보"><button class="movie-modal-close" type="button" aria-label="닫기">×</button><div class="movie-modal-head">${movie.poster?`<img class="movie-modal-poster" src="${esc(movie.poster)}" alt="${esc(movie.title)} 포스터">`:''}<div><h3>${esc(movie.title)}</h3><p class="movie-modal-meta">개봉 ${esc(movie.date||'개봉일 정보 없음')} · 오늘 상영 ${esc(screeningDate||'오늘')}${movie.rating?` · ${esc(movie.rating)}`:''}${movie.runtime?` · ${esc(movie.runtime)}분`:''}</p></div></div><div class="movie-modal-section"><strong>줄거리</strong><p class="movie-plot">불러오는 중...</p></div><div class="movie-modal-section"><strong>감독</strong><p class="movie-director">불러오는 중...</p></div></div></div>`;
    document.body.appendChild(modal);
    const close=()=>modal.remove();
    modal.querySelector('.movie-modal-close').addEventListener('click',close);
    modal.querySelector('.movie-modal-backdrop').addEventListener('click',e=>{if(e.target.dataset.close)close()});

    try{
      const response=await fetch(`/api/movie-info?movieCd=${encodeURIComponent(movie.id)}`,{headers:{Accept:'application/json'}});
      const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.message||'영화 정보를 불러오지 못했습니다.');
      modal.querySelector('.movie-plot').textContent=data.plot||'등록된 줄거리 정보가 없습니다.';
      modal.querySelector('.movie-director').textContent=data.director||'등록된 감독 정보가 없습니다.';
    }catch(error){
      modal.querySelector('.movie-plot').textContent=error.message||'영화 정보를 불러오지 못했습니다.';
      modal.querySelector('.movie-director').textContent='';
    }
  }

  function renderTabs(){
    tabs.innerHTML=genreOrder.map(genre=>{
      const exists=genre==='전체'||movies.some(movie=>(movie.genres||[]).includes(genre));
      return `<button class="tab ${genre===activeGenre?'active':''}" ${exists?'':'disabled style="opacity:.45"'} data-genre="${esc(genre)}">${esc(genre)}</button>`;
    }).join('');
    tabs.querySelectorAll('.tab:not([disabled])').forEach(button=>button.addEventListener('click',()=>{
      activeGenre=button.dataset.genre;
      renderTabs();
      renderMovies();
    }));
  }

  function renderMovies(){
    const keyword=search.value.trim().toLowerCase();
    const filtered=movies.filter(movie=>(activeGenre==='전체'||(movie.genres||[]).includes(activeGenre))&&(!keyword||String(movie.title||'').toLowerCase().includes(keyword)));
    const heading=document.getElementById('sectionTitle');
    if(heading)heading.textContent=`🎬 ${activeGenre==='전체'?'전체 영화':activeGenre}`;
    if(!filtered.length){
      list.innerHTML='<div class="empty">현재 조건에 맞는 영화가 없습니다.</div>';
      return;
    }

    list.innerHTML=filtered.map(movie=>`<article class="card"><div class="poster">${movie.poster?`<img src="${esc(movie.poster)}" alt="${esc(movie.title)} 포스터">`:'포스터 준비 중'}</div><div class="info"><button class="movie-info-btn" type="button" data-movie-id="${esc(movie.id)}">영화 정보</button><div class="title">${esc(movie.title)}</div><div class="meta">${esc(movie.date||'개봉일 정보 없음')}${movie.rating?` · ${esc(movie.rating)}`:''}${movie.runtime?` · ${esc(movie.runtime)}분`:''}</div><div class="genre-list">${(movie.genres||[]).map(g=>`<span class="genre">${esc(g)}</span>`).join('')}</div><div class="buttons">${(movie.cinemas||[]).map(c=>official[c]?`<a class="btn cinema-btn" href="${official[c]}" target="_blank" rel="noopener">${esc(c)}</a>`:'').join('')}</div></div></article>`).join('');
    list.querySelectorAll('.movie-info-btn').forEach(button=>button.addEventListener('click',()=>{
      const movie=movies.find(item=>String(item.id)===String(button.dataset.movieId));
      if(movie)openMovieInfo(movie);
    }));
  }

  async function load(){
    try{
      if(updated)updated.textContent='KOBIS 공식 데이터 실시간 조회 중...';
      const response=await fetch('/api/movies',{headers:{Accept:'application/json'},cache:'no-store'});
      const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.message||'영화 데이터 연결 실패');
      movies=Array.isArray(data.movies)?data.movies:[];
      screeningDate=String(data.basedAt||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
      if(updated)updated.textContent=`KOBIS 기준 ${screeningDate} · ${movies.length}편 · 실시간`;
      renderTabs();
      renderMovies();
    }catch(error){
      if(updated)updated.textContent='영화 데이터 연결 실패';
      list.innerHTML=`<div class="error">영화 데이터를 불러오지 못했습니다.<br>${esc(error.message||'잠시 후 다시 시도해주세요.')}</div>`;
    }
  }

  search.addEventListener('input',renderMovies);
  load();
})();