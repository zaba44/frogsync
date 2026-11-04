# FrogSync

Synchronizacja zakładek między przeglądarkami (Firefox i Chromium) przez własny serwer,
z wbudowaną stroną startową. Plan całości: [PLAN.md](PLAN.md).

**Stan: etap 1 — serwer.** Wtyczka powstaje w etapie 2.

## Serwer

ASP.NET Core (.NET 10) w kontenerze Docker, baza SQLite na wolumenie. Tylko HTTPS.

### Bezpieczeństwo domyślne

- Serwer przyjmuje połączenia **wyłącznie z adresów prywatnych** (sieć lokalna, VPN, loopback).
  Otwarcie na internet wymaga świadomego `FROGSYNC_ALLOW_PUBLIC=true`.
- Brak hasła domyślnego. Przy pierwszym starcie w logu kontenera pojawia się jednorazowy
  **kod konfiguracji** — bez niego nikt nie przejmie panelu świeżo postawionego serwera.
- Panel wymaga hasła (min. 12 znaków) **i** kodu z aplikacji uwierzytelniającej (2FA).
  Ten sam kod nie zadziała drugi raz. Po 5 błędach adres jest blokowany.
- Przeglądarki parują się sześciocyfrowym kodem z panelu, ważnym 5 minut i jednorazowym.
  Token urządzenia nigdy nie trafia do adresu strony; serwer trzyma tylko jego skrót.
- Każde parowanie, odwołanie i logowanie trafia do dziennika w panelu.

### Zmienne środowiskowe

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `FROGSYNC_PORT` | `8443` | port HTTPS |
| `FROGSYNC_DATA` | `/data` | baza, kopie, certyfikat |
| `FROGSYNC_CERT` | `/data/certs/server.pfx` | certyfikat PFX z kluczem prywatnym |
| `FROGSYNC_CERT_PASSWORD` | — | hasło do PFX |
| `FROGSYNC_ALLOW_PUBLIC` | `false` | `true` = przyjmuj połączenia spoza sieci prywatnych |
| `FROGSYNC_BACKUP_EXTRA` | — | dodatkowy katalog na kopie (np. folder Nextcloud) |
| `FROGSYNC_BACKUP_KEEP` | `30` | ile kopii trzymać |

### Certyfikat

Serwer startuje z certyfikatem **samopodpisanym**, wygenerowanym na wszystkie adresy maszyny.
Panel działa od razu (przeglądarka ostrzeże o braku zaufania), ale wtyczka połączy się dopiero
z certyfikatem z Twojego CA. Wgrywasz go w panelu, sekcja **Certyfikat HTTPS**: plik PFX/P12
(z hasłem lub bez) albo para PEM (certyfikat + klucz). Działa od razu, bez restartu.

Certyfikat musi mieć klucz prywatny, przeznaczenie *Server Authentication* i w polu SAN
nazwę albo adres IP, pod którym otwierasz serwer — wystarczy samo IP, nazwa DNS nie jest
potrzebna. Panel odrzuci plik, który tych warunków nie spełnia, i nie ruszy wtedy działającego
certyfikatu.

Kolejność przy starcie: wgrany w panelu → `FROGSYNC_CERT` → samopodpisany. Uszkodzony plik
nie unieruchamia serwera: zostaje pominięty z błędem w logu, żeby dało się wejść do panelu
i wgrać poprawny.

### Sieć w Dockerze

Używaj `network_mode: host`. Przy zwykłym mapowaniu portów Docker potrafi podstawiać jako
adres klienta adres bramy `172.x` — wtedy filtr „tylko sieci prywatne” widzi wszystkich
jako prywatnych i przestaje cokolwiek chronić.

### Kopie zapasowe

Co 6 godzin i na żądanie z panelu, spójnie przez SQLite Backup API, bez wstrzymywania
synchronizacji. Najpierw do `/data/backups`, potem — jeśli ustawiono — kopia pliku do
`FROGSYNC_BACKUP_EXTRA`. Wolny albo niedostępny katalog dodatkowy kończy się ostrzeżeniem
w panelu, nigdy przestojem serwera.

Certyfikat wgrany w panelu jest przechowywany w bazie, więc jest częścią każdej kopii.

**Pobranie kopii.** W panelu, w sekcji kopii: „Pobierz” przy wybranej kopii albo „Zrób kopię
i pobierz”. Plik `.db` to kompletny stan serwera (zakładki, profile, urządzenia, administrator
z 2FA, certyfikat).

**Przywrócenie.** „Przywróć z pliku…” w panelu — serwer sprawdza plik (integralność, wersja
schematu), przed podmianą robi kopię bezpieczeństwa obecnego stanu, a po przywróceniu wylogowuje
panel. Przeglądarki same wykryją przywróconą bazę i uzgodnią z nią swój stan; niczego nie trzeba
parować od nowa.

**Nowa instalacja serwera.** Na ekranie pierwszej konfiguracji wybierz „Mam kopię — przywróć
serwer”, wpisz kod konfiguracji z logu kontenera i wskaż plik kopii. Logujesz się potem
hasłem i 2FA z kopii.

**Kopia poza kontenerem.** Wolumen `/data` ginie razem z kontenerem, jeśli usuniesz go
w Portainerze. Dlatego warto podpiąć katalog hosta (np. folder synchronizowany z Nextcloudem)
i wskazać go zmienną `FROGSYNC_BACKUP_EXTRA`:

```yaml
    volumes:
      - frogsync-data:/data
      - /srv/kopie/frogsync:/backup-extra
    environment:
      FROGSYNC_BACKUP_EXTRA: /backup-extra
```

### Zgubiony telefon z 2FA

```bash
docker exec frogsync dotnet FrogSync.Server.dll --reset-admin
```

Potem restart kontenera — w logu pojawi się nowy kod konfiguracji. Zakładki, profile
i urządzenia zostają nietknięte. Polecenie wymaga dostępu do kontenera, więc nie da się
go wywołać przez sieć.

## Wersja deweloperska

```bash
docker compose -f deploy/docker-compose.dev.yml up -d --build
```

Kontener `frogsync-dev`, port 18443, wolumen `frogsync-dev-data`. Usunięcie razem z danymi:

```bash
docker compose -f deploy/docker-compose.dev.yml down -v
```

## Testy

```bash
dotnet run --project tests/FrogSync.Tests
```
