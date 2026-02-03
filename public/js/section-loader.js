// section-loader.js — basit: sadece fetch + innerHTML
document.addEventListener('DOMContentLoaded', () => {
  const sections = ['guestLogin','chat','reservations','info','activities','map','settings'];
  sections.forEach(name => {
    const placeholder = document.getElementById(name + 'Placeholder');
    if (!placeholder) return;
    fetch('/sections/' + name + '.html')
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch ' + name);
        return res.text();
      })
      .then(html => { placeholder.innerHTML = html; })
      .catch(err => {
        console.warn('section-loader:', err);
      });
  });

  // load bottom-nav
  const navPlaceholder = document.getElementById('bottomNavPlaceholder');
  if (navPlaceholder) {
    fetch('/components/bottom-nav.html')
      .then(r => r.ok ? r.text() : Promise.reject('nav fetch failed'))
      .then(html => { navPlaceholder.innerHTML = html; })
      .catch(e => console.warn('bottom-nav load failed', e));
  }
});
