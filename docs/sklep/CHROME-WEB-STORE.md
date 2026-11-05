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
