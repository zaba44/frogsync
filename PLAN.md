# FrogSync — plan

Jedna wtyczka Firefox + Chromium: synchronizacja zakładek i strona startowa.
Ustalone z Dominikiem i Codexem (autor `homepage`), 2026-11-02.

## Dlaczego nowy projekt

Oba dotychczasowe rozwiązania zawodziły z przyczyn w kodzie, nie w Nextcloudzie.

Zakładki v2: rewizja oznaczana jako zastosowana mimo nieudanego dodania zakładki (stąd „czasem muszę wymusić” — poprawione w 2.0.1), pozycja w folderze w ogóle nie była synchronizowana (stąd zakładki lądujące na dole listy), a klucz oparty na samym adresie nie odwzorowuje tej samej strony w kilku folderach.

Homepage: to zwykła strona WWW, więc skróty i token leżały w pamięci witryny, którą Firefox kasuje przy czyszczeniu danych stron. Dlatego po kilku dniach znikały skróty i wyglądało to na rozłączenie z serwerem — w wersji z serwerem i bez niego. Do tego synchronizacja tylko przy otwartej karcie i kopia do Nextcloud pod blokadą całego serwera.

Nowy projekt w osobnym katalogu i repozytorium, z nowym identyfikatorem wtyczki. Stare repo `bookmark-sync` zostaje jako archiwum z odnośnikiem.

## Ustalenia

| Obszar | Decyzja |
|---|---|
| Serwer | ASP.NET Core (.NET 10), **tylko obraz Docker** na Debianie 192.168.144.66 (CasaOS). Bez exe i bez programu w zasobniku. Kod przenośny, gdyby kiedyś był potrzebny Windows. |
| Dostęp | HTTPS pod stałą nazwą DNS z certyfikatem Twojego CA; z firmy przez istniejący VPN; domyślnie wyłącznie adresy prywatne (patrz Bezpieczeństwo). |
| Baza | SQLite w trybie WAL na wolumenie Dockera. Nextcloud tylko na kopie, nigdy ścieżka zapisu. |
| Model synchronizacji | dziennik zmian z numerem `seq` nadawanym przez serwer, kursor per urządzenie, idempotentne `clientOpId`, wersja rekordu. Kursor przesuwa się **dopiero po faktycznym zapisaniu zmiany w przeglądarce**. |
| Transport | krótkie żądania po każdej zmianie, przy starcie i alarmem co minutę; trwała kolejka zmian z ponawianiem. Bez zależności od otwartej karty. |
| Tożsamość | każda zakładka i folder ma własny GUID; lokalne mapowanie GUID ↔ id przeglądarki. Ten sam adres w kilku folderach to osobne rekordy. |
| Zakres | **całe drzewo zakładek** z filtrami wykluczeń (foldery, adresy, wzorce). |
| Kolejność | rekord ma `parentId` i klucz kolejności nadawany wyłącznie przez serwer. Klient wysyła intencję „przenieś za X, przed Y”. Gdy miejsca nie da się jednoznacznie ustalić — konflikt do rozstrzygnięcia, nigdy ciche wrzucenie na koniec. Stosowanie przesunięć sekwencyjne, bez lawiny zdarzeń zwrotnych. |
| Parowanie | sześciocyfrowy kod z panelu, ważny 5 minut, z limitem prób → token urządzenia w pamięci wtyczki. Koniec tokenów w adresie. |
| Panel | WWW serwowany przez serwer: profile, urządzenia, parowanie i odwoływanie, logo, kopie, konflikty, dziennik. |
| Profil | jedno drzewo zakładek + ustawienia strony startowej + logo. |

## Bezpieczeństwo

Projekt jest publiczny na GitHubie, więc musi być bezpieczny także u kogoś, kto uruchomi go bez czytania instrukcji.

Podstawa, której nie da się wyłączyć: wyłącznie HTTPS; osobny token dla każdego urządzenia, na serwerze tylko jego skrót; kod parowania ważny 5 minut z limitem prób; blokada adresu po kilku nieudanych logowaniach; panel administratora z hasłem i kodem z aplikacji uwierzytelniającej (2FA), bez hasła domyślnego; dziennik parowań, odwołań i logowań.

Zasięg: **tylko sieć lokalna i VPN**. Serwer domyślnie odrzuca połączenia spoza adresów prywatnych. Otwarcie na internet wymaga świadomego przełączenia opcji w konfiguracji, więc nikt nie wystawi serwera na świat przypadkiem.

Świadomie odrzucone: nietypowy port i UDP (wtyczka przeglądarki rozmawia tylko po TCP, a ukrywanie portu nie chroni przed skanerami) oraz szyfrowanie od końca do końca (serwer nie mógłby liczyć duplikatów ani pokazywać profilu w panelu, a zgubione hasło oznaczałoby utratę danych).

## Strona startowa

Wbudowana w wtyczkę, działa offline — dane w pamięci rozszerzenia, której czyszczenie danych stron nie rusza. Nie istnieje jako osobna strona WWW.

Kafelki to **wyłącznie zakładki ze wskazanych folderów**, jak Szybki dostęp w Vivaldim. Każdy wskazany folder to osobna sekcja strony, podfolder to kafelek-folder otwierający swoją zawartość. Dodanie, zmiana nazwy czy przeciągnięcie kafelka zmienia zakładkę i odwrotnie — jedno źródło prawdy. Kolor i własna ikona kafelka zapisują się jako dodatkowe dane rekordu na serwerze; w przeglądarce zakładka zostaje zwykłą zakładką.

Wybór sekcji i ich kolejność są **wspólne dla profilu**. Logo ustawiasz w panelu, wtyczka pobiera je i przechowuje lokalnie.

Z Homepage zostaje: wyszukiwarka z podpowiedziami, motyw jasny/ciemny, liczba kolumn i wierszy, przeciąganie i układanie strzałkami.

Przejęcie nowej karty jest zapisane w manifeście i nie da się go włączać przełącznikiem, dlatego dwa warianty paczki z jednego kodu: „sama synchronizacja” i „synchronizacja + nowa karta”. Stronę startową przeglądarki ustawiasz raz ręcznie na adres nowej karty.

## Duplikaty

Grupy po ostrożnie znormalizowanym adresie (host i port domyślny tak, ścieżka, fragment i parametry zachowane; warianty różniące się tylko parametrami śledzącymi jako osobne sugestie). Kopie w tym samym folderze oznaczone jako prawdopodobnie przypadkowe, w różnych jako możliwie celowe, z podglądem lokalizacji. Oznaczenie „celowo zdublowane” zapisuje się w profilu dla konkretnego zestawu kopii — pojawienie się kolejnej kopii znów pokaże grupę. Usuwanie wyłącznie ręczne, z wyborem zachowywanej kopii i możliwością cofnięcia.

## Zostaje z dotychczasowych funkcji

Filtry wykluczeń, eksport i import HTML, kopie stanu z podglądem i przywracaniem, hamulec przy masowym usuwaniu, rozpoznawanie przeglądarek.

**Odpada:** synchronizacja haseł (zostaje Vaultwarden z rozszerzeniem Bitwardena), odświeżanie ikon stron, exe i program w zasobniku, osobna lista skrótów Homepage, strona startowa jako witryna WWW.

## Migracja

Pierwsza przeglądarka: kontrolowany import jej zakładek jako stanu początkowego profilu. Kolejne: adopcja istniejących wpisów (ten sam adres w tej samej ścieżce folderów), niejednoznaczne przypadki w podglądzie przed scaleniem. Skróty Homepage: import z eksportu JSON obecnej strony do wskazanego folderu zakładek, który od razu staje się sekcją strony startowej. Przed każdym importem kopia; identyfikator migracji chroni przed podwójnym importem. Stare systemy wyłączasz dopiero po sprawdzeniu danych na obu komputerach.

## Etapy

1. **Serwer** w Dockerze: baza, dziennik zmian, parowanie kodem, podstawowy panel (profile, urządzenia), zabezpieczenia, kopie. Instrukcja uruchomienia w CasaOS.
2. **Synchronizacja zakładek** we wtyczce: drzewo z kolejnością, filtry, migracja z przeglądarki. Kilkudniowy test na Twoich komputerach, na podpisanej wtyczce w zwykłym Firefoksie i w Chromium.
3. **Strona startowa**: sekcje z folderów, kafelki, logo, wyszukiwarka, offline, import skrótów Homepage.
4. **Panel pełny** i **duplikaty**: logo, konflikty, dziennik, wyszukiwanie duplikatów.
5. Wyłączenie zakładek v2 i Homepage.
6. **Wielu użytkowników** (na później, dla osób, które pobiorą projekt z GitHuba): konta użytkowników
   z własnymi profilami i własnym logowaniem do panelu, administrator zarządzający kontami, osobne
   kopie i limity. Na dziś wystarczają profile jednego właściciela — schemat bazy trzymamy tak,
   żeby dodanie właściciela profilu było zwykłą migracją, bez przepisywania synchronizacji.

Po każdym etapie dostajesz gotowe pliki i informację, co dokładnie podmienić.

## Kryterium odbioru

Dane zbieżne na wszystkich przeglądarkach, bez utraty wpisów i bez duplikatów po ponowieniach, z zachowaną kolejnością w folderach. Kursor nigdy nie przeskakuje niewykonanej zmiany — także po restarcie przeglądarki, przerwanym połączeniu czy przywróceniu starszej kopii serwera. Testy obowiązkowo obejmują: przerwanie na każdym etapie, utratę odpowiedzi, powtórzenie operacji, konflikt offline, równoczesne przestawienia kolejności na dwóch komputerach, nieudany zapis w przeglądarce.
