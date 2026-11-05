# FrogSync

Synchronizacja zakładek między Firefoksem i przeglądarkami Chromium przez własny
serwer. Jeden profil zawiera wspólne drzewo zakładek z kolejnością i metadanymi.

Plan projektu: [PLAN.md](PLAN.md). Plan strony startowej:
[PLAN-ETAP3.md](PLAN-ETAP3.md).

Synchronizacja i narzędzia przywracania są zaimplementowane. Strona startowa
jest planowanym kolejnym etapem. Kanał wydawania opisany poniżej obejmuje podpisany
Firefox i paczkę rozpakowaną Chromium.

## Serwer

ASP.NET Core .NET 10, SQLite i kontener Docker na Debianie. Tylko HTTPS.
Baza działa na lokalnym wolumenie; Nextcloud może przechowywać dodatkowe kopie,
ale nie żywą bazę.

### Bezpieczeństwo

- Domyślnie serwer przyjmuje tylko adresy prywatne, loopback i prywatne adresy VPN.
- Panel wymaga hasła i kodu TOTP. Pierwsza konfiguracja wymaga kodu z logu serwera.
- Przeglądarkę paruje się jednorazowym sześciocyfrowym kodem, ważnym 5 minut.
- Token jest osobny dla urządzenia, odwoływalny i nie trafia do adresu strony.
- Błędne logowania i parowania podlegają limitom.
- Panel chronią sesja w ciasteczku HTTPS i dodatkowy nagłówek przy zapisach.

### Konfiguracja

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `FROGSYNC_PORT` | `8443` | port HTTPS |
| `FROGSYNC_DATA` | `/data` | katalog danych |
| `FROGSYNC_CERT` | `/data/certs/server.pfx` | certyfikat z konfiguracji |
| `FROGSYNC_CERT_PASSWORD` | brak | hasło certyfikatu z konfiguracji |
| `FROGSYNC_ALLOW_PUBLIC` | `false` | świadome dopuszczenie adresów publicznych |
| `FROGSYNC_BACKUP_EXTRA` | brak | dodatkowy katalog kopii |
| `FROGSYNC_BACKUP_KEEP` | `30` | liczba zachowywanych kopii |

Serwer uruchamia się z certyfikatem samopodpisanym, jeśli nie ma poprawnego
certyfikatu wgranego w panelu ani wskazanego w konfiguracji. Wtyczka wymaga,
aby przeglądarka ufała certyfikatowi. Certyfikat z własnego CA można wgrać
w panelu jako PFX/P12 albo parę PEM.

Certyfikat wgrany w panelu jest w SQLite i trafia do kopii bazy.
Musi zawierać klucz prywatny, właściwe SAN oraz przeznaczenie do
uwierzytelniania serwera.

### Sieć Dockera

Obecna konfiguracja używa `network_mode: host`. Przy publikacji portów przez
Docker proxy serwer może zobaczyć adres bramy zamiast rzeczywistego klienta,
co ogranicza skuteczność filtra prywatnych adresów.

Host i zapora muszą dopuszczać tylko zamierzony dostęp z LAN/VPN.
Nie wystawiaj panelu ani bazy bezpośrednio do internetu.

### Kopie

Kopie powstają przez SQLite Backup API. Podstawowa kopia jest lokalna;
niepowodzenie dodatkowego zapisu do katalogu chmurowego nie zatrzymuje serwera.

Panel umożliwia:
- wykonanie i pobranie kopii `.db`;
- pobranie wcześniejszej kopii;
- przywrócenie zapisanej lub wgranej kopii;
- przywrócenie serwera z pliku podczas pierwszej konfiguracji.

Kopia zawiera zakładki, urządzenia, administratora z 2FA i wgrany certyfikat.
Traktuj ją jako dane prywatne, razem z kluczem prywatnym HTTPS.

Przed przywróceniem serwer zapisuje kopię bezpieczeństwa. Po przywróceniu
unieważnia sesje panelu i zmienia generację bazy; wtyczki uzgadniają stan od nowa.
Przed operacjami na większej kolekcji zachowaj też eksport zakładek.

Wolumen nazwany przeżywa zwykłe usunięcie kontenera. Usunięcie samego wolumenu
lub `docker compose down -v` usuwa dane. Przechowuj dodatkową kopię poza nim.

### Zgubiony dostęp administratora

Na komputerze z dostępem do kontenera:

```bash
docker exec frogsync dotnet FrogSync.Server.dll --reset-admin
```

Następnie zrestartuj kontener i odczytaj nowy kod konfiguracji w logu.
Zakładki, profile i urządzenia pozostają w bazie.

## Wersja deweloperska

```bash
docker compose -f deploy/docker-compose.dev.yml up -d --build
```

Konfiguracja deweloperska korzysta z osobnego kontenera, portu i wolumenu.

## Budowanie i testy

Wymagane: .NET SDK 10 oraz Node.js 22 lub nowszy.

```bash
dotnet run --project tests/FrogSync.Tests
cd extension
npm ci
npm test
npm run build:zip
```

`npm test` obejmuje typecheck, testy rdzenia oraz E2E przeciw prawdziwemu serwerowi.
E2E buduje serwer w konfiguracji Release.

Build tworzy `extension/build/firefox` i `extension/build/chrome`.
Paczki trafiają do `extension/dist`.

Lokalny `firefox-extension.xpi` jest archiwum bez podpisu Mozilli. Nie jest
paczką do trwałej instalacji w zwykłym Firefoksie. Do tego służy podpisany
plik z GitHub Release.

## Wydania i aktualizacje

Repozytorium: https://github.com/zaba44/frogsync

### Co aktualizuje się automatycznie

**Firefox:** podpisany XPI zainstalowany normalnie, o ID
`frogsync@frogsync.local`, sprawdza:

https://zaba44.github.io/frogsync/updates.json

Adres jest zapisany w manifeście. Firefox okresowo pobiera manifest i może
zainstalować wskazaną wyższą wersję. Termin sprawdzenia zależy od Firefoksa;
można też ręcznie użyć „Sprawdź aktualizacje” w menedżerze dodatków.

Starszą paczkę bez tego adresu trzeba jednorazowo zastąpić podpisaną paczką
z nowego kanału. Do testu aktualizacji używaj normalnej instalacji XPI,
nie dodatku tymczasowego z `about:debugging`.

**Chromium:** ZIP w Release służy obecnie do rozpakowania i ręcznego
przeładowania rozszerzenia. Sam GitHub Release nie aktualizuje instalacji
rozpakowanej. Automatyczny kanał Chromium przez sklep będzie osobną dostawą.

### Jednorazowa konfiguracja GitHuba i AMO

1. Konto AMO musi mieć prawo publikowania dodatku `frogsync@frogsync.local`.
   Utwórz dane API do podpisywania.
2. W repozytorium GitHub utwórz środowisko `release`.
3. W sekretach tego środowiska zapisz:
   - `AMO_JWT_ISSUER`;
   - `AMO_JWT_SECRET`.
4. W `Settings → Pages → Build and deployment → Source` wybierz
   **GitHub Actions**.
5. Sprawdź reguły środowiska `github-pages`: muszą dopuszczać wdrożenia
   z tagów `v*`. Domyślne ograniczenie do gałęzi może zablokować publikację.
6. Dopuść workflowom korzystanie z uprawnień zadeklarowanych w YAML.
   Workflow wydania zapisuje Release, a osobny job publikuje Pages.
7. Chroń gałąź `main` i prawo tworzenia tagów wydaniowych.

Sekrety AMO są dostępne tylko w kroku podpisywania na oficjalnym repozytorium.
Workflow CI na pull requestach nie korzysta z sekretów publikacji.
Nie uruchamiamy `pull_request_target`.

Pages publikuje katalog generowany przez workflow. Jeśli na tym samym adresie
będzie później dokumentacja, trzeba dołączyć ją do tego katalogu, żeby kolejne
wdrożenie jej nie zastąpiło.

### Przygotowanie wydania

Jedynym źródłem wersji jest `extension/package.json`.
Wersja ma format `X.Y.Z`, bez przyrostków beta/rc.

Przykład wykonany w katalogu `extension`:

```bash
npm version 0.3.2 --no-git-tag-version
npm ci
npm test
npm run build:zip
```

Zatwierdź `package.json`, `package-lock.json` i kod. Przed pierwszym wydaniem
z nowym narzędziem podpisywania wygeneruj lockfile:

```bash
npm install --package-lock-only
```

Następnie, z katalogu repozytorium:

```bash
git add extension/package.json extension/package-lock.json
git commit -m "Release 0.3.2"
git push origin main
git tag -a v0.3.2 -m "FrogSync 0.3.2"
git push origin v0.3.2
```

Pozostałe zmienione pliki dołącz do właściwego commitu przed utworzeniem tagu.
Tag musi wskazywać commit należący do historii `main`; numer tagu i obu wpisów
wersji w lockfile musi odpowiadać `package.json`.

Nie twórz kilku tagów naraz. Poczekaj na zakończenie publikacji poprzedniego
wydania. Workflow odrzuca wydanie starsze niż najwyższy dostępny tag wersji.

### Co robi workflow wydania

1. Sprawdza pochodzenie tagu, wersję i lockfile.
2. Uruchamia testy serwera i wtyczki.
3. Buduje paczki.
4. Przesyła źródła i paczkę Firefox do AMO jako `unlisted`.
5. Czeka do godziny na podpis; cały job ma dłuższy limit.
6. Sprawdza manifest i obecność plików podpisu w pobranym XPI.
7. Publikuje Release z:
   - `frogsync-X.Y.Z-firefox.xpi` — podpisany Firefox;
   - `frogsync-X.Y.Z-chromium.zip` — paczka rozpakowana Chromium;
   - `frogsync-X.Y.Z-source.zip` — źródła odpowiadające tagowi;
   - `SHA256SUMS.txt` — sumy kontrolne.
8. Pobiera publiczny XPI i porównuje hash.
9. Dopiero wtedy publikuje `updates.json` z pełnym `sha256` podpisanego XPI.

Weryfikacja plików podpisu w CI nie zastępuje weryfikacji kryptograficznej
wykonywanej przez Firefoksa.

### Nieudane podpisywanie lub publikacja

Nie zakładaj, że podpis AMO będzie gotowy od razu. Zgłoszenie może wymagać
ręcznego przeglądu.

Jeżeli podpis się nie uda lub upłynie limit:
- Release i Pages nie są publikowane;
- sprawdź status wersji w panelu AMO;
- nie zgłaszaj wielokrotnie tej samej wersji bez sprawdzenia, czy AMO już ją przyjęło.

Jeżeli Release został opublikowany, ale Pages się nie udały, dotychczasowy
manifest aktualizacji pozostaje aktywny. Ponów nieudany job Pages przez
„Re-run failed jobs”; nie podpisuj i nie publikuj tej samej wersji ponownie.
Artefakt wydania jest zachowywany przez 30 dni.

Opublikowanej wersji nie podmieniaj innym kodem. Naprawa dostaje nowy numer,
nowy podpis i nowy tag. Obniżenie numeru w `updates.json` nie cofnie wersji
zainstalowanych już w przeglądarkach.

### Próba odbioru kanału Firefox

1. Zainstaluj podpisaną wersję A przez zwykły menedżer dodatków.
2. Sparuj i dodaj testową zakładkę.
3. Wydaj wersję B, z wyższym numerem.
4. Otwórz `updates.json` i sprawdź wersję, adres XPI i hash.
5. W Firefoksie sprawdź aktualizacje.
6. Potwierdź wersję B, zachowane parowanie, mapowanie i zakładki.

Pierwszy workflow nie wdraża nowej karty ani zmian protokołu synchronizacji.
Strażnik minimalnej wersji wtyczki w serwerze i popupie jest osobną częścią
dostawy 3.0.
