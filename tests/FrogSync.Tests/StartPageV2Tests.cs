using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FrogSync.Server.Infrastructure;
using static Harness;

public static class StartPageV2Tests
{
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=");

    private static object Doc(object[] blocks, string template = "classic", bool configured = true) =>
        new { version = 2, blocks, engines = Array.Empty<object>(), template, configured };

    private static object Custom(string id, params object[] tiles) =>
        new { id, type = "custom", tiles };

    private static object Tile(string id, string url = "https://example.test/") =>
        new { id, title = "Kafelek " + id, url, color = "#aabbcc" };

    private static object Save(JsonElement snapshot, object document) =>
        new
        {
            generation = snapshot.GetProperty("generation").GetString(),
            settingsVersion = snapshot.GetProperty("settingsVersion").GetInt64(),
            configuration = document,
        };

    private static object CustomSave(JsonElement snapshot, params object[] blocks) =>
        new
        {
            generation = snapshot.GetProperty("generation").GetString(),
            settingsVersion = snapshot.GetProperty("settingsVersion").GetInt64(),
            blocks,
        };

    private static string BackgroundPath(string profileId, JsonElement snapshot) =>
        $"/admin/api/profiles/{profileId}/startpage/background" +
        "?generation=" + Uri.EscapeDataString(snapshot.GetProperty("generation").GetString()!) +
        "&backgroundVersion=" + snapshot.GetProperty("backgroundVersion").GetInt64();

    private static async Task<HttpResponseMessage> Send(
        HttpClient client, HttpMethod method, string path,
        object? body = null, byte[]? bytes = null,
        string mime = "image/png", string? etag = null, bool csrf = true)
    {
        using var request = new HttpRequestMessage(method, path);

        if (csrf && path.StartsWith("/admin/api/", StringComparison.Ordinal))
            request.Headers.Add("X-FrogSync", "1");

        if (etag is not null)
            request.Headers.TryAddWithoutValidation("If-None-Match", etag);

        if (bytes is not null)
        {
            request.Content = new ByteArrayContent(bytes);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(mime);
        }
        else if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response, int expected = 200)
    {
        Expect((int)response.StatusCode == expected,
            $"Startpage v2: oczekiwano {expected}, jest {(int)response.StatusCode}.");

        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.Clone();
    }

    private static async Task<JsonElement> Put(
        HttpClient client, string path, object body, int expected = 200)
    {
        using var response = await Send(client, HttpMethod.Put, path, body);
        return await Json(response, expected);
    }

    public static async Task Run(Harness h, Device a, Device other)
    {
        var path = $"/admin/api/profiles/{a.ProfileId}/startpage";

        await h.Run("startpage v2: nigdy nieskonfigurowany i swiadomie pusty uklad", async () =>
        {
            var freshId = await h.Profile("V2 pusty " + Id());
            var freshPath = $"/admin/api/profiles/{freshId}/startpage";
            var fresh = await h.Get(h.Admin, freshPath);

            Expect(fresh.GetProperty("configuration").GetProperty("version").GetInt32() == 2 &&
                   !fresh.GetProperty("configuration").GetProperty("configured").GetBoolean(),
                "Nowy profil nie ma configured=false.");

            var saved = await Put(h.Admin, freshPath, Save(fresh, Doc([])));

            Expect(saved.GetProperty("configuration").GetProperty("configured").GetBoolean() &&
                   saved.GetProperty("configuration").GetProperty("blocks").GetArrayLength() == 0,
                "Pusty zapisany uklad zostal pomylony z domyslnym paskiem.");

            await Put(h.Admin, freshPath, Save(saved, Doc([], configured: false)), 400);
        });

        await h.Run("startpage v2: odczyt zapisanej v1 zachowuje sekcje i nie zapisuje migracji", async () =>
        {
            var folder = await h.Create(a, "folder", "Migracja v1", "root:toolbar");
            var old = await h.Get(h.Admin, path);
            var version = old.GetProperty("settingsVersion").GetInt64() + 1;
            var legacy = JsonSerializer.Serialize(new
            {
                version = 1,
                sections = new[] { new { id = "legacy", folderId = folder.Id, title = "Moja sekcja" } },
                engines = Array.Empty<object>(),
            });

            var db = new Database(h.Config);
            await db.WriteAsync((c, tx) => Database.Exec(c,
                "UPDATE profiles SET settings=@s, settings_version=@v WHERE id=@p",
                tx, ("@s", legacy), ("@v", version), ("@p", a.ProfileId)));

            var head = await h.Head(a);
            var migrated = await h.Get(a.Client, "/api/v1/startpage");
            var config = migrated.GetProperty("configuration");
            var block = config.GetProperty("blocks")[0];

            Expect(config.GetProperty("version").GetInt32() == 2 &&
                   config.GetProperty("template").GetString() == "classic" &&
                   config.GetProperty("configured").GetBoolean() &&
                   block.GetProperty("type").GetString() == "folder" &&
                   block.GetProperty("id").GetString() == "legacy" &&
                   block.GetProperty("folderId").GetString() == folder.Id &&
                   block.GetProperty("title").GetString() == "Moja sekcja",
                "Konwersja v1 utracila sekcje.");

            var stored = db.Read(c => (string)Database.Scalar(c,
                "SELECT settings FROM profiles WHERE id=@p", null, ("@p", a.ProfileId))!);

            Expect(stored == legacy &&
                   migrated.GetProperty("settingsVersion").GetInt64() == version &&
                   await h.Head(a) == head,
                "Sam odczyt zmienil settings, wersje lub seq.");
        });

        await h.Run("startpage v2: mieszane bloki, cztery szablony i niezaleznosc od zakladek", async () =>
        {
            var folder = await h.Create(a, "folder", "Folder v2", "root:toolbar");
            var head = await h.Head(a);
            var stamp = await h.Get(h.Admin, path);

            foreach (var template in new[] { "classic", "compact", "glass", "live" })
            {
                stamp = await Put(h.Admin, path, Save(stamp, Doc(
                [
                    new { id = "folder", type = "folder", folderId = folder.Id },
                    Custom("custom", Tile("one"), Tile("two", "http://example.test/")),
                    new { id = "top", type = "top", title = "Najczesciej" },
                ], template)));

                var blocks = stamp.GetProperty("configuration").GetProperty("blocks");
                Expect(blocks.GetArrayLength() == 3 &&
                       blocks[0].GetProperty("available").GetBoolean() &&
                       blocks[1].GetProperty("tiles")[0].GetProperty("color").GetString() == "#AABBCC" &&
                       stamp.GetProperty("configuration").GetProperty("template").GetString() == template,
                    "Niepoprawny mieszany dokument.");
            }

            Expect(await h.Head(a) == head, "Wlasne kafelki zmienily dziennik zakladek.");
        });

        await h.Run("startpage v2: limity, unikalnosc ID, schematy URL i rodzaje blokow", async () =>
        {
            var stamp = await h.Get(h.Admin, path);
            var invalid = new List<object>
            {
                Doc([], "unknown"),
                Doc([new { id = "x", type = "unknown" }]),
                Doc([Custom("x", Tile("a", "javascript:alert(1)"))]),
                Doc([Custom("x", Tile("a", "data:text/html,test"))]),
                Doc([Custom("x", Tile("a", "file:///C:/test"))]),
                Doc([Custom("x", Tile("a", "https://user:pass@example.test/"))]),
                Doc([Custom("x", Tile("same")), Custom("y", Tile("same"))]),
                Doc([Custom("same"), Custom("same")]),
                Doc([new { id = "t1", type = "top" }, new { id = "t2", type = "top" }]),
                Doc([new { id = "top", type = "top", tiles = Array.Empty<object>() }]),
                Doc([new { id = "bad", type = "custom", folderId = Id(), tiles = Array.Empty<object>() }]),
                Doc([Custom("many", Enumerable.Range(0, 201).Select(i => Tile("t" + i)).ToArray())]),
                Doc(Enumerable.Range(0, 65).Select(i => Custom("b" + i)).ToArray()),
            };

            foreach (var document in invalid)
                await Put(h.Admin, path, Save(stamp, document), 400);

            var after = await h.Get(h.Admin, path);
            Expect(after.GetProperty("settingsVersion").GetInt64() ==
                   stamp.GetProperty("settingsVersion").GetInt64(),
                "Odrzucony dokument zmienil wersje.");

            // Stary panel nie moze skasowac blokow custom/top przez zapis v1.
            await Put(h.Admin, path, Save(stamp, new
            {
                version = 1,
                sections = Array.Empty<object>(),
                engines = Array.Empty<object>(),
            }), 400);
        });

        await h.Run("startpage v2: urzadzenie zmienia tylko custom, profil pochodzi z tokenu", async () =>
        {
            var folder = await h.Create(a, "folder", "Chroniony folder", "root:toolbar");
            var stamp = await h.Get(h.Admin, path);
            stamp = await Put(h.Admin, path, Save(stamp, Doc(
            [
                new { id = "f", type = "folder", folderId = folder.Id },
                Custom("c1", Tile("old1")),
                new { id = "t", type = "top" },
                Custom("c2", Tile("old2")),
            ], "glass")));

            var head = await h.Head(a);
            var changed = await Put(a.Client,
                "/api/v1/startpage/custom?profileId=" + other.ProfileId,
                CustomSave(stamp, Custom("c2", Tile("new2")),
                    Custom("c1", Tile("new1")), Custom("c3", Tile("new3"))));

            var config = changed.GetProperty("configuration");
            var blocks = config.GetProperty("blocks");
            Expect(changed.GetProperty("profileId").GetString() == a.ProfileId &&
                   config.GetProperty("template").GetString() == "glass" &&
                   string.Join(",", blocks.EnumerateArray().Select(b => b.GetProperty("id").GetString())) ==
                   "f,c2,t,c1,c3" &&
                   blocks[0].GetProperty("folderId").GetString() == folder.Id,
                "Urzadzenie zmienilo chroniona czesc konfiguracji.");

            await Put(a.Client, "/api/v1/startpage/custom",
                CustomSave(changed, new { id = "f", type = "folder", folderId = folder.Id }), 400);

            await Put(a.Client, "/api/v1/startpage/custom", new
            {
                generation = changed.GetProperty("generation").GetString(),
                settingsVersion = changed.GetProperty("settingsVersion").GetInt64(),
                blocks = Array.Empty<object>(),
                template = "live",
            }, 400);

            var foreign = await h.Get(other.Client, "/api/v1/startpage");
            Expect(foreign.GetProperty("profileId").GetString() == other.ProfileId &&
                   foreign.GetProperty("configuration").GetProperty("blocks").GetArrayLength() == 0,
                "Zmiana wyciekla do innego profilu.");
            Expect(await h.Head(a) == head, "Edycja custom zmienila seq.");

            using var noToken = await Send(h.Anonymous, HttpMethod.Put,
                "/api/v1/startpage/custom", CustomSave(changed));
            await Json(noToken, 401);

            var audit = await h.Get(h.Admin, "/admin/api/state");
            Expect(audit.GetProperty("audit").EnumerateArray().Any(e =>
                    e.GetProperty("kind").GetString() == "startpage-settings" &&
                    e.GetProperty("actor").GetString() == a.Id),
                "Brak audytu edycji urzadzenia.");
        });

        await h.Run("startpage v2: rownolegly panel i urzadzenie daja jedno 200 i jedno 409", async () =>
        {
            var stamp = await h.Get(h.Admin, path);
            Task<HttpResponseMessage>[] pending;

            await using (var pause = await h.HoldWrites())
            {
                pending =
                [
                    Send(h.Admin, HttpMethod.Put, path, Save(stamp, Doc([Custom("admin", Tile("a"))]))),
                    Send(a.Client, HttpMethod.Put, "/api/v1/startpage/custom",
                        CustomSave(stamp, Custom("device", Tile("d")))),
                ];
                await Task.Delay(150);
            }

            var responses = await Task.WhenAll(pending);
            try
            {
                Expect(responses.Count(r => (int)r.StatusCode == 200) == 1 &&
                       responses.Count(r => (int)r.StatusCode == 409) == 1,
                    "Dwa zapisy tej samej wersji zostaly przyjete.");

                var winner = await Json(responses.Single(r => (int)r.StatusCode == 200));
                var loser = await Json(responses.Single(r => (int)r.StatusCode == 409), 409);

                Expect(loser.GetProperty("error").GetString() == "STARTPAGE_CHANGED" &&
                       loser.GetProperty("current").GetRawText() == winner.GetRawText() &&
                       winner.GetProperty("settingsVersion").GetInt64() ==
                       stamp.GetProperty("settingsVersion").GetInt64() + 1,
                    "Konflikt nie oddaje zwycieskiego dokumentu.");
            }
            finally
            {
                foreach (var response in responses) response.Dispose();
            }
        });

        await h.Run("startpage v2: tlo ma osobna wersje, ETag, limity, izolacje i CSRF", async () =>
        {
            var stamp = await h.Get(h.Admin, path);
            var head = await h.Head(a);

            using (var missing = await Send(a.Client, HttpMethod.Get, "/api/v1/startpage/background"))
                await Json(missing, 404);

            JsonElement uploaded;
            using (var response = await Send(h.Admin, HttpMethod.Put,
                       BackgroundPath(a.ProfileId, stamp), bytes: Png))
                uploaded = await Json(response);

            Expect(uploaded.GetProperty("backgroundVersion").GetInt64() ==
                   stamp.GetProperty("backgroundVersion").GetInt64() + 1 &&
                   uploaded.GetProperty("settingsVersion").GetInt64() ==
                   stamp.GetProperty("settingsVersion").GetInt64() &&
                   uploaded.GetProperty("logoVersion").GetInt64() ==
                   stamp.GetProperty("logoVersion").GetInt64(),
                "Tlo zmienilo wersje innych danych.");

            string etag;
            using (var image = await Send(a.Client, HttpMethod.Get, "/api/v1/startpage/background"))
            {
                Expect(image.StatusCode == HttpStatusCode.OK &&
                       (await image.Content.ReadAsByteArrayAsync()).SequenceEqual(Png) &&
                       image.Headers.GetValues("X-FrogSync-Background-Version").Single() ==
                       uploaded.GetProperty("backgroundVersion").GetInt64().ToString(),
                    "Bledny odczyt tla.");
                etag = image.Headers.ETag!.ToString();
            }

            using (var cached = await Send(a.Client, HttpMethod.Get,
                       "/api/v1/startpage/background", etag: etag))
                Expect((int)cached.StatusCode == 304, "Tlo nie obsluguje ETag.");

            using (var foreign = await Send(other.Client, HttpMethod.Get, "/api/v1/startpage/background"))
                await Json(foreign, 404);

            using (var csrf = await Send(h.Admin, HttpMethod.Delete,
                       BackgroundPath(a.ProfileId, uploaded), csrf: false))
                await Json(csrf, 403);

            using (var bad = await Send(h.Admin, HttpMethod.Put,
                       BackgroundPath(a.ProfileId, uploaded),
                       bytes: System.Text.Encoding.UTF8.GetBytes("<svg/>")))
                await Json(bad, 400);

            using (var svg = await Send(h.Admin, HttpMethod.Put,
                       BackgroundPath(a.ProfileId, uploaded), bytes: Png, mime: "image/svg+xml"))
                await Json(svg, 415);

            using (var huge = await Send(h.Admin, HttpMethod.Put,
                       BackgroundPath(a.ProfileId, uploaded), bytes: new byte[2 * 1024 * 1024 + 1]))
                await Json(huge, 413);

            using (var stale = await Send(h.Admin, HttpMethod.Delete, BackgroundPath(a.ProfileId, stamp)))
                await Json(stale, 409);

            using (var removed = await Send(h.Admin, HttpMethod.Delete, BackgroundPath(a.ProfileId, uploaded)))
                await Json(removed);

            using (var missing = await Send(a.Client, HttpMethod.Get,
                       "/api/v1/startpage/background", etag: etag))
                await Json(missing, 404);

            Expect(await h.Head(a) == head, "Operacje tla zmienily seq.");
        });

        await h.Run("startpage v2: restore przywraca tlo, obniza wersje i zmienia ETag", () =>
            WithServer(async isolated =>
            {
                const string password = "FrogSync-v2-restore-2026!";
                var setup = await isolated.Post(isolated.Admin, "/admin/api/setup/start",
                    new { setupCode = isolated.SetupCode, password });
                var secret = setup.GetProperty("secret").GetString()!;
                var step = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30;
                await isolated.Post(isolated.Admin, "/admin/api/setup/finish",
                    new { setupCode = isolated.SetupCode, totp = Otp(secret, step) });

                var profileId = await isolated.Profile("V2 restore");
                var device = await isolated.Pair(profileId,
                    await isolated.PairCode(profileId, "V2"));
                var configPath = $"/admin/api/profiles/{profileId}/startpage";
                var initial = await isolated.Get(isolated.Admin, configPath);
                JsonElement first;

                using (var upload = await Send(isolated.Admin, HttpMethod.Put,
                           BackgroundPath(profileId, initial), bytes: Png))
                    first = await Json(upload);

                string etag;
                using (var image = await Send(device.Client, HttpMethod.Get, "/api/v1/startpage/background"))
                    etag = image.Headers.ETag!.ToString();

                var backup = await isolated.Post(isolated.Admin, "/admin/api/backup", new { });
                using (var changed = await Send(isolated.Admin, HttpMethod.Put,
                           BackgroundPath(profileId, first), bytes: Png))
                    await Json(changed);

                await isolated.Post(isolated.Admin, "/admin/api/restore",
                    new { name = backup.GetProperty("file").GetString()! });

                var restored = await isolated.Get(device.Client, "/api/v1/startpage");
                Expect(restored.GetProperty("generation").GetString() !=
                       first.GetProperty("generation").GetString() &&
                       restored.GetProperty("backgroundVersion").GetInt64() ==
                       first.GetProperty("backgroundVersion").GetInt64(),
                    "Restore nie przywrocil wersji tla.");

                using (var image = await Send(device.Client, HttpMethod.Get,
                           "/api/v1/startpage/background", etag: etag))
                {
                    Expect(image.StatusCode == HttpStatusCode.OK &&
                           image.Headers.ETag!.ToString() != etag &&
                           (await image.Content.ReadAsByteArrayAsync()).SequenceEqual(Png),
                        "Tlo nowej generacji dostalo stary ETag albo inne bajty.");
                }

                var loginStep = Math.Max(step + 1, DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30);
                await isolated.Post(isolated.Admin, "/admin/api/login",
                    new { password, totp = Otp(secret, loginStep) });

                using var stale = await Send(isolated.Admin, HttpMethod.Delete,
                    BackgroundPath(profileId, first));
                await Json(stale, 409);
            }));
    }
}
