// Ustawia motyw przed narysowaniem strony, zeby nie mignela w zlym kolorze.
// Osobny plik, bo polityka CSP panelu nie dopuszcza skryptow w tresci HTML.
(function () {
  try {
    var saved = localStorage.getItem('frogsync-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch (e) { /* tryb prywatny — decyduje system */ }
})();
