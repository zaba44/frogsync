# FrogSync — polityka prywatności / Privacy policy

*Obowiązuje od 5 listopada 2026 r., aktualizacja dla wersji 0.6.0. / Effective 5 November 2026, updated for 0.6.0.*

## Po polsku

FrogSync synchronizuje zakładki między przeglądarkami **wyłącznie przez serwer, który użytkownik sam uruchamia** (obraz Docker z tego repozytorium). Autor wtyczki nie prowadzi żadnego serwera i nie ma dostępu do danych użytkowników.

**Jakie dane przetwarza wtyczka.** Tytuły, adresy i strukturę folderów zakładek oraz ustawienia wtyczki. Dane te są wysyłane tylko pod adres serwera wpisany przez użytkownika podczas parowania, połączeniem HTTPS. W przeglądarce wtyczka przechowuje token urządzenia, stan synchronizacji i punkty przywracania (lokalnie, w pamięci rozszerzenia).

**Czego wtyczka nie robi.** Nie zbiera danych analitycznych ani telemetrii, nie wyświetla reklam, nie śledzi odwiedzanych stron, nie czyta treści stron i nie przekazuje danych podmiotom trzecim — z jednym wyjątkiem, który włącza sam użytkownik: opcjonalnymi podpowiedziami Google (opis niżej). Nie synchronizuje haseł, historii ani kart.

**Uprawnienia.** `bookmarks` — odczyt i zapis zakładek, czyli główna funkcja. `storage` — zapis ustawień i stanu synchronizacji. `alarms` — okresowe sprawdzanie zmian na serwerze. Dostęp do adresu serwera (`https://…`) jest prośbą opcjonalną: przeglądarka pyta o zgodę dla jednego, wskazanego przez użytkownika adresu.

**Strona nowej karty.** Kafelki i wyszukiwanie w zakładkach działają lokalnie. Podpowiedzi Google są opcjonalne i domyślnie wyłączone; po włączeniu wpisywany w polu wyszukiwania tekst jest wysyłany do Google (suggestqueries.google.com) bez ciasteczek i bez danych FrogSync. Wyszukanie przyciskiem otwiera stronę wybranej wyszukiwarki, tak jak zwykłe wyszukiwanie. W Operze, po włączeniu opcji, wtyczka odczytuje adres nowo otwartej karty wyłącznie po to, by rozpoznać Speed Dial — nie zapisuje go i nigdzie nie wysyła.

**Usunięcie danych.** Odinstalowanie wtyczki usuwa jej dane z przeglądarki. Dane na serwerze kontroluje właściciel serwera (panel administracyjny: odłączenie urządzenia, usunięcie profilu, kopie zapasowe).

**Kontakt.** zabadevelop@gmail.com, zgłoszenia: https://github.com/zaba44/frogsync/issues

## In English

FrogSync syncs bookmarks between browsers **only through a server that the user runs themselves** (the Docker image from this repository). The author operates no server and has no access to users' data.

**Data processed.** Bookmark titles, URLs and folder structure, plus extension settings. This data is sent only to the server address entered by the user during pairing, over HTTPS. In the browser the extension stores a device token, sync state and restore points locally in extension storage.

**What the extension does not do.** No analytics or telemetry, no ads, no tracking of visited pages, no reading of page content, no sharing of data with third parties — with one exception the user turns on themselves: optional Google suggestions (see below). It does not sync passwords, history or tabs.

**Permissions.** `bookmarks` — read and write bookmarks (the core feature). `storage` — settings and sync state. `alarms` — periodic checks for changes on the server. Host access (`https://…`) is optional and requested only for the single server address the user enters.

**New tab page.** Tiles and bookmark search work locally. Google suggestions are optional and off by default; when enabled, text typed in the search box is sent to Google (suggestqueries.google.com) without cookies or FrogSync data. In Opera, when the option is enabled, the extension reads the URL of a newly opened tab only to detect Speed Dial — it is neither stored nor sent anywhere.

**Data removal.** Uninstalling the extension removes its data from the browser. Data on the server is controlled by the server owner (admin panel: revoke device, delete profile, backups).

**Contact.** zabadevelop@gmail.com, issues: https://github.com/zaba44/frogsync/issues
