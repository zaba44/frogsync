using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using FrogSync.Server;
using FrogSync.Server.Infrastructure;
using FrogSync.Server.Sync;
using Microsoft.AspNetCore.Builder;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using static Harness;

var h = new Harness();

try
{
    await h.Start();

    const string password = "FrogSync-testowe-haslo-2026!";
    var secret = "";
    long setupStep = -1;
    var configured = false;

    await h.Run("setup: bledny kod, slabe haslo, 2FA, sesja, ponowna konfiguracja", async () =>
    {
        var initial = await h.Get(h.Admin, "/admin/api/status");
        Expect(!initial.GetProperty("configured").GetBoolean(), "Swieza baza ma administratora.");

        var wrong = h.SetupCode == "AAAA-AAAA" ? "BBBB-BBBB" : "AAAA-AAAA";
        await h.Post(h.Admin, "/admin/api/setup/start", new { setupCode = wrong, password }, 400);

        var weak = await h.Post(h.Admin, "/admin/api/setup/start",
            new { setupCode = h.SetupCode, password = "abc" }, 400);
        Expect(weak.GetProperty("error").GetString() == "WEAK_PASSWORD", "Brak walidacji hasla.");

        var start = await h.Post(h.Admin, "/admin/api/setup/start",
            new { setupCode = h.SetupCode, password });

        secret = start.GetProperty("secret").GetString()!;
        Expect(!string.IsNullOrEmpty(secret), "Brak sekretu TOTP.");
        Expect(start.GetProperty("uri").GetString()!.StartsWith("otpauth://totp/"),
            "Niepoprawny URI aplikacji 2FA.");

        setupStep = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30;
        await h.Post(h.Admin, "/admin/api/setup/finish",
            new { setupCode = h.SetupCode, totp = Otp(secret, setupStep) });

        var status = await h.Get(h.Admin, "/admin/api/status");
        Expect(status.GetProperty("configured").GetBoolean(), "Nie zapisano administratora.");
        Expect(status.GetProperty("signedIn").GetBoolean(), "Cookie nie daje sesji administratora.");

        configured = true;

        await h.Post(h.Admin, "/admin/api/setup/start",
            new { setupCode = h.SetupCode, password }, 409);
    });

    if (!configured)
        throw new InvalidOperationException("Brak konfiguracji: dalsze testy nie maja podstaw.");

    await h.Run("login: zle haslo, poprawne logowanie, replay TOTP, blokada po 5 bledach", async () =>
    {
        var loginClient = h.NewClient();

        // Setup zuzyl swoj krok; kolejny jest dozwolony w oknie +1.
        var step = Math.Max(setupStep + 1, DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30 + 1);
        var code = Otp(secret, step);

        await h.Post(loginClient, "/admin/api/login",
            new { password = "zle-haslo", totp = code }, 401);

        await h.Post(loginClient, "/admin/api/login", new { password, totp = code });

        Expect((await h.Get(loginClient, "/admin/api/status"))
            .GetProperty("signedIn").GetBoolean(), "Poprawne logowanie nie utworzylo sesji.");

        // Sukces wyzerowal licznik; replay jest pierwszym bledem.
        await h.Post(loginClient, "/admin/api/login", new { password, totp = code }, 401);

        for (var i = 0; i < 4; i++)
            await h.Post(loginClient, "/admin/api/login",
                new { password = "zle-haslo", totp = code }, 401);

        var locked = await h.Post(loginClient, "/admin/api/login",
            new { password, totp = code }, 429);

        Expect(locked.GetProperty("error").GetString() == "LOCKED", "Brak blokady logowania.");
    });

    await h.Run("CSRF: zapis bez X-FrogSync jest zabroniony", async () =>
    {
        var result = await h.Post(h.Admin, "/admin/api/profiles",
            new { name = "Nie powinien powstac" }, 403, csrf: false);

        Expect(result.GetProperty("error").GetString() == "CSRF", "Nie zadzialal filtr CSRF.");
    });

    Device? a = null, b = null, other = null;
    var profile = "";

    await h.Run("parowanie: profile, bledny kod, tokeny trzech urzadzen, kod jednorazowy", async () =>
    {
        profile = await h.Profile("Testowy A");
        var otherProfile = await h.Profile("Testowy B");

        var pairCode = await h.PairCode(profile, "Firefox A");
        var bad = pairCode == "000000" ? "999999" : "000000";

        await h.Post(h.Anonymous, "/api/v1/pair", new { code = bad, browser = "test" }, 400);
        a = await h.Pair(profile, pairCode);

        await h.Post(h.Anonymous, "/api/v1/pair",
            new { code = pairCode, browser = "test" }, 400);

        b = await h.Pair(profile, await h.PairCode(profile, "Chromium B"));
        other = await h.Pair(otherProfile, await h.PairCode(otherProfile, "Firefox C"));

        Expect(a.Id != b.Id && a.Id != other.Id && b.Id != other.Id,
            "Identyfikatory urzadzen nie sa rozne.");
    });

    if (a is null || b is null || other is null)
        throw new InvalidOperationException("Brak sparowanych urzadzen: dalsze testy przerwane.");

    var deviceA = a;
    var deviceB = b;
    var deviceOther = other;

    await h.Run("parowanie: 5 blednych kodow z jednego IP powoduje 429", async () =>
    {
        // Wszystkie wygenerowane kody juz zuzyto; ostatni sukces wyzerowal licznik IP.
        for (var i = 0; i < 5; i++)
            await h.Post(h.Anonymous, "/api/v1/pair",
                new { code = "000000", browser = "test" }, 400);

        var locked = await h.Post(h.Anonymous, "/api/v1/pair",
            new { code = "000000", browser = "test" }, 429);

        Expect(locked.GetProperty("error").GetString() == "LOCKED", "Brak blokady parowania.");
    });

    await h.Run("hello: token i Origin", async () =>
    {
        await h.Get(h.Anonymous, "/api/v1/hello", 401);
        await h.Get(deviceA.Client, "/api/v1/hello", 403, origin: "https://evil");

        var hello = await h.Get(deviceA.Client, "/api/v1/hello", origin: "moz-extension://x");

        Expect(hello.GetProperty("server").GetString() == "FrogSync",
            "Niepoprawna identyfikacja serwera.");
        Expect(hello.GetProperty("profile").GetProperty("id").GetString() == profile,
            "Zly profil tokenu.");
        Expect(hello.GetProperty("device").GetProperty("id").GetString() == deviceA.Id,
            "Zle urzadzenie tokenu.");
        Expect(!string.IsNullOrEmpty(hello.GetProperty("generation").GetString()),
            "Brak generacji.");
    });

    await h.Run("CORS: tylko dla wtyczek, z obsluga preflight", async () =>
    {
        // Firefox nie dopasowuje uprawnienia z portem i bez tych naglowkow blokuje odpowiedz
        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/api/v1/pair/preview");
        preflight.Headers.Add("Origin", "moz-extension://abc");
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        preflight.Headers.Add("Access-Control-Request-Headers", "content-type,x-frogsync-version");
        using var pre = await h.Anonymous.SendAsync(preflight);
        Expect((int)pre.StatusCode == 204, $"Preflight: HTTP {(int)pre.StatusCode}.");
        Expect(pre.Headers.TryGetValues("Access-Control-Allow-Origin", out var allow) && allow.Single() == "moz-extension://abc",
            "Preflight bez Access-Control-Allow-Origin dla wtyczki.");

        using var health = new HttpRequestMessage(HttpMethod.Get, "/healthz");
        health.Headers.Add("Origin", "moz-extension://abc");
        using var ok = await h.Anonymous.SendAsync(health);
        Expect(ok.Headers.Contains("Access-Control-Allow-Origin"), "healthz bez CORS dla wtyczki.");

        using var foreign = new HttpRequestMessage(HttpMethod.Get, "/healthz");
        foreign.Headers.Add("Origin", "https://evil.example");
        using var no = await h.Anonymous.SendAsync(foreign);
        Expect(!no.Headers.Contains("Access-Control-Allow-Origin"), "Strona WWW dostala naglowek CORS.");

        using var panel = new HttpRequestMessage(HttpMethod.Get, "/admin/api/status");
        panel.Headers.Add("Origin", "moz-extension://abc");
        using var adm = await h.Anonymous.SendAsync(panel);
        Expect(!adm.Headers.Contains("Access-Control-Allow-Origin"), "Panel admina dostal naglowek CORS.");
    });

    SyncOp? originalCreate = null;
    NodeDto? originalNode = null;

    await h.Run("ops: GUID, root:toolbar, poczatek, afterId, beforeId i porzadek ordinalny", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Folder", "root:toolbar");

        originalCreate = new SyncOp
        {
            ClientOpId = Id(),
            Type = "create",
            NodeId = Id(),
            Kind = "bookmark",
            ParentId = "root:toolbar",
            Title = "A",
            Url = "https://example.test/a",
            AfterId = folder.Id
        };

        originalNode = (await h.Op(deviceA, originalCreate)).Node!;

        Expect(Guid.TryParse(folder.Id, out _) && Guid.TryParse(originalNode.Id, out _), "Brak GUID.");

        var first = await h.Create(deviceA, "bookmark", "Poczatek", "root:toolbar");
        var after = await h.Create(deviceA, "bookmark", "Za pierwszym", "root:toolbar",
            afterId: first.Id, beforeId: folder.Id);
        var before = await h.Create(deviceA, "bookmark", "Przed A", "root:toolbar",
            beforeId: originalNode.Id);

        var ordered = (await h.Snapshot(deviceA)).Values
            .Where(n => !n.Deleted && n.ParentId == "root:toolbar")
            .OrderBy(n => n.Order, StringComparer.Ordinal)
            .ToArray();

        Expect(ordered.Select(n => n.Id).SequenceEqual(
            new[] { first.Id, after.Id, folder.Id, before.Id, originalNode.Id }),
            "Zla kolejnosc rodzenstwa.");

        Expect(ordered.Select(n => n.Order).Distinct(StringComparer.Ordinal).Count() == ordered.Length,
            "Klucze kolejnosci nie sa unikalne.");
    });

    await h.Run("ops: idempotencja nie tworzy nowego seq", async () =>
    {
        Expect(originalCreate is not null && originalNode is not null, "Brak operacji do powtorzenia.");

        var before = await h.Head(deviceA);
        var result = await h.Op(deviceA, originalCreate!);

        Expect(result.Duplicate, "Powtorzona operacja nie ma duplicate=true.");
        Expect(result.Node!.Id == originalNode!.Id && result.Node.Seq == originalNode.Seq,
            "Powtorzenie nie zwrocilo pierwotnego wezla.");
        Expect(await h.Head(deviceA) == before, "Powtorzenie podbilo seq.");

        var changes = await h.Page(deviceA, before);
        Expect(changes.Nodes.Count == 0 && changes.Next == before && !changes.More,
            "Powtorzenie dodalo wpis do zmian.");
    });

    await h.Run("ops: rownoczesna edycja tytulu zwraca title-changed", async () =>
    {
        var node = await h.Create(deviceA, "bookmark", "Tytul", "root:menu");

        var edited = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = node.Id,
            BaseVersion = node.Version,
            Title = "Zmiana A"
        });

        var before = await h.Head(deviceA);

        var conflict = await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = node.Id,
            BaseVersion = node.Version,
            Title = "Zmiana B"
        }, "conflict", "title-changed");

        Expect(conflict.Node!.Title == "Zmiana A", "Konflikt nadpisal cudzy tytul.");
        Expect(conflict.Node.Version == edited.Node!.Version, "Konflikt zmienil wersje.");
        Expect(await h.Head(deviceA) == before, "Konflikt podbil seq.");
    });

    await h.Run("ops: przeniesienie nie blokuje edycji tytulu ze stara wersja", async () =>
    {
        var node = await h.Create(deviceA, "bookmark", "Przenoszony", "root:menu");
        var neighbor = await h.Create(deviceA, "bookmark", "Sasiad", "root:menu", afterId: node.Id);

        var moved = await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "move",
            NodeId = node.Id,
            ParentId = "root:menu",
            AfterId = neighbor.Id,
            BaseVersion = node.Version
        });

        Expect(moved.Node!.Version > node.Version, "Przeniesienie nie zmienilo wersji.");

        var edited = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = node.Id,
            BaseVersion = node.Version,
            Title = "Nowy tytul"
        });

        Expect(edited.Node!.Title == "Nowy tytul" && edited.Node.Order == moved.Node.Order,
            "Edycja tytulu zgubila polozenie.");
    });

    await h.Run("ops: folderu nie mozna przeniesc do wlasnego dziecka", async () =>
    {
        var parent = await h.Create(deviceA, "folder", "Rodzic", "root:unsorted");
        var child = await h.Create(deviceA, "folder", "Dziecko", parent.Id);
        var before = await h.Head(deviceA);

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "move",
            NodeId = parent.Id,
            ParentId = child.Id,
            BaseVersion = parent.Version
        }, "rejected");

        var state = await h.Snapshot(deviceA);

        Expect(state[parent.Id].ParentId == "root:unsorted" && state[child.Id].ParentId == parent.Id,
            "Odrzucony ruch zmienil drzewo.");
        Expect(await h.Head(deviceA) == before, "Odrzucony ruch podbil seq.");
    });

    await h.Run("ops: delete folderu zwraca tombstone kazdego potomka", async () =>
    {
        var parent = await h.Create(deviceA, "folder", "Do usuniecia", "root:unsorted");
        var child = await h.Create(deviceA, "folder", "Podfolder", parent.Id);
        var leaf = await h.Create(deviceA, "bookmark", "Lisc", child.Id);

        // baseSeq opisuje stan po utworzeniu calego poddrzewa.
        var before = await h.Head(deviceA);

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = parent.Id,
            BaseVersion = parent.Version,
            BaseSeq = before
        });

        var changes = await h.Page(deviceA, before);
        var expected = new HashSet<string> { parent.Id, child.Id, leaf.Id };

        Expect(changes.Nodes.Count == 3 && changes.Nodes.All(n => n.Deleted),
            "Brak tombstone calego poddrzewa.");
        Expect(expected.SetEquals(changes.Nodes.Select(n => n.Id)), "Usunieto nie te wezly.");
        Expect(changes.Nodes.Select(n => n.Seq).Distinct().Count() == 3,
            "Potomkowie nie maja osobnych seq.");
    });

    await h.Run("ops: usuniecie po cudzej edycji zwraca edited-since", async () =>
    {
        var node = await h.Create(deviceA, "bookmark", "Zachowaj", "root:menu");

        await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = node.Id,
            BaseVersion = node.Version,
            Title = "Cudza edycja"
        });

        var before = await h.Head(deviceA);

        var conflict = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = node.Id,
            BaseVersion = node.Version
        }, "conflict", "edited-since");

        Expect(conflict.Node is { Deleted: false, Title: "Cudza edycja" },
            "Usunieto zmieniony wezel.");
        Expect(await h.Head(deviceA) == before, "Konflikt usuniecia podbil seq.");
    });

    await h.Run("ops: skasowane kotwice daja anchor-missing, force ustawia na koncu", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Kotwice", "root:unsorted");
        var keep = await h.Create(deviceA, "bookmark", "Pozostaje", folder.Id);
        var x = await h.Create(deviceA, "bookmark", "X", folder.Id, afterId: keep.Id);
        var y = await h.Create(deviceA, "bookmark", "Y", folder.Id, afterId: x.Id);
        var target = await h.Create(deviceA, "bookmark", "Cel", folder.Id, afterId: y.Id);

        foreach (var node in new[] { x, y })
        {
            await h.Op(deviceB, new SyncOp
            {
                ClientOpId = Id(),
                Type = "delete",
                NodeId = node.Id,
                BaseVersion = node.Version
            });
        }

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "move",
            NodeId = target.Id,
            ParentId = folder.Id,
            BaseVersion = target.Version,
            AfterId = x.Id,
            BeforeId = y.Id
        }, "conflict", "anchor-missing");

        // Rozstrzygniecie konfliktu wymaga nowego clientOpId.
        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "move",
            NodeId = target.Id,
            ParentId = folder.Id,
            BaseVersion = target.Version,
            AfterId = x.Id,
            BeforeId = y.Id,
            Force = true
        });

        var children = (await h.Snapshot(deviceA)).Values
            .Where(n => !n.Deleted && n.ParentId == folder.Id)
            .OrderBy(n => n.Order, StringComparer.Ordinal)
            .ToArray();

        Expect(children.Select(n => n.Id).SequenceEqual(new[] { keep.Id, target.Id }),
            "force nie umiescil wezla na koncu.");
    });

    await h.Run("changes: limit=2, more/next, powtorzenie strony i brak przeskoku kursora", async () =>
    {
        var expected = await h.Snapshot(deviceA);
        var generation = await h.Generation(deviceA);
        var collected = new Dictionary<string, NodeDto>();

        long cursor = 0;
        var sawMore = false;

        for (var pageNo = 0; ; pageNo++)
        {
            Expect(pageNo < 1000, "Petla stronicowania nie konczy sie.");

            var page = await h.Page(deviceA, cursor, 2, generation);
            Expect(page.Nodes.Count <= 2, "Przekroczono limit strony.");

            var previous = cursor;

            foreach (var node in page.Nodes)
            {
                // Globalne seq moga miec luki przez inne profile.
                Expect(node.Seq > previous, "Seq nie rosna scisle.");
                Expect(collected.TryAdd(node.Id, node), "Powtorzono wezel pomiedzy stronami.");
                previous = node.Seq;
            }

            Expect(page.Next == previous, "next przeskoczyl ponad ostatni zwrocony wezel.");
            Expect(page.Head >= page.Next, "next przekroczyl head.");

            var replay = await h.Page(deviceA, cursor, 2, generation);

            Expect(replay.Next == page.Next && replay.More == page.More
                && replay.Nodes.Select(n => n.Seq).SequenceEqual(page.Nodes.Select(n => n.Seq)),
                "Ponowienie tego samego kursora zmienilo strone.");

            if (page.More)
            {
                sawMore = true;
                Expect(page.Nodes.Count == 2 && page.Next > cursor && page.Next < page.Head,
                    "more nie odpowiada zawartosci strony.");
            }

            cursor = page.Next;
            if (!page.More) break;
        }

        Expect(sawMore, "Nie przetestowano wielu stron.");
        Expect(collected.Keys.ToHashSet().SetEquals(expected.Keys), "Stronicowanie zgubilo wezly.");

        foreach (var pair in expected)
        {
            Expect(JsonSerializer.Serialize(pair.Value) == JsonSerializer.Serialize(collected[pair.Key]),
                "Stronicowanie zmienilo dane wezla.");
        }

        var empty = await h.Page(deviceA, cursor, 2, generation);

        Expect(empty.Nodes.Count == 0 && !empty.More && empty.Next == cursor,
            "Pusta strona ruszyla kursor.");

        await h.Post(deviceA.Client, "/api/v1/cursor", new { cursor }, 204);
    });

    await h.Run("urzadzenia: zmiany sa wspolne w profilu i odizolowane miedzy profilami", async () =>
    {
        var fromA = await h.Create(deviceA, "bookmark", "Z A", "root:mobile");
        Expect((await h.Snapshot(deviceB)).ContainsKey(fromA.Id), "B nie widzi zmiany A.");

        var fromB = await h.Create(deviceB, "bookmark", "Z B", "root:mobile");
        Expect((await h.Snapshot(deviceA)).ContainsKey(fromB.Id), "A nie widzi zmiany B.");

        var isolated = await h.Snapshot(deviceOther);

        Expect(!isolated.ContainsKey(fromA.Id) && !isolated.ContainsKey(fromB.Id),
            "Wyciek danych do innego profilu.");
        Expect(isolated.Keys.ToHashSet().SetEquals(NodeKinds.RootIds),
            "Obcy profil ma nieoczekiwane wezly.");

        await h.Op(deviceOther, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = fromA.Id,
            BaseVersion = fromA.Version,
            Title = "Proba z obcego profilu"
        }, "rejected");

        Expect((await h.Snapshot(deviceA))[fromA.Id].Title == "Z A", "Obcy profil zmienil dane.");
    });

    // Regresje dzialaja przed odwolaniem urzadzenia B i nie wymagaja nowego parowania.
    await h.Run("regresja 1: lancuch 1001 folderow nie pozwala utworzyc cyklu", async () =>
    {
        var ids = Enumerable.Range(0, 1001).Select(_ => Id()).ToArray();

        var operations = ids.Select((id, i) => new SyncOp
        {
            ClientOpId = Id(),
            Type = "create",
            NodeId = id,
            Kind = "folder",
            Title = $"Poziom {i}",
            ParentId = i == 0 ? "root:mobile" : ids[i - 1]
        }).ToArray();

        foreach (var chunk in operations.Chunk(500))
        {
            var batch = await h.Batch(deviceA, chunk);

            Expect(batch.Results.Count == chunk.Length
                && batch.Results.All(r => r.Status == "applied"),
                "Nie utworzono lancucha folderow.");
        }

        var before = await h.Head(deviceA);

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "move",
            NodeId = ids[0],
            ParentId = ids[^1],
            BaseVersion = 1
        }, "rejected");

        Expect(await h.Head(deviceA) == before, "Odrzucony cykl zmienil head.");

        var state = await h.Snapshot(deviceA);

        for (var i = 0; i < ids.Length; i++)
        {
            Expect(state[ids[i]].ParentId == (i == 0 ? "root:mobile" : ids[i - 1]),
                "Odrzucony ruch zmienil lancuch.");
        }
    });

    await h.Run("regresja 2: baseSeq chroni cudze zmiany poddrzewa, force pozwala je usunac", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Ochrona poddrzewa", "root:toolbar");
        var child = await h.Create(deviceA, "bookmark", "Przed edycja", folder.Id);
        var baseSeq = await h.Head(deviceA);

        await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = child.Id,
            BaseVersion = child.Version,
            Title = "Edycja B po baseSeq"
        });

        var before = await h.Head(deviceA);

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = folder.Id,
            BaseVersion = folder.Version
        }, "rejected");

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = folder.Id,
            BaseVersion = folder.Version,
            BaseSeq = baseSeq
        }, "conflict", "subtree-changed");

        var state = await h.Snapshot(deviceA);

        Expect(!state[folder.Id].Deleted && !state[child.Id].Deleted
            && state[child.Id].Title == "Edycja B po baseSeq",
            "Konflikt skasowal cudza prace.");
        Expect(await h.Head(deviceA) == before, "Konflikt poddrzewa zmienil head.");

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = folder.Id,
            BaseVersion = folder.Version,
            BaseSeq = baseSeq,
            Force = true
        });

        state = await h.Snapshot(deviceA);
        Expect(state[folder.Id].Deleted && state[child.Id].Deleted, "force nie usunal poddrzewa.");
    });

    await h.Run("regresja 3: life_v chroni przywrocony wpis przed starym delete", async () =>
    {
        var node = await h.Create(deviceA, "bookmark", "Przywroc i zachowaj", "root:menu");

        var deleted = (await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = node.Id,
            BaseVersion = node.Version
        })).Node!;

        // Bez zmiany tytulu: ochrona musi pochodzic z life_v.
        var restored = (await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = node.Id,
            BaseVersion = deleted.Version,
            Force = true
        })).Node!;

        Expect(!restored.Deleted && restored.Version > deleted.Version, "Nie przywrocono wpisu.");

        var before = await h.Head(deviceA);

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = node.Id,
            BaseVersion = node.Version
        }, "conflict", "edited-since");

        Expect(!(await h.Snapshot(deviceA))[node.Id].Deleted,
            "Stary delete skasowal przywrocony wpis.");
        Expect(await h.Head(deviceA) == before, "Odrzucony stary delete zmienil head.");
    });

    await h.Run("regresja 4: 30 rownoleglych blednych parowan nie omija limitera", () =>
        WithServer(async isolated =>
        {
            // Swieza instancja: nie mozemy korzystac z poprzedniej blokady IP.
            Task<Reply>[] attempts;

            await using (var held = await isolated.HoldWrites())
            {
                attempts = Enumerable.Range(0, 30)
                    .Select(_ => isolated.PostRaw(
                        isolated.Anonymous,
                        "/api/v1/pair",
                        new { code = "000000", browser = "parallel-test" }))
                    .ToArray();

                await Task.Delay(300);
            }

            var replies = await Task.WhenAll(attempts);

            Expect(replies.All(r => r.Status is 400 or 429),
                "Parowanie zwrocilo nieoczekiwany status.");
            Expect(replies.Count(r => r.Status == 400) == 5,
                "Limiter przepuscil inna liczbe niz 5 blednych prob.");
            Expect(replies.Count(r => r.Status == 429) == 25,
                "Brak blokady pozostalych prob.");
            Expect(replies.Where(r => r.Status == 429)
                .All(r => r.Body.GetProperty("error").GetString() == "LOCKED"),
                "Zly powod HTTP 429.");
        }));

    await h.Run("regresja 5: przywrocenie po zajeciu order_key nie blokuje kolejnych wstawien", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Przywracanie kolejnosci", "root:toolbar");
        var old = await h.Create(deviceA, "bookmark", "Stary", folder.Id);

        var deleted = (await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(),
            Type = "delete",
            NodeId = old.Id,
            BaseVersion = old.Version
        })).Node!;

        var replacement = await h.Create(deviceA, "bookmark", "Zajmuje dawny klucz", folder.Id);

        Expect(replacement.Order == old.Order, "Nie przygotowano kolizji klucza.");

        var restored = (await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = old.Id,
            BaseVersion = deleted.Version,
            Force = true
        })).Node!;

        Expect(!restored.Deleted && restored.Order != replacement.Order,
            "Przywrocenie zdublowalo klucz.");

        var middle = await h.Create(deviceA, "bookmark", "Pomiedzy", folder.Id,
            afterId: replacement.Id, beforeId: restored.Id);

        var children = (await h.Snapshot(deviceA)).Values
            .Where(n => !n.Deleted && n.ParentId == folder.Id)
            .OrderBy(n => n.Order, StringComparer.Ordinal)
            .ToArray();

        Expect(children.Select(n => n.Id).SequenceEqual(
            new[] { replacement.Id, middle.Id, restored.Id }),
            "Nie zachowano kolejnosci po przywroceniu.");

        Expect(children.Select(n => n.Order).Distinct(StringComparer.Ordinal).Count() == children.Length,
            "Aktywne rodzenstwo ma zduplikowane klucze.");
    });

    await h.Run("regresja 7: wszystkie strony sa buforowane, rodzice stosowani przed dziecmi", async () =>
    {
        var persistedCursor = await h.Head(deviceA);
        var baseline = persistedCursor;
        var generation = await h.Generation(deviceA);

        var parent = await h.Create(deviceA, "folder", "Rodzic przed zmiana", "root:toolbar");
        var child = await h.Create(deviceA, "bookmark", "Dziecko", parent.Id);

        await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = parent.Id,
            BaseVersion = parent.Version,
            Title = "Rodzic po zmianie"
        });

        var cursor = baseline;
        var buffer = new Dictionary<string, NodeDto>();
        var arrival = new List<string>();
        var pages = 0;

        while (true)
        {
            Expect(++pages <= 10, "Nie zakonczono pobierania regresji 7.");

            var page = await h.Page(deviceA, cursor, 1, generation);

            foreach (var node in page.Nodes)
            {
                buffer[node.Id] = node;
                arrival.Add(node.Id);
            }

            Expect(persistedCursor == baseline,
                "Zapisano kursor przed zastosowaniem wszystkich stron.");

            cursor = page.Next;
            if (!page.More) break;
        }

        Expect(pages >= 2
            && arrival.IndexOf(child.Id) >= 0
            && arrival.IndexOf(child.Id) < arrival.IndexOf(parent.Id),
            "Nie odtworzono dziecka przed rodzicem.");

        var applied = NodeKinds.RootIds.ToHashSet(StringComparer.Ordinal);
        var ordered = ParentsFirst(buffer.Values, applied);

        Expect(ordered.FindIndex(n => n.Id == parent.Id) < ordered.FindIndex(n => n.Id == child.Id),
            "Nie ulozono rodzicow przed dziecmi.");

        foreach (var node in ordered)
        {
            Expect(node.ParentId is null || applied.Contains(node.ParentId),
                "Stosowanie dziecka bez rodzica.");

            applied.Add(node.Id);
        }

        Expect(applied.Contains(parent.Id) && applied.Contains(child.Id),
            "Nie zastosowano calego bufora.");

        persistedCursor = cursor;

        Expect(persistedCursor == await h.Head(deviceA),
            "Zapisano niewlasciwy koncowy kursor.");

        await h.Post(deviceA.Client, "/api/v1/cursor", new { cursor = persistedCursor }, 204);
    });

    await h.Run("regresja 8: idempotencja jest per urzadzenie i sprawdza payload", async () =>
    {
        var shared = Id();

        var opA = new SyncOp
        {
            ClientOpId = shared,
            Type = "create",
            NodeId = Id(),
            Kind = "bookmark",
            ParentId = "root:menu",
            Title = "Idempotencja A",
            Url = "https://example.test/id-a"
        };

        var opB = new SyncOp
        {
            ClientOpId = shared,
            Type = "create",
            NodeId = Id(),
            Kind = "bookmark",
            ParentId = "root:menu",
            Title = "Idempotencja B",
            Url = "https://example.test/id-b"
        };

        var first = await h.Op(deviceA, opA);
        var second = await h.Op(deviceB, opB);

        Expect(!first.Duplicate && !second.Duplicate && first.Node!.Id != second.Node!.Id,
            "Identyczny clientOpId z dwoch urzadzen zlal operacje.");

        var before = await h.Head(deviceA);

        Expect((await h.Op(deviceA, opA)).Duplicate, "Nie rozpoznano identycznej operacji.");

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = shared,
            Type = "create",
            NodeId = opA.NodeId,
            Kind = "bookmark",
            ParentId = opA.ParentId,
            Title = "Inny payload",
            Url = opA.Url
        }, "rejected");

        Expect(await h.Head(deviceA) == before, "Powtorzenie lub inny payload podbil seq.");

        var state = await h.Snapshot(deviceA);

        Expect(state[opA.NodeId].Title == opA.Title && state[opB.NodeId].Title == opB.Title,
            "Ponowne uzycie ID zmienilo zapisane dane.");

        Expect((await h.Op(deviceA, opA)).Duplicate,
            "Odrzucony payload zniszczyl pierwotny wynik.");

        var changed = (await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = opA.NodeId,
            BaseVersion = first.Node!.Version,
            Title = "Tytul B"
        })).Node!;

        var conflicting = new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = opA.NodeId,
            BaseVersion = first.Node.Version,
            Title = "Stary zamiar A"
        };

        var conflict = await h.Op(deviceA, conflicting, "conflict", "title-changed");

        await h.Op(deviceB, new SyncOp
        {
            ClientOpId = Id(),
            Type = "update",
            NodeId = opA.NodeId,
            BaseVersion = changed.Version,
            Title = "Jeszcze nowszy tytul B"
        });

        before = await h.Head(deviceA);

        var conflictReplay = await h.Op(deviceA, conflicting, "conflict", "title-changed");

        Expect(conflictReplay.Duplicate && conflictReplay.Node!.Version == conflict.Node!.Version,
            "Nie odtworzono zapisanego wyniku conflict.");

        var rejected = new SyncOp
        {
            ClientOpId = Id(),
            Type = "create",
            NodeId = Id(),
            Kind = "invalid-kind",
            ParentId = "root:menu",
            Title = "Odrzuc"
        };

        await h.Op(deviceA, rejected, "rejected");

        Expect((await h.Op(deviceA, rejected, "rejected")).Duplicate,
            "Nie odtworzono rejected.");

        Expect(await h.Head(deviceA) == before, "Powtorzenie conflict/rejected podbilo seq.");
    });

    await h.Run("regresja 9: rownolegle setup/finish daje jedno 200 i jedno 409", () =>
        WithServer(async isolated =>
        {
            var start = await isolated.Post(isolated.Admin, "/admin/api/setup/start",
                new { setupCode = isolated.SetupCode, password });

            var setupSecret = start.GetProperty("secret").GetString()!;
            var code = Otp(setupSecret, DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30);
            var clients = new[] { isolated.NewClient(), isolated.NewClient() };

            Task<Reply>[] attempts;

            await using (var held = await isolated.HoldWrites())
            {
                attempts = clients.Select(client => isolated.PostRaw(
                    client,
                    "/admin/api/setup/finish",
                    new { setupCode = isolated.SetupCode, totp = code }))
                    .ToArray();

                await Task.Delay(300);
            }

            var replies = await Task.WhenAll(attempts);

            Expect(replies.Count(r => r.Status == 200) == 1
                && replies.Count(r => r.Status == 409) == 1,
                "Rownolegly setup nie zwrocil jednego sukcesu i jednego konfliktu.");

            var loser = Array.FindIndex(replies, r => r.Status == 409);
            var winner = 1 - loser;

            Expect(replies[loser].Body.GetProperty("error").GetString() == "ALREADY_CONFIGURED",
                "Niewlasciwy powod odrzucenia drugiego setup.");

            Expect((await isolated.Get(clients[winner], "/admin/api/status"))
                .GetProperty("signedIn").GetBoolean(), "Zwyciezca nie ma sesji.");

            Expect(!(await isolated.Get(clients[loser], "/admin/api/status"))
                .GetProperty("signedIn").GetBoolean(), "Przegrany dostal sesje.");
        }));

    // Pomocniki etapu 3.2. Bez zaleznosci od prywatnych metod Harness.
    async Task<HttpResponseMessage> SpSend(
        HttpClient client,
        HttpMethod method,
        string path,
        object? body = null,
        byte[]? bytes = null,
        string? mime = null,
        string? etag = null,
        bool csrf = true)
    {
        using var request = new HttpRequestMessage(method, path);

        if (csrf && path.StartsWith("/admin/api/", StringComparison.Ordinal))
            request.Headers.Add("X-FrogSync", "1");

        if (etag is not null)
            request.Headers.TryAddWithoutValidation("If-None-Match", etag);

        if (bytes is not null)
        {
            request.Content = new ByteArrayContent(bytes);
            request.Content.Headers.ContentType =
                new MediaTypeHeaderValue(mime ?? "image/png");
        }
        else if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await client.SendAsync(request);
    }

    async Task<JsonElement> SpJson(HttpResponseMessage response, int expected = 200)
    {
        Expect((int)response.StatusCode == expected,
            $"Startpage: oczekiwano HTTP {expected}, jest {(int)response.StatusCode}.");

        using var document = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync());

        return document.RootElement.Clone();
    }

    async Task<JsonElement> SpPut(
        HttpClient client, string path, object body, int expected = 200)
    {
        using var response = await SpSend(client, HttpMethod.Put, path, body);
        return await SpJson(response, expected);
    }

    object SpDocument(
        string folderId,
        string title = "Sekcja testowa",
        string url = "https://example.test/search?q=%s") =>
        new
        {
            version = 1,
            sections = new[] { new { id = "main", folderId, title } },
            engines = new[]
            {
                new
                {
                    id = "test",
                    name = "Test",
                    url,
                    color = "#123ABC",
                    suggest = "none",
                },
            },
        };

    object SpSaveBody(JsonElement stamp, object document) =>
        new
        {
            generation = stamp.GetProperty("generation").GetString(),
            settingsVersion = stamp.GetProperty("settingsVersion").GetInt64(),
            configuration = document,
        };

    string SpLogoPath(string profileId, JsonElement stamp) =>
        $"/admin/api/profiles/{profileId}/startpage/logo" +
        $"?generation={Uri.EscapeDataString(stamp.GetProperty("generation").GetString()!)}" +
        $"&logoVersion={stamp.GetProperty("logoVersion").GetInt64()}";

    var spPath = $"/admin/api/profiles/{deviceA.ProfileId}/startpage";
    var spPng = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=");

    await h.Run("startpage: dokument profilu, odczyt urzadzenia, wersje niezalezne od seq", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Start 3.2", "root:toolbar");
        var before = await h.Get(h.Admin, spPath);
        var head = await h.Head(deviceA);

        var saved = await SpPut(h.Admin, spPath,
            SpSaveBody(before, SpDocument(folder.Id)));

        Expect(saved.GetProperty("profileId").GetString() == deviceA.ProfileId,
            "Odpowiedz dotyczy innego profilu.");
        Expect(saved.GetProperty("settingsVersion").GetInt64() ==
               before.GetProperty("settingsVersion").GetInt64() + 1,
            "Nie zwiekszono settingsVersion.");
        Expect(saved.GetProperty("logoVersion").GetInt64() ==
               before.GetProperty("logoVersion").GetInt64(),
            "Zapis konfiguracji zmienil wersje logo.");

        var section = saved.GetProperty("configuration").GetProperty("blocks")[0];

        Expect(section.GetProperty("available").GetBoolean() &&
               section.GetProperty("folderTitle").GetString() == folder.Title,
            "Brak dostepnosci albo nazwy folderu.");

        var downloaded = await h.Get(deviceA.Client, "/api/v1/startpage");

        Expect(downloaded.GetRawText() == saved.GetRawText(),
            "Urzadzenie dostalo inna konfiguracje niz panel.");
        Expect(await h.Head(deviceA) == head,
            "Konfiguracja strony startowej przesunela seq zakladek.");
    });

    await h.Run("startpage: walidacja folderow, duplikatow, wyszukiwarek i limitow", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Walidacja", "root:toolbar");
        var bookmark = await h.Create(deviceA, "bookmark", "Nie folder", "root:toolbar");
        var foreign = await h.Create(deviceOther, "folder", "Inny profil", "root:toolbar");
        var stamp = await h.Get(h.Admin, spPath);

        var invalid = new List<object>
        {
            SpDocument(bookmark.Id),
            SpDocument(foreign.Id),
            SpDocument(Id()),
            SpDocument("root:toolbar"),
            SpDocument(folder.Id, url: "http://example.test/?q=%s"),
            SpDocument(folder.Id, url: "https://example.test/search"),
            SpDocument(folder.Id, url: "https://example.test/?q=%s&again=%s"),
            SpDocument(folder.Id, url: "https://%s.example.test/search"),
            SpDocument(folder.Id, url: "https://user:pass@example.test/?q=%s"),
            new
            {
                version = 1,
                sections = new[]
                {
                    new { id = "first", folderId = folder.Id },
                    new { id = "second", folderId = folder.Id.ToUpperInvariant() },
                },
                engines = Array.Empty<object>(),
            },
            new
            {
                version = 1,
                sections = Array.Empty<object>(),
                engines = new[]
                {
                    new
                    {
                        id = "bad", name = "Bad",
                        url = "https://example.test/?q=%s",
                        color = "red", suggest = "none",
                    },
                },
            },
            new
            {
                version = 1,
                sections = Enumerable.Range(0, 65)
                    .Select(i => new { id = "s" + i, folderId = Id() }).ToArray(),
                engines = Array.Empty<object>(),
            },
            new
            {
                version = 1,
                sections = Array.Empty<object>(),
                engines = Enumerable.Range(0, 33).Select(i => new
                {
                    id = "e" + i, name = "Engine",
                    url = "https://example.test/?q=%s",
                    color = "#123456", suggest = "none",
                }).ToArray(),
            },
            new { version = 2, sections = Array.Empty<object>(), engines = Array.Empty<object>() },
            new { version = 1, sections = (object?)null, engines = Array.Empty<object>() },
        };

        foreach (var document in invalid)
            await SpPut(h.Admin, spPath, SpSaveBody(stamp, document), 400);

        var after = await h.Get(h.Admin, spPath);
        Expect(after.GetProperty("settingsVersion").GetInt64() ==
               stamp.GetProperty("settingsVersion").GetInt64(),
            "Odrzucony dokument zmienil wersje.");

        using var oversized = await SpSend(h.Admin, HttpMethod.Put, spPath,
            bytes: new byte[64 * 1024 + 1], mime: "application/json");
        await SpJson(oversized, 413);
    });

    await h.Run("startpage: rownolegle zapisy jednej wersji daja sukces i 409 z aktualnym dokumentem", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Rownolegle", "root:toolbar");
        var stamp = await h.Get(h.Admin, spPath);
        Task<HttpResponseMessage>[] pending;

        await using (var pause = await h.HoldWrites())
        {
            pending =
            [
                SpSend(h.Admin, HttpMethod.Put, spPath,
                    SpSaveBody(stamp, SpDocument(folder.Id, "Pierwsza"))),
                SpSend(h.Admin, HttpMethod.Put, spPath,
                    SpSaveBody(stamp, SpDocument(folder.Id, "Druga"))),
            ];

            await Task.Delay(150);
        }

        var responses = await Task.WhenAll(pending);

        try
        {
            Expect(responses.Count(r => (int)r.StatusCode == 200) == 1 &&
                   responses.Count(r => (int)r.StatusCode == 409) == 1,
                "Dwa zapisy tej samej wersji nie zostaly rozstrzygniete atomowo.");

            var winner = await SpJson(responses.Single(r => (int)r.StatusCode == 200));
            var loser = await SpJson(responses.Single(r => (int)r.StatusCode == 409), 409);

            Expect(loser.GetProperty("error").GetString() == "STARTPAGE_CHANGED",
                "Niepoprawny blad konfliktu.");
            Expect(loser.GetProperty("current").GetRawText() == winner.GetRawText(),
                "409 nie zawiera aktualnej konfiguracji.");

            var current = await h.Get(h.Admin, spPath);
            Expect(current.GetProperty("settingsVersion").GetInt64() ==
                   stamp.GetProperty("settingsVersion").GetInt64() + 1,
                "Konflikt zwiekszyl wersje drugi raz.");
        }
        finally
        {
            foreach (var response in responses)
                response.Dispose();
        }
    });

    await h.Run("startpage: ETag, zmiana nazwy i usuniecie folderu bez utraty sekcji", async () =>
    {
        var folder = await h.Create(deviceA, "folder", "Pierwotna nazwa", "root:toolbar");
        var stamp = await h.Get(h.Admin, spPath);

        await SpPut(h.Admin, spPath, SpSaveBody(stamp, SpDocument(folder.Id)));

        using var first = await SpSend(deviceA.Client, HttpMethod.Get, "/api/v1/startpage");
        var firstBody = await SpJson(first);
        var etag = first.Headers.ETag?.ToString();
        Expect(!string.IsNullOrEmpty(etag), "Brak ETag konfiguracji.");

        using (var cached = await SpSend(deviceA.Client, HttpMethod.Get,
                   "/api/v1/startpage", etag: "W/" + etag))
        {
            Expect((int)cached.StatusCode == 304, "Warunkowy GET nie zwrocil 304.");
            Expect((await cached.Content.ReadAsByteArrayAsync()).Length == 0,
                "304 zawiera body.");
        }

        var renamed = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(), Type = "update", NodeId = folder.Id,
            BaseVersion = folder.Version, Title = "Nowa nazwa",
        });

        string renamedEtag;

        using (var response = await SpSend(deviceA.Client, HttpMethod.Get,
                   "/api/v1/startpage", etag: etag))
        {
            var body = await SpJson(response);
            Expect(body.GetProperty("configuration").GetProperty("blocks")[0]
                    .GetProperty("folderTitle").GetString() == "Nowa nazwa",
                "Nazwa folderu jest nieaktualna.");
            Expect(body.GetProperty("settingsVersion").GetInt64() ==
                   firstBody.GetProperty("settingsVersion").GetInt64(),
                "Zmiana zakladki zmienila settingsVersion.");
            renamedEtag = response.Headers.ETag!.ToString();
            Expect(renamedEtag != etag, "ETag nie uwzglednia nazwy folderu.");
        }

        await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Id(), Type = "delete", NodeId = folder.Id,
            BaseVersion = renamed.Node!.Version,
            BaseSeq = await h.Head(deviceA),
        });

        using var deleted = await SpSend(deviceA.Client, HttpMethod.Get,
            "/api/v1/startpage", etag: renamedEtag);
        var unavailable = await SpJson(deleted);
        var sections = unavailable.GetProperty("configuration").GetProperty("blocks");

        Expect(sections.GetArrayLength() == 1 &&
               sections[0].GetProperty("folderId").GetString() == folder.Id &&
               !sections[0].GetProperty("available").GetBoolean(),
            "Usuniecie folderu usunelo sekcje albo nie oznaczylo niedostepnosci.");

        var folders = await h.Get(h.Admin,
            $"/admin/api/profiles/{deviceA.ProfileId}/folders");

        Expect(!folders.GetProperty("folders").EnumerateArray()
                .Any(f => f.GetProperty("id").GetString() == folder.Id),
            "Lista folderow zawiera usuniety folder.");
    });

    await h.Run("startpage: token profilu, sesja admina, CSRF, Origin i CORS ETag", async () =>
    {
        await h.Get(h.Anonymous, "/api/v1/startpage", 401);
        await h.Get(h.Anonymous, "/api/v1/startpage/logo", 401);
        await h.Get(h.Anonymous, spPath, 401);
        await h.Get(deviceA.Client, "/api/v1/startpage", 403, origin: "https://evil");

        var own = await h.Get(deviceA.Client,
            "/api/v1/startpage?profileId=" + deviceOther.ProfileId);
        Expect(own.GetProperty("profileId").GetString() == deviceA.ProfileId,
            "Parametr query pozwolil zmienic profil tokenu.");

        var otherConfig = await h.Get(deviceOther.Client, "/api/v1/startpage");
        Expect(otherConfig.GetProperty("profileId").GetString() == deviceOther.ProfileId &&
               otherConfig.GetProperty("configuration").GetProperty("blocks").GetArrayLength() == 0,
            "Konfiguracja wyciekla do drugiego profilu.");

        using (var csrf = await SpSend(h.Admin, HttpMethod.Put, spPath,
                   SpSaveBody(own, new
                   {
                       version = 1,
                       sections = Array.Empty<object>(),
                       engines = Array.Empty<object>(),
                   }), csrf: false))
        {
            await SpJson(csrf, 403);
        }

        await h.Get(h.Admin, $"/admin/api/profiles/{Id()}/startpage", 404);

        using var preflightRequest = new HttpRequestMessage(HttpMethod.Options, "/api/v1/startpage");
        preflightRequest.Headers.Add("Origin", "moz-extension://test-startpage");
        preflightRequest.Headers.Add("Access-Control-Request-Method", "GET");
        preflightRequest.Headers.Add("Access-Control-Request-Headers",
            "authorization, if-none-match");

        using var preflight = await deviceA.Client.SendAsync(preflightRequest);
        Expect((int)preflight.StatusCode == 204, "Preflight nie przeszedl.");
        Expect(preflight.Headers.GetValues("Access-Control-Allow-Headers")
                .Any(v => v.Contains("If-None-Match", StringComparison.OrdinalIgnoreCase)),
            "CORS nie dopuszcza If-None-Match.");
        Expect(preflight.Headers.GetValues("Access-Control-Expose-Headers")
                .Any(v => v.Contains("ETag", StringComparison.OrdinalIgnoreCase)),
            "CORS nie udostepnia ETag.");
    });

    await h.Run("startpage: logo, osobna wersja, ETag, konflikt, usuniecie i audit", async () =>
    {
        var stamp = await h.Get(h.Admin, spPath);
        var head = await h.Head(deviceA);

        using (var missing = await SpSend(deviceA.Client, HttpMethod.Get,
                   "/api/v1/startpage/logo"))
            await SpJson(missing, 404);

        JsonElement uploaded;

        using (var upload = await SpSend(h.Admin, HttpMethod.Put,
                   SpLogoPath(deviceA.ProfileId, stamp), bytes: spPng))
            uploaded = await SpJson(upload);

        Expect(uploaded.GetProperty("logoVersion").GetInt64() ==
               stamp.GetProperty("logoVersion").GetInt64() + 1,
            "Nie zwiekszono wersji logo.");
        Expect(uploaded.GetProperty("settingsVersion").GetInt64() ==
               stamp.GetProperty("settingsVersion").GetInt64(),
            "Logo zmienilo settingsVersion.");

        string logoEtag;

        using (var image = await SpSend(deviceA.Client, HttpMethod.Get,
                   "/api/v1/startpage/logo"))
        {
            Expect(image.StatusCode == HttpStatusCode.OK, "Brak logo.");
            Expect(image.Content.Headers.ContentType?.MediaType == "image/png",
                "Bledny typ logo.");
            Expect((await image.Content.ReadAsByteArrayAsync()).SequenceEqual(spPng),
                "Logo zmienilo bajty.");
            Expect(image.Headers.GetValues("X-FrogSync-Generation").Single() ==
                   uploaded.GetProperty("generation").GetString(),
                "Logo nie podaje generacji.");
            logoEtag = image.Headers.ETag!.ToString();
        }

        using (var cached = await SpSend(deviceA.Client, HttpMethod.Get,
                   "/api/v1/startpage/logo", etag: logoEtag))
            Expect((int)cached.StatusCode == 304, "Logo nie obsluguje ETag.");

        using (var staleDelete = await SpSend(h.Admin, HttpMethod.Delete,
                   SpLogoPath(deviceA.ProfileId, stamp)))
            await SpJson(staleDelete, 409);

        using (var removed = await SpSend(h.Admin, HttpMethod.Delete,
                   SpLogoPath(deviceA.ProfileId, uploaded)))
        {
            var result = await SpJson(removed);
            Expect(result.GetProperty("logoVersion").GetInt64() ==
                   uploaded.GetProperty("logoVersion").GetInt64() + 1,
                "Usuniecie logo nie zwiekszylo wersji.");
        }

        using (var absent = await SpSend(deviceA.Client, HttpMethod.Get,
                   "/api/v1/startpage/logo", etag: logoEtag))
            await SpJson(absent, 404);

        Expect(await h.Head(deviceA) == head, "Operacje logo przesunely seq.");

        var audit = new Database(h.Config).Read(c =>
        {
            using var cmd = Database.Command(c,
                "SELECT kind FROM audit WHERE kind LIKE 'startpage-%'", null);
            using var reader = cmd.ExecuteReader();
            var kinds = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read()) kinds.Add(reader.GetString(0));
            return kinds;
        });

        Expect(audit.Contains("startpage-settings") &&
               audit.Contains("startpage-logo") &&
               audit.Contains("startpage-logo-deleted"),
            "Brakuje audytu operacji strony startowej.");
    });

    await h.Run("startpage: logo odrzuca SVG, falszywy MIME, urwany obraz i ponad 512 KB", async () =>
    {
        var stamp = await h.Get(h.Admin, spPath);
        var path = SpLogoPath(deviceA.ProfileId, stamp);
        var svg = System.Text.Encoding.UTF8.GetBytes(
            "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

        using (var response = await SpSend(h.Admin, HttpMethod.Put, path,
                   bytes: svg, mime: "image/svg+xml"))
            await SpJson(response, 415);

        using (var response = await SpSend(h.Admin, HttpMethod.Put, path,
                   bytes: svg, mime: "image/png"))
            await SpJson(response, 400);

        using (var response = await SpSend(h.Admin, HttpMethod.Put, path,
                   bytes: spPng, mime: "image/jpeg"))
            await SpJson(response, 400);

        using (var response = await SpSend(h.Admin, HttpMethod.Put, path,
                   bytes: spPng[..24], mime: "image/png"))
            await SpJson(response, 400);

        var hugeDimensions = spPng.ToArray();
        BinaryPrimitives.WriteUInt32BigEndian(hugeDimensions.AsSpan(16, 4), 65536);

        using (var response = await SpSend(h.Admin, HttpMethod.Put, path,
                   bytes: hugeDimensions))
            await SpJson(response, 400);

        using (var response = await SpSend(h.Admin, HttpMethod.Put, path,
                   bytes: new byte[512 * 1024 + 1]))
            await SpJson(response, 413);

        var after = await h.Get(h.Admin, spPath);

        Expect(after.GetProperty("logoVersion").GetInt64() ==
               stamp.GetProperty("logoVersion").GetInt64(),
            "Odrzucony obraz zmienil wersje logo.");
    });

    await h.Run("startpage: lista folderow jest ograniczona do profilu i pomija zakladki", async () =>
    {
        var ownFolder = await h.Create(deviceA, "folder", "Wlasny folder", "root:toolbar");
        var ownBookmark = await h.Create(deviceA, "bookmark", "Zwykla zakladka", ownFolder.Id);
        var foreignFolder = await h.Create(deviceOther, "folder", "Obcy folder", "root:toolbar");

        var result = await h.Get(h.Admin,
            $"/admin/api/profiles/{deviceA.ProfileId}/folders");
        var entries = result.GetProperty("folders").EnumerateArray().ToArray();

        Expect(result.GetProperty("generation").GetString() == await h.Generation(deviceA),
            "Lista folderow nie ma aktualnej generacji.");
        Expect(entries.Any(f => f.GetProperty("id").GetString() == "root:toolbar" &&
                                f.GetProperty("kind").GetString() == "root"),
            "Brak korzenia potrzebnego do zbudowania drzewa.");
        Expect(entries.Any(f => f.GetProperty("id").GetString() == ownFolder.Id &&
                                f.GetProperty("parentId").GetString() == "root:toolbar"),
            "Brak folderu albo rodzica.");
        Expect(!entries.Any(f => f.GetProperty("id").GetString() == ownBookmark.Id ||
                                 f.GetProperty("id").GetString() == foreignFolder.Id),
            "Lista zawiera zakladke albo folder innego profilu.");
    });

    await h.Run("startpage: restore obniza wersje, zmienia ETag i blokuje zapis starej generacji", async () =>
    {
        await WithServer(async isolated =>
        {
            var setup = await isolated.Post(isolated.Admin, "/admin/api/setup/start",
                new { setupCode = isolated.SetupCode, password });
            var totpSecret = setup.GetProperty("secret").GetString()!;
            var step = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30;

            await isolated.Post(isolated.Admin, "/admin/api/setup/finish",
                new { setupCode = isolated.SetupCode, totp = Otp(totpSecret, step) });

            var profileId = await isolated.Profile("Startpage restore");
            var dev = await isolated.Pair(profileId,
                await isolated.PairCode(profileId, "Restore test"));
            var folder = await isolated.Create(dev, "folder", "Sekcja", "root:toolbar");
            var path = $"/admin/api/profiles/{profileId}/startpage";
            var initial = await isolated.Get(isolated.Admin, path);

            var first = await SpPut(isolated.Admin, path,
                SpSaveBody(initial, SpDocument(folder.Id, "Z kopii")));

            using (var upload = await SpSend(isolated.Admin, HttpMethod.Put,
                       SpLogoPath(profileId, first), bytes: spPng))
                first = await SpJson(upload);

            string oldConfigEtag;
            string oldLogoEtag;

            using (var response = await SpSend(dev.Client, HttpMethod.Get, "/api/v1/startpage"))
            {
                await SpJson(response);
                oldConfigEtag = response.Headers.ETag!.ToString();
            }

            using (var response = await SpSend(dev.Client, HttpMethod.Get, "/api/v1/startpage/logo"))
            {
                Expect(response.IsSuccessStatusCode, "Brak logo przed kopia.");
                oldLogoEtag = response.Headers.ETag!.ToString();
            }

            var backup = await isolated.Post(isolated.Admin, "/admin/api/backup", new { });
            var backupName = backup.GetProperty("file").GetString()!;

            var second = await SpPut(isolated.Admin, path,
                SpSaveBody(first, SpDocument(folder.Id, "Po kopii")));

            using (var remove = await SpSend(isolated.Admin, HttpMethod.Delete,
                       SpLogoPath(profileId, second)))
                second = await SpJson(remove);

            await isolated.Post(isolated.Admin, "/admin/api/restore",
                new { name = backupName });

            JsonElement restored;

            using (var response = await SpSend(dev.Client, HttpMethod.Get,
                       "/api/v1/startpage", etag: oldConfigEtag))
            {
                restored = await SpJson(response);
                Expect(response.Headers.ETag!.ToString() != oldConfigEtag,
                    "Ta sama wersja z nowej generacji zachowala ETag.");
            }

            Expect(restored.GetProperty("generation").GetString() !=
                   first.GetProperty("generation").GetString(),
                "Restore nie zmienil generacji.");
            Expect(restored.GetProperty("settingsVersion").GetInt64() <
                   second.GetProperty("settingsVersion").GetInt64(),
                "Nie odtworzono nizszej wersji konfiguracji.");
            Expect(restored.GetProperty("logoVersion").GetInt64() <
                   second.GetProperty("logoVersion").GetInt64(),
                "Nie odtworzono nizszej wersji logo.");
            Expect(restored.GetProperty("configuration").GetProperty("blocks")[0]
                    .GetProperty("title").GetString() == "Z kopii",
                "Nie przywrocono konfiguracji z kopii.");

            using (var response = await SpSend(dev.Client, HttpMethod.Get,
                       "/api/v1/startpage/logo", etag: oldLogoEtag))
            {
                Expect(response.StatusCode == HttpStatusCode.OK &&
                       response.Headers.ETag!.ToString() != oldLogoEtag,
                    "Logo z nowej generacji dostalo 304 ze starej generacji.");
                Expect((await response.Content.ReadAsByteArrayAsync()).SequenceEqual(spPng),
                    "Nie przywrocono logo.");
            }

            // Restore uniewaznia sesje panelu; logujemy sie nowym krokiem TOTP.
            var loginStep = Math.Max(step + 1,
                DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30);
            await isolated.Post(isolated.Admin, "/admin/api/login",
                new { password, totp = Otp(totpSecret, loginStep) });

            // first ma te same numery wersji co kopia, ale stara generacje.
            var conflict = await SpPut(isolated.Admin, path,
                SpSaveBody(first, SpDocument(folder.Id, "Stary formularz")), 409);

            Expect(conflict.GetProperty("current").GetProperty("generation").GetString() ==
                   restored.GetProperty("generation").GetString(),
                "409 nie zawiera nowej generacji.");

            using (var staleLogo = await SpSend(isolated.Admin, HttpMethod.Delete,
                       SpLogoPath(profileId, first)))
                await SpJson(staleLogo, 409);

            var unchanged = await isolated.Get(dev.Client, "/api/v1/startpage");
            Expect(unchanged.GetProperty("configuration").GetProperty("blocks")[0]
                    .GetProperty("title").GetString() == "Z kopii",
                "Stary formularz nadpisal przywrocona konfiguracje.");
        });
    });


    await StartPageV2Tests.Run(h, deviceA, deviceOther);


    await h.Run("regresja 10: dwie kolejne kopie tworza dwa rozne gotowe pliki", async () =>
    {
        var first = (await h.Post(h.Admin, "/admin/api/backup", new { }))
            .GetProperty("file").GetString()!;

        var second = (await h.Post(h.Admin, "/admin/api/backup", new { }))
            .GetProperty("file").GetString()!;

        Expect(first != second, "Druga kopia nadpisala pierwsza.");

        await h.AssertBackup(first);
        await h.AssertBackup(second);

        Expect(!File.Exists(Path.Combine(h.Config.BackupDir, first + ".tmp"))
            && !File.Exists(Path.Combine(h.Config.BackupDir, second + ".tmp")),
            "Pozostal plik tymczasowy zakonczonej kopii.");

        var state = await h.Get(h.Admin, "/admin/api/state");

        var listed = state.GetProperty("backups").GetProperty("files").EnumerateArray()
            .Select(f => f.GetProperty("name").GetString()!)
            .ToHashSet(StringComparer.Ordinal);

        Expect(listed.Contains(first) && listed.Contains(second), "Lista nie zawiera obu kopii.");
    });

    await h.Run("odwolanie urzadzenia natychmiast blokuje odczyt i zapis", async () =>
    {
        await h.Post(h.Admin, $"/admin/api/devices/{deviceB.Id}/revoke", new { });
        await h.Get(deviceB.Client, "/api/v1/hello", 401);
        await h.Post(deviceB.Client, "/api/v1/ops", new { ops = Array.Empty<SyncOp>() }, 401);
        await h.Get(deviceA.Client, "/api/v1/hello");
    });

    await h.Run("certyfikat: start z samopodpisanym, wgranie PFX i PEM dziala bez restartu, zle pliki odrzucone", async () =>
    {
        // Odcisk certyfikatu, ktory serwer FAKTYCZNIE pokazuje przy nowym polaczeniu
        async Task<string> ServedThumbprint()
        {
            string? seen = null;
            using var handler = new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback = (_, cert, _, _) =>
                {
                    seen = cert!.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256);
                    return true;
                },
                UseProxy = false,
            };
            using var probe = new HttpClient(handler) { BaseAddress = h.Anonymous.BaseAddress };
            (await probe.GetAsync("/healthz")).EnsureSuccessStatusCode();
            return seen!;
        }

        var initial = await h.Get(h.Admin, "/admin/api/certificate");
        Expect(initial.GetProperty("selfSigned").GetBoolean(), "Na starcie powinien byc certyfikat samopodpisany.");
        Expect(await ServedThumbprint() == initial.GetProperty("fingerprint").GetString(), "Serwer pokazuje inny certyfikat niz raportuje panel.");

        // Wlasne CA i certyfikat serwera z adresem w SAN — jak u Dominika
        using var caKey = System.Security.Cryptography.RSA.Create(2048);
        var caReq = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=Testowe CA", caKey,
            System.Security.Cryptography.HashAlgorithmName.SHA256, System.Security.Cryptography.RSASignaturePadding.Pkcs1);
        caReq.CertificateExtensions.Add(new System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension(true, false, 0, true));
        using var ca = caReq.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-30), DateTimeOffset.UtcNow.AddYears(5));

        System.Security.Cryptography.X509Certificates.X509Certificate2 Leaf(DateTimeOffset notAfter, bool serverAuth)
        {
            var key = System.Security.Cryptography.RSA.Create(2048);
            var req = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=frogsync-test", key,
                System.Security.Cryptography.HashAlgorithmName.SHA256, System.Security.Cryptography.RSASignaturePadding.Pkcs1);
            var san = new System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder();
            san.AddIpAddress(IPAddress.Loopback);
            san.AddDnsName("localhost");
            req.CertificateExtensions.Add(san.Build());
            req.CertificateExtensions.Add(new System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension(
                [new System.Security.Cryptography.Oid(serverAuth ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2")], false));
            var serial = System.Security.Cryptography.RandomNumberGenerator.GetBytes(8);
            using var pub = req.Create(ca, DateTimeOffset.UtcNow.AddDays(-2), notAfter, serial);
            return System.Security.Cryptography.X509Certificates.RSACertificateExtensions.CopyWithPrivateKey(pub, key);
        }

        // PFX z haslem
        using var leaf = Leaf(DateTimeOffset.UtcNow.AddYears(1), serverAuth: true);
        var pfx = leaf.Export(System.Security.Cryptography.X509Certificates.X509ContentType.Pkcs12, "tajne-haslo");

        var wrongPassword = await h.PostRaw(h.Admin, "/admin/api/certificate", new { pfxBase64 = Convert.ToBase64String(pfx), password = "zle" });
        Expect(wrongPassword.Status == 400, $"Zle haslo PFX: oczekiwano 400, jest {wrongPassword.Status}.");

        var uploaded = await h.Post(h.Admin, "/admin/api/certificate", new { pfxBase64 = Convert.ToBase64String(pfx), password = "tajne-haslo" });
        Expect(!uploaded.GetProperty("selfSigned").GetBoolean(), "Po wgraniu panel nadal raportuje samopodpisany.");
        var leafThumb = leaf.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256);
        Expect(await ServedThumbprint() == leafThumb, "Nowe polaczenie nie dostalo wgranego certyfikatu — podmiana bez restartu nie dziala.");

        // PEM: certyfikat + klucz osobno
        using var leaf2 = Leaf(DateTimeOffset.UtcNow.AddYears(1), serverAuth: true);
        var certPem = leaf2.ExportCertificatePem();
        var keyPem = System.Security.Cryptography.X509Certificates.RSACertificateExtensions.GetRSAPrivateKey(leaf2)!.ExportPkcs8PrivateKeyPem();
        await h.Post(h.Admin, "/admin/api/certificate", new { certPem, keyPem });
        Expect(await ServedThumbprint() == leaf2.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256),
            "Certyfikat PEM nie zostal podany przez serwer.");

        // Odrzucane: bez klucza, wygasly, bez Server Authentication
        using var publicOnly = System.Security.Cryptography.X509Certificates.X509CertificateLoader.LoadCertificate(leaf.RawData);
        var noKey = await h.PostRaw(h.Admin, "/admin/api/certificate",
            new { pfxBase64 = Convert.ToBase64String(publicOnly.Export(System.Security.Cryptography.X509Certificates.X509ContentType.Pkcs12)) });
        Expect(noKey.Status == 400, $"Certyfikat bez klucza: oczekiwano 400, jest {noKey.Status}.");

        using var expired = Leaf(DateTimeOffset.UtcNow.AddDays(-1), serverAuth: true);
        var expiredReply = await h.PostRaw(h.Admin, "/admin/api/certificate",
            new { pfxBase64 = Convert.ToBase64String(expired.Export(System.Security.Cryptography.X509Certificates.X509ContentType.Pkcs12)) });
        Expect(expiredReply.Status == 400, $"Wygasly certyfikat: oczekiwano 400, jest {expiredReply.Status}.");

        using var clientOnly = Leaf(DateTimeOffset.UtcNow.AddYears(1), serverAuth: false);
        var clientReply = await h.PostRaw(h.Admin, "/admin/api/certificate",
            new { pfxBase64 = Convert.ToBase64String(clientOnly.Export(System.Security.Cryptography.X509Certificates.X509ContentType.Pkcs12)) });
        Expect(clientReply.Status == 400, $"Certyfikat bez Server Authentication: oczekiwano 400, jest {clientReply.Status}.");

        // Zly plik nie mogl zepsuc dzialajacego certyfikatu
        Expect(await ServedThumbprint() == leaf2.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256),
            "Odrzucony plik podmienil dzialajacy certyfikat.");

        var certBackup = await h.Post(h.Admin, "/admin/api/backup", new { });
        var certPath = Path.Combine(h.Config.BackupDir, certBackup.GetProperty("file").GetString()!);
        using (var snapshot = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = certPath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
        {
            snapshot.Open();
            var saved = (byte[])Database.Scalar(snapshot, "SELECT value FROM blobs WHERE key = 'tls-pkcs12'")!;
            using var cert = System.Security.Cryptography.X509Certificates.X509CertificateLoader.LoadPkcs12(saved, null);
            Expect(cert.HasPrivateKey && cert.GetCertHashString(HashAlgorithmName.SHA256) == leaf2.GetCertHashString(HashAlgorithmName.SHA256),
                "Kopia nie zawiera certyfikatu z kluczem.");
        }
        await h.Restart();
        Expect(await ServedThumbprint() == leaf2.GetCertHashString(HashAlgorithmName.SHA256),
            "Wgrany certyfikat nie przetrwal restartu.");

        // Powrot do samopodpisanego
        var reset = await h.Post(h.Admin, "/admin/api/certificate/reset", new { });
        Expect(reset.GetProperty("selfSigned").GetBoolean(), "Reset nie wrocil do samopodpisanego.");
        Expect(await ServedThumbprint() == reset.GetProperty("fingerprint").GetString(), "Po resecie serwer pokazuje inny certyfikat.");
    });

    await h.Run("backup: powstaje spojny plik .db z tabela nodes i danymi", async () =>
    {
        var result = await h.Post(h.Admin, "/admin/api/backup", new { });
        await h.AssertBackup(result.GetProperty("file").GetString()!, requireBookmarks: true);
    });

    await h.Run("preview: stan profilu, konflikt i wspolny limiter", async () =>
    {
        await using var isolated = new Harness();
        await isolated.Start();
        var start = await isolated.Post(isolated.Admin, "/admin/api/setup/start",
            new { setupCode = isolated.SetupCode, password });
        var otp = Otp(start.GetProperty("secret").GetString()!, DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30);
        await isolated.Post(isolated.Admin, "/admin/api/setup/finish", new { setupCode = isolated.SetupCode, totp = otp });
        var profileId = await isolated.Profile("Podglad");
        var code = await isolated.PairCode(profileId, "Firefox");
        var preview = await isolated.Post(isolated.Anonymous, "/api/v1/pair/preview", new { code });
        Expect(!preview.GetProperty("hasContent").GetBoolean() && preview.GetProperty("bookmarks").GetInt32() == 0
            && preview.GetProperty("profileName").GetString() == "Podglad"
            && !string.IsNullOrEmpty(preview.GetProperty("previewId").GetString()), "Niepoprawny podglad.");
        var changed = await isolated.Post(isolated.Anonymous, "/api/v1/pair", new { code, expectContent = true }, 409);
        Expect(changed.GetProperty("error").GetString() == "PROFILE_CHANGED" &&
            !changed.GetProperty("hasContent").GetBoolean(), "Niepoprawny konflikt parowania.");
        var paired = await isolated.Post(isolated.Anonymous, "/api/v1/pair", new { code, expectContent = false });
        var dev = new Device(paired.GetProperty("deviceId").GetString()!, profileId,
            isolated.NewClient(paired.GetProperty("token").GetString()));
        var nextCode = await isolated.PairCode(profileId, "Chromium");
        await isolated.Create(dev, "folder", "Folder bez zakladek", "root:toolbar");
        var filled = await isolated.Post(isolated.Anonymous, "/api/v1/pair/preview", new { code = nextCode });
        Expect(filled.GetProperty("hasContent").GetBoolean() && filled.GetProperty("bookmarks").GetInt32() == 0,
            "Folder bez zakladek musi oznaczac niepusty profil.");
        for (var i = 0; i < 5; i++)
            await isolated.Post(isolated.Anonymous, "/api/v1/pair/preview", new { code = "zly" }, 400);
        await isolated.Post(isolated.Anonymous, "/api/v1/pair", new { code = nextCode }, 429);
    });

    await h.Run("wersje: hello, zapis urzadzenia, minimum i wznowienie po aktualizacji", async () =>
    {
        // Osobny serwer z minimum, bez zmiany konfiguracji glownego zestawu.
        var directory = Path.Combine(Path.GetTempPath(), "FrogSync-VersionTests-" + Guid.NewGuid().ToString("N"));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();

        var versionConfig = new AppConfig
        {
            DataDir = directory,
            CertPath = Path.Combine(directory, "missing.pfx"),
            Port = port,
            MinExtensionVersion = "0.3.2",
            LatestExtensionVersion = "0.3.10",
            BackupInterval = TimeSpan.FromDays(1),
        };
        await using var versionApp = ServerHost.Build(versionConfig);
        try
        {
            await versionApp.StartAsync();
            using var handler = new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback = (_, _, _, _) => true,
                UseProxy = false,
            };
            using var client = new HttpClient(handler)
            {
                BaseAddress = new Uri($"https://127.0.0.1:{port}/"),
            };

            var adminService = versionApp.Services.GetRequiredService<FrogSync.Server.Admin.AdminService>();
            var deviceService = versionApp.Services.GetRequiredService<FrogSync.Server.Device.DeviceService>();
            var database = versionApp.Services.GetRequiredService<Database>();
            var profileId = await adminService.CreateProfileAsync("Version test", "127.0.0.1");
            var pairCode = await deviceService.CreatePairingCodeAsync(profileId, "Test wersji", "127.0.0.1");
            using var pairResponse = await client.PostAsJsonAsync("/api/v1/pair",
                new { code = pairCode.Code, browser = "test" });
            pairResponse.EnsureSuccessStatusCode();
            var pairJson = JsonDocument.Parse(await pairResponse.Content.ReadAsStringAsync()).RootElement.Clone();
            var deviceId = pairJson.GetProperty("deviceId").GetString()!;
            client.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", pairJson.GetProperty("token").GetString());

            void SetVersion(string? version)
            {
                client.DefaultRequestHeaders.Remove(ExtensionVersions.Header);
                if (version is not null) client.DefaultRequestHeaders.Add(ExtensionVersions.Header, version);
            }

            async Task<JsonElement> ReadHello()
            {
                using var response = await client.GetAsync("/api/v1/hello");
                response.EnsureSuccessStatusCode();
                using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                return json.RootElement.Clone();
            }

            SetVersion("0.3.1");
            var hello = await ReadHello();
            Expect(hello.GetProperty("minExtensionVersion").GetString() == "0.3.2" &&
                hello.GetProperty("latestExtensionVersion").GetString() == "0.3.10",
                "Hello nie podaje polityki wersji.");
            Expect(database.Read(c => Database.Scalar(c,
                "SELECT extension_version FROM devices WHERE id = @id", null, ("@id", deviceId))) as string == "0.3.1",
                "Nie zapisano wersji urzadzenia.");

            string DeviceVersionStatus()
            {
                using var state = JsonSerializer.SerializeToDocument(adminService.State(),
                    new JsonSerializerOptions(JsonSerializerDefaults.Web));
                return state.RootElement.GetProperty("devices").EnumerateArray()
                    .Single(d => d.GetProperty("id").GetString() == deviceId)
                    .GetProperty("extensionVersionStatus").GetString()!;
            }

            Expect(DeviceVersionStatus() == "incompatible", "Panel nie oznacza niezgodnego urzadzenia.");
            var generation = hello.GetProperty("generation").GetString()!;
            var head = hello.GetProperty("head").GetInt64();
            var nodeId = Guid.NewGuid().ToString();
            var operation = new SyncOp
            {
                ClientOpId = Guid.NewGuid().ToString(), Type = "create", NodeId = nodeId,
                Kind = "bookmark", ParentId = "root:toolbar",
                Title = "Po aktualizacji", Url = "https://version.example/",
            };

            using (var blocked = await client.PostAsJsonAsync("/api/v1/ops",
                new { generation, protocol = 3, ops = new[] { operation } }))
            {
                Expect((int)blocked.StatusCode == 409, "Stary klient nie zostal zatrzymany.");
                using var json = JsonDocument.Parse(await blocked.Content.ReadAsStringAsync());
                Expect(json.RootElement.GetProperty("error").GetString() == "OUTDATED_CLIENT",
                    "Brak OUTDATED_CLIENT.");
            }
            using (var changes = await client.GetAsync("/api/v1/changes?after=0"))
                Expect((int)changes.StatusCode == 409, "Stary klient nadal pobiera zmiany.");

            var sync = versionApp.Services.GetRequiredService<FrogSync.Server.Sync.SyncService>();
            Expect(sync.Head(profileId) == head, "Zablokowana operacja zmienila dziennik.");

            SetVersion(null);
            using (var missing = await client.PostAsJsonAsync("/api/v1/ops",
                new { generation, protocol = 3, ops = new[] { operation } }))
                Expect((int)missing.StatusCode == 409, "Brak naglowka ominal minimum.");

            SetVersion("0.3.2");
            await ReadHello();
            Expect(DeviceVersionStatus() == "update", "Panel nie pokazuje dostepnej aktualizacji.");
            using (var applied = await client.PostAsJsonAsync("/api/v1/ops",
                new { generation, protocol = 3, ops = new[] { operation } }))
            {
                applied.EnsureSuccessStatusCode();
                using var json = JsonDocument.Parse(await applied.Content.ReadAsStringAsync());
                var result = json.RootElement.GetProperty("results")[0];
                Expect(result.GetProperty("status").GetString() == "applied" &&
                    !result.GetProperty("duplicate").GetBoolean(),
                    "Zablokowana proba zajela clientOpId albo operacja nie wrocila po aktualizacji.");
            }

            SetVersion("0.3.10");
            await ReadHello();
            Expect(DeviceVersionStatus() == "current", "Porownanie wersji jest tekstowe zamiast liczbowe.");

            Expect(ExtensionVersions.Compare("0.3.10", "0.3.2") > 0 &&
                !ExtensionVersions.IsValid("0.03.2") &&
                !string.IsNullOrEmpty(ExtensionVersions.BuiltInVersion),
                "Niepoprawna walidacja lub wbudowana wersja wydania.");
        }
        finally
        {
            await versionApp.StopAsync();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(directory, recursive: true); } catch (IOException) { }
        }
    });

    await h.Run("ops: poprawna generacja jest wymagana, stara wymusza reset", async () =>
    {
        var hello = await h.Get(deviceA.Client, "/api/v1/hello");
        var generation = hello.GetProperty("generation").GetString()!;
        var protocol = hello.GetProperty("protocol").GetInt32();
        var minProtocol = hello.GetProperty("minProtocol").GetInt32();
        Expect(protocol == 3 && minProtocol == 2, "Niepoprawne wersje protokolu w hello.");

        var before = await h.Head(deviceA);
        var id = Guid.NewGuid().ToString();
        var ops = new[]
        {
            new SyncOp
            {
                ClientOpId = Guid.NewGuid().ToString(), Type = "create", NodeId = id,
                ParentId = "root:toolbar", Kind = "bookmark",
                Title = "Proba generacji", Url = "https://generation.example/",
            },
        };

        var wrong = await h.Post(deviceA.Client, "/api/v1/ops",
            new { ops, generation = "stara", protocol }, 409);
        Expect(wrong.GetProperty("error").GetString() == "RESET_REQUIRED" &&
            wrong.GetProperty("generation").GetString() == generation, "Niepoprawny reset generacji.");
        Expect(await h.Head(deviceA) == before, "Stara generacja zmienila dziennik.");

        var correct = await h.Post(deviceA.Client, "/api/v1/ops", new { ops, generation, protocol });
        Expect(correct.GetProperty("results")[0].GetProperty("status").GetString() == "applied",
            "Poprawna generacja nie pozwolila zapisac operacji.");
        Expect((await h.Snapshot(deviceA)).ContainsKey(id), "Brak zapisanego wezla.");
    });

    await h.Run("ops: OUTDATED_CLIENT bez generacji lub ze starym protokolem nic nie zapisuje", async () =>
    {
        var generation = await h.Generation(deviceA);
        var before = await h.Head(deviceA);
        var id = Guid.NewGuid().ToString();
        var ops = new[]
        {
            new SyncOp
            {
                ClientOpId = Guid.NewGuid().ToString(), Type = "create", NodeId = id,
                ParentId = "root:toolbar", Kind = "bookmark",
                Title = "Nie zapisuj", Url = "https://outdated.example/",
            },
        };

        foreach (var request in new object[]
        {
            new { ops },
            new { ops, generation = "", protocol = 3 },
            new { ops, generation, protocol = 1 },
        })
        {
            var reply = await h.Post(deviceA.Client, "/api/v1/ops", request, 409);
            Expect(reply.GetProperty("error").GetString() == "OUTDATED_CLIENT", "Brak OUTDATED_CLIENT.");
            Expect(reply.GetProperty("message").GetString()!.Contains("Zaktualizuj wtyczkę"),
                "Brak wskazowki aktualizacji.");
        }

        Expect(await h.Head(deviceA) == before && !(await h.Snapshot(deviceA)).ContainsKey(id),
            "Nieobslugiwany klient zmienil baze.");

        var retry = await h.Post(deviceA.Client, "/api/v1/ops", new { ops, generation, protocol = 3 });
        var result = retry.GetProperty("results")[0];
        Expect(result.GetProperty("status").GetString() == "applied" &&
            !result.GetProperty("duplicate").GetBoolean(),
            "Nieobslugiwany klient zostawil wynik idempotencji.");
    });

    await h.Run("ops: approved jest w tombstone poddrzewa, nie omija konfliktu i znika po odtworzeniu", async () =>
    {
        // Uzywamy drugiego tokena tego samego profilu, ale nie tego odwolwanego wczesniej w zestawie.
        var reader = await h.Pair(deviceA.ProfileId, await h.PairCode(deviceA.ProfileId, "Approved reader"));
        var folder = await h.Create(deviceA, "folder", "Zatwierdzony folder", "root:toolbar");
        var child = await h.Create(deviceA, "bookmark", "Dziecko zatwierdzonego folderu", folder.Id);
        var plain = await h.Create(deviceA, "bookmark", "Zwykle usuniecie", "root:toolbar");
        var after = await h.Head(reader);

        var approved = new SyncOp
        {
            ClientOpId = Guid.NewGuid().ToString(), Type = "delete", NodeId = folder.Id,
            BaseVersion = folder.Version, BaseSeq = after, Approved = true,
        };
        var deleted = await h.Op(deviceA, approved);
        Expect(deleted.Status == "applied" && deleted.Node is { Deleted: true, Approved: true },
            "Odpowiedz ops nie zawiera zatwierdzonego tombstone.");

        var repeated = await h.Op(deviceA, approved);
        Expect(repeated.Duplicate && repeated.Node is { Approved: true },
            "Ponowienie zgubilo zatwierdzenie.");

        var normal = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Guid.NewGuid().ToString(), Type = "delete", NodeId = plain.Id,
            BaseVersion = plain.Version,
        });
        Expect(normal.Status == "applied" && normal.Node is { Deleted: true, Approved: false },
            "Zwykle usuniecie zostalo oznaczone jako zatwierdzone.");

        var page = await h.Page(reader, after, 20);
        var byId = page.Nodes.ToDictionary(node => node.Id);
        Expect(byId[folder.Id] is { Deleted: true, Approved: true } &&
            byId[child.Id] is { Deleted: true, Approved: true } &&
            byId[plain.Id] is { Deleted: true, Approved: false },
            "Druga przegladarka nie dostala poprawnych znacznikow w changes.");

        var restored = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Guid.NewGuid().ToString(), Type = "update", NodeId = folder.Id,
            BaseVersion = deleted.Node!.Version, Force = true,
        });
        Expect(restored.Status == "applied" && restored.Node is { Deleted: false, Approved: false },
            "Przywrocony wezel zachowal dawna zgode.");

        var conflict = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Guid.NewGuid().ToString(), Type = "delete", NodeId = folder.Id,
            BaseVersion = folder.Version, BaseSeq = await h.Head(deviceA), Approved = true,
        }, "conflict", "edited-since");
        Expect(conflict.Status == "conflict" && conflict.Reason == "edited-since",
            "Approved ominelo kontrole konfliktu.");

        var plainAgain = await h.Op(deviceA, new SyncOp
        {
            ClientOpId = Guid.NewGuid().ToString(), Type = "delete", NodeId = folder.Id,
            BaseVersion = restored.Node!.Version, BaseSeq = await h.Head(deviceA),
        });
        Expect(plainAgain.Status == "applied" && plainAgain.Node is { Deleted: true, Approved: false },
            "Kolejne zwykle usuniecie odziedziczylo stara zgode.");
    });

    await h.Run("backup: pobranie SQLite i przywrocenie na swiezym serwerze", async () =>
    {
        var generation = await h.Generation(deviceA);
        var marker = await h.Create(deviceA, "bookmark", "Marker przywrocenia pliku", "root:toolbar");
        var created = await h.Post(h.Admin, "/admin/api/backup", new { });
        var name = created.GetProperty("file").GetString()!;
        using var downloaded = await h.Admin.GetAsync("/admin/api/backups/" + Uri.EscapeDataString(name));
        Expect(downloaded.IsSuccessStatusCode && downloaded.Content.Headers.ContentDisposition?.DispositionType == "attachment",
            "Brak pobieralnego pliku kopii.");
        var bytes = await downloaded.Content.ReadAsByteArrayAsync();
        Expect(bytes.AsSpan().StartsWith("SQLite format 3\0"u8), "Pobrany plik nie jest SQLite.");

        await using var fresh = new Harness();
        await fresh.Start();
        using var junk = await fresh.Upload("/admin/api/setup/restore", [1, 2, 3], fresh.SetupCode);
        Expect((int)junk.StatusCode == 400, "Przyjeto smieciowy plik.");

        var futurePath = Path.Combine(fresh.Config.DataDir, "future.db");
        await File.WriteAllBytesAsync(futurePath, bytes);
        using (var db = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = futurePath, Pooling = false }.ToString()))
        {
            db.Open();
            Database.Exec(db, "INSERT INTO schema_version(version) VALUES (999)");
        }
        using var future = await fresh.Upload("/admin/api/setup/restore", await File.ReadAllBytesAsync(futurePath), fresh.SetupCode);
        Expect((int)future.StatusCode == 400, "Przyjeto kopie z nowszym schematem.");

        using var restored = await fresh.Upload("/admin/api/setup/restore", bytes, fresh.SetupCode);
        Expect(restored.IsSuccessStatusCode, "Nie odtworzono pliku: " + await restored.Content.ReadAsStringAsync());
        var status = await fresh.Get(fresh.Admin, "/admin/api/status");
        Expect(status.GetProperty("configured").GetBoolean() && !status.GetProperty("signedIn").GetBoolean(),
            "Odtworzenie nie przywrocilo administratora albo przywrocilo sesje.");
        using var second = await fresh.Upload("/admin/api/setup/restore", bytes, fresh.SetupCode);
        Expect((int)second.StatusCode == 409, "Kod setup nadal dziala.");
        var token = deviceA.Client.DefaultRequestHeaders.Authorization!.Parameter!;
        var copy = new Device(deviceA.Id, deviceA.ProfileId, fresh.NewClient(token));
        var hello = await fresh.Get(copy.Client, "/api/v1/hello");
        Expect(hello.GetProperty("profile").GetProperty("id").GetString() == deviceA.ProfileId,
            "Profil lub token nie zostal przywrocony.");
        await fresh.Post(copy.Client, "/api/v1/ops", new { generation, ops = Array.Empty<SyncOp>() }, 409);
        Expect((await fresh.Snapshot(copy)).ContainsKey(marker.Id), "Kopia nie przywrocila zakladki.");

        // Kopia moze zawierac krok z przyszlego okna po poprzednim logowaniu.
        var step = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30 + 1;
        using (var c = new Database(fresh.Config).Open())
        {
            var last = (long)Database.Scalar(c, "SELECT totp_last_step FROM admin WHERE id = 1")!;
            if (last >= step)
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Max(0, last * 30_000 - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 250)));
        }
        await fresh.Post(fresh.Admin, "/admin/api/login", new
        {
            password,
            totp = Otp(secret, DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30 + 1)
        });
        using var upload = await fresh.Upload("/admin/api/restore/upload", bytes);
        Expect(upload.IsSuccessStatusCode, "Zalogowany administrator nie mogl odtworzyc pliku.");
        Expect(!(await fresh.Get(fresh.Admin, "/admin/api/status")).GetProperty("signedIn").GetBoolean(),
            "Sesja przetrwala przywrocenie z pliku.");
    });

    await h.Run("setup restore: zly kod podlega temu samemu limiterowi", async () =>
    {
        await using var fresh = new Harness();
        await fresh.Start();
        for (var i = 0; i < 5; i++)
        {
            using var bad = await fresh.Upload("/admin/api/setup/restore", [1], "NIEPOPRAWNY");
            Expect((int)bad.StatusCode == 400, "Bledny kod nie dal 400.");
        }
        await fresh.Post(fresh.Admin, "/admin/api/setup/start", new { setupCode = fresh.SetupCode, password }, 429);
    });

    await h.Run("regresja 6: odtworzenie kopii zmienia generacje i wymaga resetu kursora", async () =>
    {
        var generation = await h.Generation(deviceA);
        var before = await h.Snapshot(deviceA);

        var backup = await h.Post(h.Admin, "/admin/api/backup", new { });
        var name = backup.GetProperty("file").GetString()!;
        await h.AssertBackup(name);

        var marker = await h.Create(deviceA, "bookmark", "Tylko po wykonaniu kopii", "root:menu");
        var staleCursor = await h.Head(deviceA);

        Expect((await h.Snapshot(deviceA)).ContainsKey(marker.Id),
            "Brak wpisu przed odtworzeniem.");

        var restore = await h.Post(h.Admin, "/admin/api/restore", new { name });

        Expect(restore.GetProperty("ok").GetBoolean(), "Odtworzenie nie powiodlo sie.");

        var safety = restore.GetProperty("safetyBackup").GetString()!;
        Expect(safety != name, "Kopia bezpieczenstwa nadpisala odtwarzana kopie.");
        await h.AssertBackup(safety);

        var current = await h.Generation(deviceA);

        Expect(current != generation && !string.IsNullOrEmpty(current), "Nie zmieniono generacji.");

        var reset = await h.Get(deviceA.Client, ChangesPath(0, 2, generation), 409);

        Expect(reset.GetProperty("error").GetString() == "RESET_REQUIRED"
            && reset.GetProperty("generation").GetString() == current,
            "Stara generacja nie wymusza resetu.");

        var oldOps = await h.Post(deviceA.Client, "/api/v1/ops", new { generation, ops = Array.Empty<SyncOp>() }, 409);
        Expect(oldOps.GetProperty("generation").GetString() == current, "Stary outbox przeszedl po odtworzeniu.");
        Expect(!(await h.Get(h.Admin, "/admin/api/status")).GetProperty("signedIn").GetBoolean(),
            "Odtworzenie nie uniewaznilo sesji panelu.");

        var ahead = await h.Get(deviceA.Client, ChangesPath(staleCursor, 2, current), 409);

        Expect(ahead.GetProperty("error").GetString() == "RESET_REQUIRED",
            "Kursor przed odtworzeniem nie zostal odrzucony.");

        var restored = await h.Snapshot(deviceA);

        Expect(!restored.ContainsKey(marker.Id), "Odtworzona kopia zawiera pozniejszy wpis.");
        Expect(restored.Keys.ToHashSet().SetEquals(before.Keys),
            "Odtworzono nie ten zestaw wezlow.");
    });

    // Testy jednostkowe fragmentow, ktore napisal Codex: klucze kolejnosci,
    // kody 2FA (wektory z RFC 6238) i rozpoznawanie adresow prywatnych.
    foreach (var (name, run) in new (string, Func<List<string>>)[]
             {
                 ("jednostkowe: OrderKey (porzadek, 10 000 wstawien, Rebalance)", FrogSync.Server.OrderKey.SelfTest),
                 ("jednostkowe: Totp (wektory RFC 6238, Base32, ponowne uzycie)", FrogSync.Server.Totp.SelfTest),
                 ("jednostkowe: NetworkGuard (zakresy prywatne IPv4/IPv6)", FrogSync.Server.NetworkGuard.SelfTest),
             })
    {
        await h.Run(name, () =>
        {
            var errors = run();
            Expect(errors.Count == 0, string.Join("; ", errors));
            return Task.CompletedTask;
        });
    }
}
catch (Exception ex)
{
    h.RecordFailure("uruchomienie lub warunek wstepny", ex);
}
finally
{
    await h.DisposeAsync();
}

Console.WriteLine($"Wynik: {h.Passed} OK, {h.Failed} bledow.");
return h.Failed == 0 ? 0 : 1;

public sealed record Device(string Id, string ProfileId, HttpClient Client);
public sealed record Reply(int Status, JsonElement Body);
public sealed record Download(Dictionary<string, NodeDto> Nodes, long Next, string Generation);

public sealed class Harness : IAsyncDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly List<HttpClient> clients = [];
    private readonly SetupLoggerProvider logs = new();

    private WebApplication? app;
    private string dataDir = "";
    private Uri baseAddress = null!;

    public AppConfig Config { get; private set; } = null!;
    public HttpClient Admin { get; private set; } = null!;
    public HttpClient Anonymous { get; private set; } = null!;

    public string SetupCode { get; private set; } = "";
    public int Passed { get; private set; }
    public int Failed { get; private set; }

    public async Task Start()
    {
        dataDir = Path.Combine(Path.GetTempPath(), "FrogSync.Tests-" + Id());
        Directory.CreateDirectory(dataDir);

        var listener = new TcpListener(IPAddress.Loopback, 0);

        try
        {
            listener.Start();

            Config = new AppConfig
            {
                DataDir = dataDir,
                Port = ((IPEndPoint)listener.LocalEndpoint).Port,
                CertPath = Path.Combine(dataDir, "missing.pfx"),
                AllowPublic = false,
                BackupInterval = TimeSpan.FromDays(1),
                BackupKeep = 100
            };
        }
        finally
        {
            listener.Stop();
        }

        baseAddress = new Uri($"https://127.0.0.1:{Config.Port}/");

        app = ServerHost.Build(Config, builder =>
        {
            builder.Logging.ClearProviders();
            builder.Logging.SetMinimumLevel(LogLevel.Warning);
            builder.Logging.AddProvider(logs);
        });

        await app.StartAsync().WaitAsync(TimeSpan.FromSeconds(30));

        SetupCode = await logs.SetupCode.Task.WaitAsync(TimeSpan.FromSeconds(10));

        Admin = NewClient();
        Anonymous = NewClient();

        await Get(Anonymous, "/healthz");
    }

    public async Task Restart()
    {
        await app!.StopAsync();
        await app.DisposeAsync();
        app = ServerHost.Build(Config);
        await app.StartAsync();
    }

    public async Task<HttpResponseMessage> Upload(string path, byte[] bytes, string? setupCode = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path);
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        request.Headers.Add("X-FrogSync", "1");
        if (setupCode is not null) request.Headers.Add("X-Setup-Code", setupCode);
        return await Admin.SendAsync(request);
    }

    public HttpClient NewClient(string? token = null)
    {
        var handler = new HttpClientHandler
        {
            // Wylacznie lokalny, tymczasowy serwer testowy.
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true,
            CookieContainer = new CookieContainer(),
            UseCookies = true,
            UseProxy = false,
            AllowAutoRedirect = false,
            MaxConnectionsPerServer = 64
        };

        var client = new HttpClient(handler)
        {
            BaseAddress = baseAddress,
            Timeout = TimeSpan.FromSeconds(60)
        };

        if (token is not null)
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        clients.Add(client);
        return client;
    }

    public async Task Run(string name, Func<Task> test)
    {
        var timer = Stopwatch.StartNew();

        try
        {
            await test();
            Passed++;
            Console.WriteLine($"OK   {name} [{timer.ElapsedMilliseconds} ms]");
        }
        catch (Exception ex)
        {
            RecordFailure(name, ex);
        }
    }

    public void RecordFailure(string name, Exception ex)
    {
        Failed++;
        Console.WriteLine($"FAIL {name}: {ex.GetType().Name}: {ex.Message}");

        var cause = ex.GetBaseException();

        if (!ReferenceEquals(cause, ex))
            Console.WriteLine($"     Przyczyna: {cause.Message}");
    }

    public static void Expect(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    public static string Id() => Guid.NewGuid().ToString("D");

    public static string ChangesPath(long after, int limit, string generation) =>
        $"/api/v1/changes?after={after}&limit={limit}&generation={Uri.EscapeDataString(generation)}";

    public async Task<JsonElement> Get(
        HttpClient client,
        string path,
        int expected = 200,
        string? origin = null) =>
        (await Send(client, HttpMethod.Get, path, null, expected, true, origin)).Body;

    public async Task<JsonElement> Post(
        HttpClient client,
        string path,
        object body,
        int expected = 200,
        bool csrf = true) =>
        (await Send(client, HttpMethod.Post, path, body, expected, csrf, null)).Body;

    public Task<Reply> PostRaw(HttpClient client, string path, object body) =>
        Send(client, HttpMethod.Post, path, body, null, true, null);

    private async Task<Reply> Send(
        HttpClient client,
        HttpMethod method,
        string path,
        object? body,
        int? expected,
        bool csrf,
        string? origin)
    {
        using var request = new HttpRequestMessage(method, path);

        if (path.StartsWith("/admin/api/", StringComparison.Ordinal) && csrf)
            request.Headers.Add("X-FrogSync", "1");

        if (origin is not null)
            request.Headers.TryAddWithoutValidation("Origin", origin);

        if (body is not null)
            request.Content = JsonContent.Create(body, options: Json);

        using var response = await client.SendAsync(request);
        var status = (int)response.StatusCode;

        // Nie wypisujemy body: moze zawierac token, sekret lub kod parowania.
        if (expected.HasValue)
        {
            Expect(status == expected.Value,
                $"{method} {path}: oczekiwano HTTP {expected}, jest {status}.");
        }

        var text = await response.Content.ReadAsStringAsync();

        if (string.IsNullOrWhiteSpace(text))
            return new Reply(status, JsonSerializer.SerializeToElement<object?>(null));

        try
        {
            using var document = JsonDocument.Parse(text);
            return new Reply(status, document.RootElement.Clone());
        }
        catch (JsonException)
        {
            throw new InvalidOperationException(
                $"{method} {path}: odpowiedz HTTP {status} nie jest JSON.");
        }
    }

    public async Task<string> Profile(string name) =>
        (await Post(Admin, "/admin/api/profiles", new { name }))
        .GetProperty("id").GetString()!;

    public async Task<string> PairCode(string profileId, string deviceName) =>
        (await Post(Admin, $"/admin/api/profiles/{profileId}/pairing", new { deviceName }))
        .GetProperty("code").GetString()!;

    public async Task<Device> Pair(string profileId, string code)
    {
        var result = await Post(Anonymous, "/api/v1/pair",
            new { code, browser = "Integration test" });

        Expect(result.GetProperty("profile").GetProperty("id").GetString() == profileId,
            "Parowanie zmienilo profil.");

        var token = result.GetProperty("token").GetString()!;
        Expect(!string.IsNullOrEmpty(token), "Parowanie nie zwrocilo tokenu.");

        return new Device(
            result.GetProperty("deviceId").GetString()!,
            profileId,
            NewClient(token));
    }

    public async Task<long> Head(Device device) =>
        (await Get(device.Client, "/api/v1/hello")).GetProperty("head").GetInt64();

    public async Task<string> Generation(Device device) =>
        (await Get(device.Client, "/api/v1/hello")).GetProperty("generation").GetString()!;

    public async Task<ChangesResponse> Page(
        Device device,
        long after,
        int limit = 2000,
        string? generation = null)
    {
        generation ??= await Generation(device);

        var json = await Get(device.Client, ChangesPath(after, limit, generation));

        var page = json.Deserialize<ChangesResponse>(Json)
            ?? throw new InvalidOperationException("Pusta odpowiedz changes.");

        Expect(page.Generation == generation, "Generacja zmienila sie podczas pobierania.");

        return page;
    }

    public async Task<Download> DownloadAll(
        Device device,
        long after = 0,
        int limit = 2000,
        string? generation = null)
    {
        generation ??= await Generation(device);

        var nodes = new Dictionary<string, NodeDto>(StringComparer.Ordinal);
        var cursor = after;

        for (var pageNo = 0; ; pageNo++)
        {
            Expect(pageNo < 10_000, "Pobieranie nie konczy stronicowania.");

            var page = await Page(device, cursor, limit, generation);
            var previous = cursor;

            foreach (var node in page.Nodes)
            {
                Expect(node.Seq > previous, "Strona zawiera niemonotoniczne seq.");
                previous = node.Seq;

                // Stanowy dziennik moze ponownie zwrocic zmieniony podczas pobierania wezel.
                nodes[node.Id] = node;
            }

            Expect(page.Next == previous, "next nie wskazuje konca zwroconej strony.");

            cursor = page.Next;

            if (!page.More)
                return new Download(nodes, cursor, generation);

            Expect(page.Nodes.Count > 0, "more=true przy pustej stronie.");
        }
    }

    public async Task<Dictionary<string, NodeDto>> Snapshot(Device device) =>
        (await DownloadAll(device)).Nodes;

    public async Task<OpsResponse> Batch(Device device, IEnumerable<SyncOp> operations)
    {
        var ops = operations.ToList();

        var json = await Post(device.Client, "/api/v1/ops", new OpsRequest { Ops = ops, Generation = await Generation(device) });

        var response = json.Deserialize<OpsResponse>(Json)
            ?? throw new InvalidOperationException("Pusta odpowiedz ops.");

        Expect(response.Results.Count == ops.Count, "Niepoprawna liczba wynikow operacji.");

        for (var i = 0; i < ops.Count; i++)
        {
            Expect(response.Results[i].ClientOpId == ops[i].ClientOpId,
                "Zmieniono kolejnosc wynikow operacji.");
        }

        return response;
    }

    public async Task<OpResult> Op(
        Device device,
        SyncOp op,
        string expectedStatus = "applied",
        string? expectedReason = null)
    {
        var result = (await Batch(device, new[] { op })).Results[0];

        Expect(result.Status == expectedStatus,
            $"Operacja {op.Type}: oczekiwano {expectedStatus}, jest {result.Status}, powod={result.Reason}.");

        if (expectedReason is not null)
        {
            Expect(result.Reason == expectedReason,
                $"Oczekiwano powodu {expectedReason}, jest {result.Reason}.");
        }

        if (expectedStatus == "applied")
        {
            Expect(result.Node is not null && result.Node.Id == op.NodeId,
                "Brak wezla w wyniku operacji.");
        }

        return result;
    }

    public async Task<NodeDto> Create(
        Device device,
        string kind,
        string title,
        string parentId,
        string? afterId = null,
        string? beforeId = null)
    {
        var result = await Op(device, new SyncOp
        {
            ClientOpId = Id(),
            Type = "create",
            NodeId = Id(),
            Kind = kind,
            ParentId = parentId,
            Title = title,
            Url = kind == "bookmark" ? "https://example.test/" + Id() : null,
            AfterId = afterId,
            BeforeId = beforeId
        });

        return result.Node!;
    }

    public async Task AssertBackup(string name, bool requireBookmarks = false)
    {
        Expect(Path.GetFileName(name) == name && name.EndsWith(".db", StringComparison.Ordinal),
            "Niepoprawna nazwa kopii.");

        var path = Path.Combine(Config.BackupDir, name);

        Expect(File.Exists(path) && new FileInfo(path).Length > 0,
            "Nie utworzono pliku kopii.");

        using var c = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false
        }.ToString());

        await c.OpenAsync();

        using var cmd = c.CreateCommand();

        cmd.CommandText =
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'";

        Expect(Convert.ToInt64(await cmd.ExecuteScalarAsync()) == 1, "Brak tabeli nodes.");

        cmd.CommandText = "PRAGMA integrity_check";

        Expect((string?)await cmd.ExecuteScalarAsync() == "ok", "Kopia jest niespojna.");

        if (requireBookmarks)
        {
            cmd.CommandText = "SELECT COUNT(*) FROM nodes WHERE kind='bookmark' AND deleted=0";

            Expect(Convert.ToInt64(await cmd.ExecuteScalarAsync()) > 0,
                "Kopia nie zawiera zakladek.");
        }
    }

    public static List<NodeDto> ParentsFirst(
        IEnumerable<NodeDto> nodes,
        IEnumerable<string> knownIds)
    {
        var pending = nodes.Where(n => !n.Deleted)
            .ToDictionary(n => n.Id, StringComparer.Ordinal);

        var known = knownIds.ToHashSet(StringComparer.Ordinal);
        var result = new List<NodeDto>();

        while (pending.Count > 0)
        {
            var ready = pending.Values
                .Where(n => n.ParentId is null || known.Contains(n.ParentId))
                .OrderBy(n => n.Order, StringComparer.Ordinal)
                .ThenBy(n => n.Id, StringComparer.Ordinal)
                .ToArray();

            Expect(ready.Length > 0, "Bufor zawiera cykl albo brakujacego rodzica.");

            foreach (var node in ready)
            {
                result.Add(node);
                known.Add(node.Id);
                pending.Remove(node.Id);
            }
        }

        return result;
    }

    public static string Otp(string secret, long step)
    {
        var key = Totp.DecodeBase32(secret);

        try
        {
            Span<byte> counter = stackalloc byte[8];
            BinaryPrimitives.WriteInt64BigEndian(counter, step);

            var hash = HMACSHA1.HashData(key, counter);
            var offset = hash[^1] & 15;

            var number =
                BinaryPrimitives.ReadUInt32BigEndian(hash.AsSpan(offset, 4))
                & 0x7fffffffU;

            return (number % 1_000_000U).ToString("D6", CultureInfo.InvariantCulture);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    public static async Task WithServer(Func<Harness, Task> test)
    {
        var isolated = new Harness();

        try
        {
            await isolated.Start();
            await test(isolated);
        }
        finally
        {
            await isolated.DisposeAsync();
        }

        Expect(isolated.Failed == 0, "Blad zatrzymania izolowanego serwera.");
    }

    // Pauza nie zmienia danych ani limiterow; wymusza nakladanie sie zadan HTTP.
    public async Task<WritePause> HoldWrites()
    {
        Expect(app is not null, "Serwer nie dziala.");
        return await WritePause.Start(app!.Services.GetRequiredService<Database>());
    }

    public sealed class WritePause : IAsyncDisposable
    {
        private readonly ManualResetEventSlim release = new(false);

        private readonly TaskCompletionSource entered =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private Task worker = Task.CompletedTask;

        public static async Task<WritePause> Start(Database database)
        {
            var pause = new WritePause();

            pause.worker = Task.Run(() => database.WriteAsync((c, tx) =>
            {
                pause.entered.TrySetResult();

                if (!pause.release.Wait(TimeSpan.FromSeconds(15)))
                    throw new TimeoutException("Nie zwolniono testowej pauzy zapisu.");
            }));

            try
            {
                await pause.entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
                return pause;
            }
            catch
            {
                await pause.DisposeAsync();
                throw;
            }
        }

        public async ValueTask DisposeAsync()
        {
            release.Set();

            try
            {
                await worker.WaitAsync(TimeSpan.FromSeconds(20));
            }
            finally
            {
                release.Dispose();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var client in clients)
            client.Dispose();

        if (app is not null)
        {
            try
            {
                await app.StopAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            catch (Exception ex)
            {
                RecordFailure("zatrzymanie serwera", ex);
            }

            try
            {
                await app.DisposeAsync();
            }
            catch (Exception ex)
            {
                RecordFailure("zwolnienie serwera", ex);
            }
        }

        SqliteConnection.ClearAllPools();

        if (dataDir.Length == 0 || !Directory.Exists(dataDir))
            return;

        var full = Path.GetFullPath(dataDir);

        var temp = Path.GetFullPath(Path.GetTempPath())
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;

        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        if (!full.StartsWith(temp, comparison)
            || !Path.GetFileName(full).StartsWith("FrogSync.Tests-", StringComparison.Ordinal))
        {
            RecordFailure("sprzatanie",
                new InvalidOperationException("Katalog nie jest katalogiem tymczasowym testu."));
            return;
        }

        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Directory.Delete(full, recursive: true);
                return;
            }
            catch (IOException) when (attempt < 4)
            {
                await Task.Delay(200);
            }
            catch (UnauthorizedAccessException) when (attempt < 4)
            {
                await Task.Delay(200);
            }
            catch (Exception ex)
            {
                RecordFailure("sprzatanie", ex);
                return;
            }
        }
    }

    private sealed class SetupLoggerProvider : ILoggerProvider
    {
        public TaskCompletionSource<string> SetupCode { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public ConcurrentQueue<string> Messages { get; } = new();

        public ILogger CreateLogger(string categoryName) => new Collector(this);

        public void Dispose()
        {
        }

        private sealed class Collector(SetupLoggerProvider owner) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                var text = formatter(state, exception);
                owner.Messages.Enqueue(text);

                var match = Regex.Match(
                    text,
                    @"(?<![A-Z2-9])[A-Z2-9]{4}-[A-Z2-9]{4}(?![A-Z2-9])");

                if (match.Success)
                    owner.SetupCode.TrySetResult(match.Value);
            }
        }
    }
}
