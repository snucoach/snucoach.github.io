// SNUCOACH site interactions v2
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── 내비 스크롤 상태 + 진행바 + TOP 버튼 ──
  var nav = document.getElementById('topnav');
  var bar = document.getElementById('scrollProgress');
  var top = document.getElementById('gotoTop');
  function onScroll() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    if (bar) bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    if (top) top.classList.toggle('visible', h.scrollTop > 420);
    if (nav) nav.classList.toggle('scrolled', h.scrollTop > 8);
  }
  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (top) top.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });

  // 스크린리더 안내용 aria-live 영역
  var srLive = document.createElement('div');
  srLive.setAttribute('aria-live', 'polite');
  srLive.className = 'sr-only';
  document.body.appendChild(srLive);
  function announce(msg) { srLive.textContent = ''; setTimeout(function () { srLive.textContent = msg; }, 30); }

  // ── 드롭다운 (aria-expanded 동기화 + ESC 닫기) ──
  document.querySelectorAll('.nav-dropdown').forEach(function (dd) {
    var btn = dd.querySelector('button');
    var menu = dd.querySelector('.dropdown-menu');
    function place() {
      var r = btn.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
    }
    function show() { place(); menu.classList.add('show'); btn.setAttribute('aria-expanded', 'true'); }
    function hide() { menu.classList.remove('show'); btn.setAttribute('aria-expanded', 'false'); }
    dd.addEventListener('mouseenter', show);
    dd.addEventListener('mouseleave', function () { if (!dd.classList.contains('open')) hide(); });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dd.classList.toggle('open');
      dd.classList.contains('open') ? show() : hide();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { dd.classList.remove('open'); hide(); btn.focus(); }
    });
    menu.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { dd.classList.remove('open'); hide(); btn.focus(); }
    });
    document.addEventListener('click', function () { dd.classList.remove('open'); hide(); });
  });

  // ── 모바일 드로어 (햄버거 → 우측 슬라이드 메뉴) ──
  var navToggle = document.getElementById('navToggle');
  var navDrawer = document.getElementById('navDrawer');
  var navScrim = document.getElementById('navScrim');
  var drawerClose = document.getElementById('drawerClose');
  if (navToggle && navDrawer && navScrim) {
    var lastFocus = null;
    function openDrawer() {
      lastFocus = document.activeElement;
      navScrim.hidden = false;
      void navScrim.offsetWidth;
      navDrawer.classList.add('open');
      navScrim.classList.add('show');
      navToggle.setAttribute('aria-expanded', 'true');
      navToggle.setAttribute('aria-label', '메뉴 닫기');
      navDrawer.setAttribute('aria-hidden', 'false');
      document.body.classList.add('drawer-open');
      if (drawerClose) drawerClose.focus();
      document.addEventListener('keydown', onDrawerKey);
    }
    function closeDrawer() {
      navDrawer.classList.remove('open');
      navScrim.classList.remove('show');
      navToggle.setAttribute('aria-expanded', 'false');
      navToggle.setAttribute('aria-label', '메뉴 열기');
      navDrawer.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('drawer-open');
      document.removeEventListener('keydown', onDrawerKey);
      setTimeout(function () { if (!navDrawer.classList.contains('open')) navScrim.hidden = true; }, 360);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function onDrawerKey(e) {
      if (e.key === 'Escape') { closeDrawer(); return; }
      if (e.key === 'Tab') {
        var f = navDrawer.querySelectorAll('a[href], button');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    navToggle.addEventListener('click', function () {
      navDrawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });
    if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
    navScrim.addEventListener('click', closeDrawer);
    navDrawer.querySelectorAll('.drawer-links a, .drawer-cta, .drawer-kakao').forEach(function (a) {
      a.addEventListener('click', closeDrawer);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 640 && navDrawer.classList.contains('open')) closeDrawer();
    });
  }

  // ── 공유 버튼 (폴백 + 스크린리더 안내) ──
  var share = document.getElementById('navShare');
  if (share) share.addEventListener('click', function () {
    if (navigator.share) {
      navigator.share({ title: document.title, url: location.href }).catch(function(){});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(location.href).then(function () {
        share.classList.add('copied');
        announce('페이지 주소가 복사되었습니다.');
        setTimeout(function () { share.classList.remove('copied'); }, 1200);
      }).catch(function () { window.prompt('페이지 주소를 복사하세요', location.href); });
    } else {
      window.prompt('페이지 주소를 복사하세요', location.href);
    }
  });

  // ── 스태거 컨테이너: 자식 리빌에 자동 지연 부여 ──
  document.querySelectorAll('[data-rv-stagger]').forEach(function (c) {
    var kids = c.querySelectorAll(':scope > [data-rv]');
    kids.forEach(function (el, i) { el.style.transitionDelay = (i * 0.1) + 's'; });
  });

  // ── 스크롤 리빌 ──
  if (!reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('rv-in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0 });
    document.querySelectorAll('[data-rv]').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('[data-rv]').forEach(function (el) { el.classList.add('rv-in'); });
  }

  // ── 후기 라이트박스 (현재 보이는 카드만 순회) ──
  var lb = document.getElementById('lightbox');
  if (lb) {
    var lbImg = lb.querySelector('img');
    var view = [];   // 열 때 만들어지는 '현재 보이는' 이미지 목록
    var cur = 0;
    function buildView() {
      // 메이슨리 컬럼 내, 숨겨지지 않은 카드의 이미지만 (DOM=시각 순서)
      view = Array.prototype.slice.call(
        document.querySelectorAll('.rv-card:not(.is-hidden) .nb-img')
      );
    }
    function render() {
      var el = view[cur];
      if (el) lbImg.src = el.dataset.full || el.src;
    }
    function go(delta) {
      if (!view.length) return;
      cur = (cur + delta + view.length) % view.length;
      render();
    }
    function openFrom(img) {
      buildView();
      cur = view.indexOf(img);
      if (cur < 0) cur = 0;
      render();
      lb.showModal();
    }
    var page = document.querySelector('.page-reviews');
    if (page) {
      page.addEventListener('click', function (e) {
        var img = e.target.closest('.nb-img');
        if (img) openFrom(img);
      });
      // 키보드 접근: 이미지(role=button)에서 Enter/Space로 열기
      page.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        var img = e.target.closest('.nb-img');
        if (img) { e.preventDefault(); openFrom(img); }
      });
    }
    lb.addEventListener('click', function (e) {
      if (e.target.closest('.lb-nav') || e.target.closest('.lb-close')) return;
      var r = lbImg.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) lb.close();
    });
    lb.querySelector('.lb-close').addEventListener('click', function () { lb.close(); });
    var prev = lb.querySelector('.lb-prev'), next = lb.querySelector('.lb-next');
    if (prev) prev.addEventListener('click', function () { go(-1); });
    if (next) next.addEventListener('click', function () { go(1); });
    lb.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    });
  }

  // ── 후기: 행 우선 메이슨리 + 카테고리 필터 ──
  var masonry = document.querySelector('.rv-masonry');
  if (masonry) {
    var allCards = Array.prototype.slice.call(masonry.querySelectorAll('.rv-card'));
    var curCat = 'all';
    function colCount() {
      var w = masonry.clientWidth;
      if (w < 520) return 1;
      if (w < 820) return 2;
      return 3;
    }
    function layout() {
      var n = colCount();
      masonry.textContent = '';
      var cols = [], heights = [];
      for (var i = 0; i < n; i++) {
        var col = document.createElement('div');
        col.className = 'rv-col';
        masonry.appendChild(col);
        cols.push(col); heights.push(0);
      }
      allCards.forEach(function (card) {
        if (curCat !== 'all' && card.dataset.cat !== curCat) return;
        // 가장 낮은 컬럼에 배치 (행 우선 → 앞 카드가 상단 전체에)
        var min = 0;
        for (var i = 1; i < n; i++) if (heights[i] < heights[min]) min = i;
        cols[min].appendChild(card);
        // 카드 비율로 예상 높이 가산 (썸네일 width/height 기반)
        var img = card.querySelector('img');
        var ar = (img && img.getAttribute('height') && img.getAttribute('width'))
          ? img.getAttribute('height') / img.getAttribute('width') : 1.3;
        heights[min] += ar + 0.5; // 이미지 비율 + 캡션 상수
      });
    }
    layout();
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt); rt = setTimeout(function () {
        if (colCount() !== masonry.children.length) layout();
      }, 160);
    });
    var rvChips = document.getElementById('rvChips');
    if (rvChips) rvChips.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      rvChips.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      curCat = chip.dataset.cat;
      layout();
    });
  }

  // ── 자료&칼럼: 필터 + 검색 ──
  var chipRow = document.getElementById('chipRow');
  if (chipRow) {
    var search = document.getElementById('colSearch');
    var items = Array.prototype.slice.call(document.querySelectorAll('.post-item'));
    var empty = document.getElementById('postEmpty');
    var activeCat = 'all';
    function apply() {
      var q = (search && search.value || '').trim().toLowerCase();
      var shown = 0;
      items.forEach(function (li) {
        var okCat = activeCat === 'all' ||
          (activeCat === 'free' ? li.dataset.free === '1' : li.dataset.cat === activeCat);
        var okQ = !q || li.dataset.title.indexOf(q) !== -1;
        var ok = okCat && okQ;
        if (ok) {
          li.style.display = '';
          requestAnimationFrame(function () { li.classList.remove('is-hidden'); });
          shown += 1;
        } else {
          li.classList.add('is-hidden');
          setTimeout(function () { if (li.classList.contains('is-hidden')) li.style.display = 'none'; }, 260);
        }
      });
      if (empty) empty.style.display = shown ? 'none' : '';
    }
    chipRow.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      chipRow.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      activeCat = chip.dataset.cat;
      apply();
    });
    if (search) search.addEventListener('input', apply);
  }
})();
