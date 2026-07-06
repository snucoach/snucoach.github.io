// 스크롤 진행바 · 맨위로 버튼 · 모바일 드롭다운
(function () {
  var bar = document.getElementById('scrollProgress');
  var top = document.getElementById('gotoTop');
  function onScroll() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    top.classList.toggle('visible', h.scrollTop > 300);
  }
  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  top.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  // 터치 기기: 드롭다운 탭 토글
  document.querySelectorAll('.nav-dropdown > button').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      btn.parentElement.classList.toggle('open');
    });
  });
  document.addEventListener('click', function () {
    document.querySelectorAll('.nav-dropdown.open').forEach(function (d) {
      d.classList.remove('open');
    });
  });
  // 공유 버튼: Web Share API → 클립보드 폴백
  var share = document.getElementById('navShare');
  if (share) share.addEventListener('click', function () {
    if (navigator.share) {
      navigator.share({ title: document.title, url: location.href });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(location.href).then(function () {
        share.classList.add('copied');
        setTimeout(function () { share.classList.remove('copied'); }, 1200);
      });
    }
  });
})();
