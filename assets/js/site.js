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

  // ── 드롭다운 ──
  document.querySelectorAll('.nav-dropdown').forEach(function (dd) {
    var btn = dd.querySelector('button');
    var menu = dd.querySelector('.dropdown-menu');
    function place() {
      var r = btn.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
    }
    function show() { place(); menu.classList.add('show'); }
    function hide() { menu.classList.remove('show'); }
    dd.addEventListener('mouseenter', show);
    dd.addEventListener('mouseleave', function () { if (!dd.classList.contains('open')) hide(); });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dd.classList.toggle('open');
      dd.classList.contains('open') ? show() : hide();
    });
    document.addEventListener('click', function () { dd.classList.remove('open'); hide(); });
  });

  // ── 공유 버튼 ──
  var share = document.getElementById('navShare');
  if (share) share.addEventListener('click', function () {
    if (navigator.share) {
      navigator.share({ title: document.title, url: location.href }).catch(function(){});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(location.href).then(function () {
        share.classList.add('copied');
        setTimeout(function () { share.classList.remove('copied'); }, 1200);
      });
    }
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

  // ── 후기 라이트박스 ──
  var lb = document.getElementById('lightbox');
  if (lb) {
    var lbImg = lb.querySelector('img');
    document.querySelectorAll('.page-reviews .nb-img').forEach(function (img) {
      img.addEventListener('click', function () {
        lbImg.src = img.src;
        lb.showModal();
      });
    });
    lb.addEventListener('click', function (e) {
      var r = lbImg.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) lb.close();
    });
    var lbClose = lb.querySelector('.lb-close');
    if (lbClose) lbClose.addEventListener('click', function () { lb.close(); });
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
        li.style.display = ok ? '' : 'none';
        shown += ok ? 1 : 0;
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
