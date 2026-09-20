(() => {
  'use strict';

  // Shared with chat.js. sessionStorage is per-tab and is cleared when the tab closes.
  const KEYS = { interest: 'passerby.interest', intent: 'passerby.intent' };
  const INTERESTS = ['random', 'music', 'gaming', 'movies', 'technology', 'school', 'business', 'relationships', 'other'];

  const $ = (id) => document.getElementById(id);
  const landing = $('landing');
  const interests = $('interests');
  const agree = $('agree');
  const findBtn = $('find-btn');

  const safeSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) { /* storage may be disabled */ } };

  // The topic screen lives at #choose so the browser Back button works as expected.
  function render() {
    const choosing = location.hash === '#choose';
    landing.hidden = choosing;
    interests.hidden = !choosing;
    const heading = choosing ? $('interests-title') : $('landing-title');
    window.scrollTo(0, 0);
    heading.focus({ preventScroll: true });
  }

  function selectedInterest() {
    const checked = document.querySelector('input[name="interest"]:checked');
    const value = checked ? checked.value : 'random';
    return INTERESTS.includes(value) ? value : 'random';
  }

  $('start-btn').addEventListener('click', () => { location.hash = 'choose'; });
  $('back-btn').addEventListener('click', () => { location.hash = ''; });
  window.addEventListener('hashchange', render);

  agree.addEventListener('change', () => { findBtn.disabled = !agree.checked; });

  findBtn.addEventListener('click', () => {
    if (!agree.checked) return;
    safeSet(KEYS.interest, selectedInterest());
    safeSet(KEYS.intent, 'find');
    location.href = '/chat.html';
  });

  findBtn.disabled = !agree.checked; // browsers may restore a ticked checkbox after Back/refresh

  // Initial state (handles reload on #choose). Skip focus stealing on first paint of the landing page.
  if (location.hash === '#choose') render();
})();
