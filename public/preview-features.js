/* MOVOKA isolated preview: local-only discovery controls. No account or server data writes. */
(function (global) {
  "use strict";
  const STORAGE_KEY = "movoka-favorites-v1";
  const state = { mode: "all", date: "", sort: "start", favoritesOnly: false };
  let onChange = function () {};
  let favorites = loadFavorites();

  function safeId(value) { return /^PF\d+$/.test(String(value || "")) ? String(value) : ""; }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function loadFavorites() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.map(safeId).filter(Boolean).slice(0, 1000) : []);
    } catch (_) { return new Set(); }
  }
  function saveFavorites() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(favorites))); } catch (_) {}
  }
  function asDay(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return /^\d{8}$/.test(digits) ? digits : "";
  }
  function kstToday() {
    return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
  }
  function addDays(date, amount) {
    const dt = new Date(date.slice(0,4) + "-" + date.slice(4,6) + "-" + date.slice(6,8) + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + amount);
    return dt.toISOString().slice(0, 10).replace(/-/g, "");
  }
  function weekend() {
    const today = kstToday();
    const day = new Date(today.slice(0,4) + "-" + today.slice(4,6) + "-" + today.slice(6,8) + "T00:00:00Z").getUTCDay();
    const delta = day === 0 ? -1 : (6 - day);
    const saturday = addDays(today, delta);
    return [saturday, addDays(saturday, 1)];
  }
  function overlaps(item, from, to) {
    const start = asDay(item.prfpdfrom), end = asDay(item.prfpdto);
    return !!(start && end && start <= to && end >= from);
  }
  function apply(items) {
    const today = kstToday();
    const period = state.mode === "weekend" ? weekend() : null;
    const endingCutoff = addDays(today, 14);
    return items.filter(function (item) {
      const id = safeId(item.mt20id);
      if (state.favoritesOnly && !favorites.has(id)) return false;
      if (state.date && !overlaps(item, state.date, state.date)) return false;
      if (period && !overlaps(item, period[0], period[1])) return false;
      if (state.mode === "ending" && !(asDay(item.prfpdto) >= today && asDay(item.prfpdto) <= endingCutoff)) return false;
      return true;
    }).sort(function (a, b) {
      if (state.sort === "name") return String(a.prfnm || "").localeCompare(String(b.prfnm || ""), "ko");
      if (state.sort === "ending") return asDay(a.prfpdto).localeCompare(asDay(b.prfpdto)) || String(a.prfnm || "").localeCompare(String(b.prfnm || ""), "ko");
      return asDay(a.prfpdfrom).localeCompare(asDay(b.prfpdfrom)) || String(a.prfnm || "").localeCompare(String(b.prfnm || ""), "ko");
    });
  }
  function favoriteButton(id) {
    const safe = safeId(id);
    if (!safe) return "";
    const pressed = favorites.has(safe);
    return '<button type="button" class="preview-favorite' + (pressed ? ' is-on' : '') +
      '" data-favorite="' + escapeHtml(safe) + '" aria-pressed="' + pressed +
      '" aria-label="' + (pressed ? '찜 해제' : '공연 찜하기') + '">' +
      (pressed ? '♥ 찜 완료' : '♡ 찜하기') + '</button>';
  }
  function updateUI() {
    document.querySelectorAll("[data-preview-mode]").forEach(function (button) {
      const selected = state.mode === button.dataset.previewMode;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const saved = document.getElementById("previewFavoritesOnly");
    if (saved) {
      saved.classList.toggle("is-active", state.favoritesOnly);
      saved.setAttribute("aria-pressed", String(state.favoritesOnly));
      saved.textContent = (state.favoritesOnly ? "♥ 찜한 공연만" : "♡ 찜한 공연만") + " (" + favorites.size + ")";
    }
    document.querySelectorAll("[data-favorite]").forEach(function (button) {
      const pressed = favorites.has(button.dataset.favorite);
      button.classList.toggle("is-on", pressed);
      button.setAttribute("aria-pressed", String(pressed));
      button.setAttribute("aria-label", pressed ? "찜 해제" : "공연 찜하기");
      button.textContent = pressed ? "♥ 찜 완료" : "♡ 찜하기";
    });
  }
  function mount(changeHandler) {
    onChange = changeHandler;
    const chips = document.getElementById("chips");
    if (!chips || document.getElementById("previewDiscovery")) return;
    chips.insertAdjacentHTML("afterend", '<section class="preview-discovery" id="previewDiscovery" aria-label="공연 탐색 도구">' +
      '<div class="preview-discovery-title"><strong>공연 탐색 도구</strong><small>미리보기 · 내 기기에만 찜 목록 저장</small></div>' +
      '<div class="preview-quick">' +
      '<button type="button" data-preview-mode="all" class="is-active">전체 기간</button>' +
      '<button type="button" data-preview-mode="weekend">이번 주말</button>' +
      '<button type="button" data-preview-mode="ending">14일 이내 종료</button>' +
      '<button type="button" id="previewFavoritesOnly" aria-pressed="false">♡ 찜한 공연만 (0)</button>' +
      '</div><div class="preview-fields">' +
      '<label>관람 날짜 <input type="date" id="previewDate" aria-label="관람 희망 날짜"></label>' +
      '<label>정렬 <select id="previewSort" aria-label="공연 정렬">' +
      '<option value="start">시작일 빠른 순</option><option value="ending">종료일 빠른 순</option><option value="name">가나다순</option>' +
      '</select></label><button type="button" id="previewReset">조건 초기화</button>' +
      '</div><div class="preview-help">선택 날짜에 공연 중인 작품을 찾습니다. ' +
      '‘이번 주말’과 ‘14일 이내 종료’는 빠른 추천 조건입니다.</div></section>');
    const root = document.getElementById("previewDiscovery");
    root.addEventListener("click", function (event) {
      const modeButton = event.target.closest("[data-preview-mode]");
      if (modeButton) {
        state.mode = modeButton.dataset.previewMode;
        state.date = ""; document.getElementById("previewDate").value = "";
        updateUI(); onChange(); return;
      }
      if (event.target.closest("#previewFavoritesOnly")) {
        state.favoritesOnly = !state.favoritesOnly; updateUI(); onChange(); return;
      }
      if (event.target.closest("#previewReset")) {
        state.mode = "all"; state.date = ""; state.sort = "start"; state.favoritesOnly = false;
        document.getElementById("previewDate").value = "";
        document.getElementById("previewSort").value = "start";
        updateUI(); onChange();
      }
    });
    document.getElementById("previewDate").addEventListener("change", function (event) {
      state.date = asDay(event.target.value);
      state.mode = "all"; updateUI(); onChange();
    });
    document.getElementById("previewSort").addEventListener("change", function (event) {
      state.sort = event.target.value; onChange();
    });
    document.getElementById("grid").addEventListener("click", function (event) {
      const button = event.target.closest("[data-favorite]");
      if (!button) return;
      event.preventDefault(); event.stopPropagation();
      const id = safeId(button.dataset.favorite);
      if (!id) return;
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      saveFavorites();
      updateUI();
      if (state.favoritesOnly) onChange();
    });
    updateUI();
  }
  global.MovokaExtras = { mount: mount, apply: apply, favoriteButton: favoriteButton,
    updateUI: updateUI, asDay: asDay, weekend: weekend, kstToday: kstToday };
})(window);
