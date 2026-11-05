# Do poprawy

Lista spraw zgłoszonych w trakcie testów, odłożonych na później. Po załatwieniu przenosić do historii zmian w README.

## Panel

### ~~Jasny komunikat, gdy przeglądarka nie dosięga serwera~~ — załatwione 2026-11-03

Panel tłumaczy teraz błąd sieci na „Brak połączenia z serwerem. Odśwież stronę…” zamiast „Failed to fetch”.

#### Pierwotne zgłoszenie — 2026-11-02

**Objaw.** Przy pierwszej konfiguracji panel pokazał tylko „Failed to fetch”. Poprawienie
kodu konfiguracji nic nie dało, pomogło dopiero odświeżenie strony Ctrl+F5.

**Co wiadomo.** Błędny kod sam w sobie daje czytelną odpowiedź serwera („Błędny kod
konfiguracji…”), co sprawdziłem bezpośrednio. „Failed to fetch” oznacza, że zapytanie w ogóle
nie dotarło do serwera — przeglądarka nie podaje stronie powodu. Najbardziej prawdopodobne:
strona była otwarta sprzed ponownego uruchomienia kontenera albo sprzed zaakceptowania
certyfikatu, a przeglądarka nie ponowiła po tym zapisu. Odświeżenie wymusiło nowe połączenie.

**Do zrobienia.**
- Błąd sieci (`TypeError` z `fetch`) tłumaczyć na zrozumiały komunikat, np.:
  „Brak połączenia z serwerem. Odśwież stronę (Ctrl+F5). Jeśli serwer był restartowany albo
  zmienił się certyfikat, przeglądarka może poprosić o ponowne zaakceptowanie certyfikatu.”
  — z przyciskiem „Odśwież stronę”.
- Przy błędzie sieci nie tracić wpisanych danych w formularzu.
- Rozważyć jedno automatyczne ponowienie zapytania po błędzie sieci, zanim pokażemy komunikat.
- Sprawdzić wszystkie komunikaty serwera w panelu pod kątem tego, czy mówią, **co zrobić**,
  a nie tylko co poszło źle — każdy może się pomylić przy wpisywaniu kodu czy hasła.

## Wtyczka

### ~~Zakładka przeniesiona do folderu wykluczonego~~ — załatwione 2026-11-02

Decyzja Dominika: przeglądarki mają wyglądać 1:1. **Przeniesienie** zsynchronizowanej zakładki
do wykluczonego folderu (np. Kosz w Operze, która tak właśnie „usuwa”) usuwa ją z pozostałych
przeglądarek. Samo włączenie nowej reguły filtra albo zmiana nazwy folderu na wykluczoną nadal
tylko ukrywa — żeby jedno kliknięcie w ustawieniach nie wykasowało czegoś ze wszystkich komputerów.
Testy: `przeniesienie do wykluczonego folderu…` i `wlaczenie reguly filtra tylko ukrywa…`.

### Ikona wtyczki

Na razie bez ikony (przeglądarka pokazuje domyślną). Docelowa ikona żaby — przez skill `ikona`
(gpt-image przez Codexa), razem z ikoną panelu w miejsce tymczasowego favicon.svg.

### ~~Przegląd Codexa~~ — załatwione 2026-11-03

Codex przejrzał silnik i zgłosił dziewięć problemów; wszystkie poprawione w wersji 0.2.0
wtyczki, każdy ma scenariusz w `tools/e2e.ts`.

## ~~Strona startowa — do dostawy 3.3~~ — załatwione w 0.8.0 (2026-11-06)

Wszystkie punkty poniżej weszły do wersji 0.8.0 razem z blokami i szablonami.

- **Dziennik zdarzeń:** zapis ustawień strony startowej w panelu nie pojawia się w dzienniku (sprawdzone 2026-11-05 na serwerze testowym). Logo ma wpisy.
- **Ikony stron na kafelkach:** Chromium `_favicon` (uprawnienie `favicon`), Firefox zostaje przy literach.
- **Import skrótów ze starego Homepage** (`start_konfiguracja.json`) do wskazanego folderu, z punktem przywracania.
- **Edycja kafelków** na stronie (tytuł, adres, kolejność przeciąganiem) jako zwykła edycja zakładek.
- **Nowe wyszukiwarki z katalogu profilu** nie są automatycznie przypinane — przypina się je w ustawieniach wtyczki. Rozważyć podpowiedź „W profilu są nowe wyszukiwarki”.
