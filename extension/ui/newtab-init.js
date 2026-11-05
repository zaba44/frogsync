// Tylko wyglad powloki; zadnych danych profilu i zadnego fokusu.
(() => {
  document.documentElement.classList.add('booting');
  try {
    const value = JSON.parse(localStorage.getItem('frogsync-start-view') || '{}');
    if (['classic', 'compact', 'glass', 'live'].includes(value.template))
      document.documentElement.dataset.template = value.template;
    if (value.startPage === false &&
        new URLSearchParams(location.search).get('view') !== 'start')
      document.documentElement.classList.add('start-hidden');
  } catch { /* Motyw systemowy i klasyczny wyglad pozostaja. */ }
})();
