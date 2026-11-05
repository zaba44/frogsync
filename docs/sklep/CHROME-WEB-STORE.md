# FrogSync w Chrome Web Store — teksty do wklejenia

Paczka: `extension/dist/chrome-store.zip` (budowana przez `node build.mjs --zip`, bez pola `key`).
Grafiki: `docs/sklep/` (zrzuty 1280×800, kafelek 440×280), ikona 128 px jest w paczce.

## Pozycja w sklepie

**Kategoria:** Produktywność → Narzędzia (Productivity → Tools)
**Język:** polski (dodatkowo angielski)
**Widoczność:** Niepubliczny (Unlisted)

**Krótki opis (do 132 znaków)**

PL: Te same zakładki w każdej przeglądarce — synchronizacja przez Twój własny serwer, bez chmury i bez duplikatów.

EN: The same bookmarks in every browser — synced through your own server, no cloud, no duplicates.

**Opis szczegółowy (PL)**

FrogSync utrzymuje identyczne zakładki w Firefoksie, Chrome, Edge, Operze i Vivaldi. Synchronizacja idzie wyłącznie przez serwer, który uruchamiasz sam (obraz Docker, np. na domowym serwerze lub NAS) — żadnej chmury, żadnego konta u zewnętrznej firmy.

• Całe drzewo zakładek z zachowaniem kolejności i folderów — dokładnie 1:1.
• Bez duplikatów: nowa przeglądarka może przejąć kolekcję z serwera, a jej własne zakładki trafiają do osobnego folderu.
• Hamulec masowych usunięć — duże usunięcie czeka na potwierdzenie.
• Punkty przywracania i przywracanie z eksportu HTML jednym kliknięciem.
• Filtry: foldery i adresy, które mają zostać tylko w tej przeglądarce.
• Działa offline — zmiany czekają i wychodzą, gdy serwer wróci.

Bezpieczeństwo: tylko HTTPS, parowanie jednorazowym kodem, osobny token dla każdej przeglądarki, panel serwera z 2FA. Wtyczka nie zbiera żadnych danych i nie ma telemetrii.

Wymaga serwera FrogSync: https://github.com/zaba44/frogsync

**Opis szczegółowy (EN)**

FrogSync keeps identical bookmarks in Firefox, Chrome, Edge, Opera and Vivaldi. Sync goes exclusively through a server you run yourself (a Docker image, e.g. on a home server or NAS) — no cloud, no third-party account.

• The whole bookmark tree with order and folders — exactly 1:1.
• No duplicates: a new browser can take over the collection from the server, moving its own bookmarks to a separate folder.
• Mass-deletion brake — a large deletion waits for confirmation.
• Restore points and one-click restore from an HTML export.
• Filters for folders and URLs that should stay local.
• Works offline — changes wait and go out when the server is back.

Security: HTTPS only, one-time pairing codes, a separate token per browser, admin panel with 2FA. The extension collects no data and has no telemetry.

Requires a FrogSync server: https://github.com/zaba44/frogsync

**Strona główna:** https://github.com/zaba44/frogsync
**Strona pomocy:** https://github.com/zaba44/frogsync/issues

## Prywatność (zakładka „Prywatność” / Privacy practices)

**Pojedynczy cel (Single purpose):**
Synchronizacja zakładek przeglądarki z serwerem uruchomionym przez użytkownika. / Syncing the browser's bookmarks with a server run by the user.

**Uzasadnienie uprawnień:**

- `bookmarks`: Odczyt i zapis zakładek to główna funkcja wtyczki — wysyła zmiany na serwer użytkownika i stosuje zmiany z innych przeglądarek. / Reading and writing bookmarks is the core feature: the extension sends changes to the user's server and applies changes from other browsers.
- `storage`: Zapis ustawień, tokenu urządzenia, stanu synchronizacji i punktów przywracania. / Stores settings, the device token, sync state and restore points.
- `alarms`: Okresowe sprawdzanie zmian na serwerze, także gdy przeglądarka uśpi proces w tle. / Periodic checks for server changes, also when the browser suspends the background worker.
- Dostęp do hostów (optional_host_permissions `https://*/*`): Adres serwera wpisuje użytkownik i jest on inny u każdej osoby, dlatego nie da się go wpisać na stałe. Wtyczka prosi o zgodę tylko dla tego jednego adresu, w chwili parowania. / The server address is entered by the user and differs for everyone, so it cannot be hard-coded. The extension requests access only for that single address, at pairing time.
- Zdalny kod (Remote code): Nie — cały kod jest w paczce. / No — all code is in the package.

**Wykorzystanie danych (Data usage):** autor nie dostaje żadnych danych, ale adresy zakładek opuszczają urządzenie (idą na serwer użytkownika), więc dla przejrzystości zaznacz jedną kategorię: **„Historia przeglądania” (Web history)**. Pozostałe kategorie zostaw puste. Zaznacz też trzy oświadczenia:
- nie sprzedaję danych użytkowników stronom trzecim,
- nie używam ani nie przekazuję danych w celach niezwiązanych z głównym celem,
- nie używam danych do oceny zdolności kredytowej.

**Polityka prywatności (URL):** https://github.com/zaba44/frogsync/blob/main/docs/PRYWATNOSC.md

## Notatka dla recenzenta (Test instructions)

FrogSync requires a self-hosted FrogSync server (open source, Docker image `ghcr.io/zaba44/frogsync-server`). Without a server the popup shows "Not connected" and the options page shows the pairing form. To test end-to-end: run `docker run -d --network host ghcr.io/zaba44/frogsync-server:v0.4.0`, open https://<host>:8443, follow the one-time setup code from the container log, create a profile and click "Pair browser" to get a 6-digit code, then enter the server address and code in the extension options. Restore-from-export (options page) works without a server.

## Aktualizacja przy wersji ze stroną startową (0.6.0)

Podmienić przy zgłoszeniu pierwszej wersji z nową kartą — nie w trakcie przeglądu 0.4.1.

**Pojedynczy cel (nowy):**
Zakładki zawsze pod ręką: synchronizacja zakładek między przeglądarkami przez własny serwer użytkownika i szybki dostęp do nich na stronie nowej karty. / Bookmarks always at hand: syncing bookmarks between browsers through the user's own server and quick access to them on the new tab page.

**Akapit do opisu (PL):**
Nowa karta z Twoimi zakładkami: kafelki z paska zakładek, wyszukiwarka z przyciskami (Google, Allegro, YouTube, Mapy i inne do przypięcia), opcjonalne podpowiedzi z zakładek i z Google. Nową kartę można wyłączyć w ustawieniach.

**Akapit do opisu (EN):**
A new tab with your bookmarks: tiles from the bookmarks bar, a search box with buttons (Google, Allegro, YouTube, Maps and more to pin), optional suggestions from bookmarks and from Google. The new tab can be turned off in settings.

**Nowe uzasadnienia uprawnień:**
- Zastąpienie nowej karty (`chrome_url_overrides`): Strona nowej karty pokazuje zakładki użytkownika jako kafelki — to część głównej funkcji (dostęp do zsynchronizowanych zakładek). Można ją wyłączyć w ustawieniach. / The new tab page shows the user's bookmarks as tiles, part of the core feature. It can be turned off in settings.
- `tabs` (opcjonalne): Tylko w Operze, tylko po włączeniu opcji „Przejmuj nową kartę w Operze”: Opera ignoruje zastąpienie nowej karty, więc wtyczka rozpoznaje kartę ze Speed Dialem i przestawia ją na swoją stronę. Wyłączenie opcji cofa zgodę. / Opera only, only after enabling the option: Opera ignores the new tab override, so the extension detects the Speed Dial tab and redirects it to its page. Disabling the option revokes the permission.
- Host `https://suggestqueries.google.com/*` (w ramach opcjonalnych hostów): Podpowiedzi wyszukiwania Google, tylko po włączeniu opcji; wpisywany tekst jest wysyłany do Google bez ciasteczek. / Google search suggestions, only when enabled; typed text is sent to Google without cookies.

**Prywatność — dopisać do docs/PRYWATNOSC.md** (zrobione w 0.6.0): podpowiedzi Google są opcjonalne i domyślnie wyłączone.

## Aktualizacja przy wersji 0.8.0 (bloki, szablony, ikony)

**Akapit do opisu (PL), dopisać do akapitu o nowej karcie:**
Kafelki z wybranych folderów zakładek, własne kafelki i — opcjonalnie — najczęściej odwiedzane strony; cztery szablony wyglądu (Klasyczny, Kompaktowy, Szkło z własnym tłem, Żywy). Edycja kafelków prosto ze strony i import skrótów ze starej strony startowej.

**Akapit (EN):**
Tiles from chosen bookmark folders, your own tiles and — optionally — your most visited sites; four looks (Classic, Compact, Glass with your own background, Live). Edit tiles right on the page and import shortcuts from an older start page.

**Nowe uzasadnienia uprawnień (wszystkie opcjonalne, proszone dopiero po włączeniu opcji):**
- `topSites`: Blok „Najczęściej odwiedzane” na stronie nowej karty, tylko po włączeniu go w ustawieniach. Lista jest odczytywana lokalnie przy otwarciu karty, nie jest zapisywana ani nigdzie wysyłana. / The "Most visited" block on the new tab page, only after enabling it in settings. The list is read locally when the tab opens and is neither stored nor sent anywhere.
- `favicon`: Ikony stron na kafelkach, tylko po włączeniu opcji „Ikony stron”. Ikony pochodzą z pamięci podręcznej przeglądarki; wtyczka nie pobiera ich z sieci. / Site icons on tiles, only after enabling the option. Icons come from the browser's own favicon cache; the extension does not fetch them from the network.
