// Sets the theme before the first paint, so a light page never flashes dark. It's a file
// because the Content-Security-Policy allows no inline scripts. core/theme.ts takes over once
// the app loads, so keep the storage key and the colors in step with it.
(function () {
  var choice = null;
  try {
    choice = JSON.parse(localStorage.getItem('brew:theme'));
  } catch (e) {
    // Blocked or corrupt storage: follow the system.
  }
  var prefersLight = !!window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  var light = choice === 'light' || (choice !== 'dark' && prefersLight);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#dbe9f6' : '#0b1320');
})();
