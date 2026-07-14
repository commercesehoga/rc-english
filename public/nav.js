// WonderMayank RC — mobile nav toggle
// Injects a hamburger button into the existing .navbar markup so nav-links (hidden below 760px
// via CSS) are reachable on mobile instead of just disappearing. No HTML changes needed per page.
(function () {
  function init() {
    const navbar = document.querySelector('.navbar');
    const links = document.querySelector('.nav-links');
    if (!navbar || !links) return;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-label', 'Menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span></span><span></span><span></span>';

    const cta = navbar.querySelector('.nav-cta');
    navbar.insertBefore(toggle, cta || null);

    function close() {
      links.classList.remove('open');
      toggle.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = links.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    });

    links.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
    document.addEventListener('click', (e) => { if (!navbar.contains(e.target)) close(); });
    window.addEventListener('resize', () => { if (window.innerWidth > 760) close(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
