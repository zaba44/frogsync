using System.Text.Json.Serialization;
using FrogSync.Server.Infrastructure;
using FrogSync.Server.Sync;

namespace FrogSync.Server.Device;

/// <summary>API dla wtyczki. Wszystko poza parowaniem wymaga tokenu urzadzenia.</summary>
public static class DeviceEndpoints
{
    public const string Version = "0.1.0";
    public const int Protocol = 3;
    public const int MinProtocol = 2;

    public sealed class PairRequest
    {
        [JsonPropertyName("code")]    public string Code    { get; init; } = "";
        [JsonPropertyName("expectContent")] public bool? ExpectContent { get; init; }
        [JsonPropertyName("browser")] public string Browser { get; init; } = "";
    }

    public sealed class CursorRequest
    {
        [JsonPropertyName("cursor")] public long Cursor { get; init; }
    }

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api/v1");
        api.AddEndpointFilter(RejectForeignOrigin);

        api.MapPost("/pair/preview", async (PairRequest body, HttpContext http, DeviceService devices) =>
        {
            var attempt = await devices.PairAsync(body.Code, "", Ip(http), preview: true);
            return attempt.Preview is { } preview ? Results.Ok(preview) : PairFailure(attempt);
        });

        api.MapPost("/pair", async (PairRequest body, HttpContext http, DeviceService devices) =>
        {
            var attempt = await devices.PairAsync(body.Code, body.Browser, Ip(http), body.ExpectContent);
            return attempt.Result is { } result
                ? Results.Ok(new { token = result.Token, deviceId = result.DeviceId,
                    profile = new { id = result.ProfileId, name = result.ProfileName } })
                : PairFailure(attempt);
        });

        var authed = api.MapGroup("").AddEndpointFilter(RequireDevice);

        authed.MapGet("/hello", async (HttpContext http, SyncService sync, DeviceService devices, AppConfig config) =>
        {
            var device = Device(http);
            var extensionVersion = http.Request.Headers[ExtensionVersions.Header].ToString();
            if (ExtensionVersions.IsValid(extensionVersion))
                await devices.SaveExtensionVersionAsync(device.DeviceId, extensionVersion);

            return Results.Ok(new
            {
                server = "FrogSync",
                version = Version,
                protocol = Protocol,
                minProtocol = MinProtocol,
                minExtensionVersion = config.MinExtensionVersion,
                latestExtensionVersion = config.LatestExtensionVersion,
                device = new { id = device.DeviceId, name = device.DeviceName },
                profile = new { id = device.ProfileId, name = device.ProfileName },
                head = sync.Head(device.ProfileId),
                generation = http.RequestServices.GetRequiredService<Database>().Generation(),
                roots = NodeKinds.RootIds,
            });
        });

        // Kontrakt dla wtyczki: pobierz WSZYSTKIE strony (az more = false), zastosuj je
        // rodzice przed dziecmi i dopiero wtedy zapisz kursor. Dziennik oddaje aktualny
        // stan wezlow, wiec dziecko moze przyjsc na wczesniejszej stronie niz rodzic.
        //
        // RESET_REQUIRED: baza zostala odtworzona z kopii (inna generacja) albo kursor
        // wtyczki wybiega poza dziennik. Wtyczka musi wtedy uzgodnic stan od zera,
        // zamiast cicho przeskoczyc zmiany.
        authed.MapGet("/changes", (long? after, int? limit, string? generation, HttpContext http, SyncService sync, Database db) =>
        {
            var profileId = Device(http).ProfileId;
            var current = db.Generation();
            var cursor = after ?? 0;
            if ((!string.IsNullOrEmpty(generation) && generation != current) || cursor > sync.Head(profileId))
                return Results.Json(new { error = "RESET_REQUIRED", generation = current,
                    message = "Stan serwera zmienil sie (np. odtworzenie kopii). Wymagane ponowne uzgodnienie." }, statusCode: 409);
            return Results.Ok(sync.GetChanges(profileId, cursor, limit ?? 500));
        });

        authed.MapPost("/ops", async (OpsRequest body, HttpContext http, SyncService sync) =>
        {
            // Klient z generacja, ale bez pola protocol, to dotychczasowy klient 0.2.
            var protocol = body.Protocol ?? 2;
            if (string.IsNullOrWhiteSpace(body.Generation) || protocol < MinProtocol)
                return Results.Json(new
                {
                    error = "OUTDATED_CLIENT",
                    message = "Zaktualizuj wtyczkę FrogSync (przeładuj ją na stronie rozszerzeń).",
                }, statusCode: 409);

            if (protocol > Protocol)
                return Results.Json(new
                {
                    error = "OUTDATED_SERVER",
                    message = "Zaktualizuj serwer FrogSync do wersji zgodnej z wtyczką.",
                }, statusCode: 409);

            var device = Device(http);
            try { return Results.Ok(await sync.ApplyAsync(device.ProfileId, device.DeviceId, body.Ops, body.Generation)); }
            catch (SyncService.ResetRequired ex) { return Results.Json(new { error = "RESET_REQUIRED", generation = ex.Generation }, statusCode: 409); }
            catch (ArgumentException ex) { return Results.Json(new { error = "BAD_REQUEST", message = ex.Message }, statusCode: 400); }
        });

        // Wtyczka melduje, do ktorego miejsca dziennika FAKTYCZNIE zastosowala zmiany.
        // Sluzy wylacznie panelowi ("urzadzenie jest N zmian w tyle") - o tym,
        // co pobrac, decyduje kursor trzymany przez wtyczke.
        authed.MapPost("/cursor", async (CursorRequest body, HttpContext http, DeviceService devices) =>
        {
            await devices.SaveCursorAsync(Device(http).DeviceId, body.Cursor);
            return Results.NoContent();
        });
    }

    // ============================================================

    private static IResult PairFailure(DeviceService.PairAttempt attempt) => attempt.Outcome switch
    {
        DeviceService.PairOutcome.Locked => Results.Json(
            new { error = "LOCKED", message = "Zbyt wiele blednych kodow. Sprobuj pozniej.",
                retryAfterSeconds = (int)Math.Ceiling(attempt.RetryAfter.TotalSeconds) }, statusCode: 429),
        DeviceService.PairOutcome.ProfileChanged => Results.Json(
            new { error = "PROFILE_CHANGED", hasContent = attempt.Preview!.HasContent }, statusCode: 409),
        _ => Results.Json(new { error = "INVALID_CODE", message = "Kod jest bledny albo wygasl." }, statusCode: 400),
    };

    private static async ValueTask<object?> RequireDevice(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var http = ctx.HttpContext;
        var header = http.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.Ordinal) ? header[7..].Trim() : null;

        var identity = http.RequestServices.GetRequiredService<DeviceService>().Authenticate(token, Ip(http));
        if (identity is null)
            return Results.Json(new { error = "UNAUTHORIZED", message = "Brak waznego tokenu urzadzenia" }, statusCode: 401);

        var extensionVersion = http.Request.Headers[ExtensionVersions.Header].ToString();
        if (extensionVersion.Length > 0 && !ExtensionVersions.IsValid(extensionVersion))
            return Results.Json(new
            {
                error = "INVALID_EXTENSION_VERSION",
                message = "Nieprawidłowy numer wersji wtyczki. Zaktualizuj FrogSync.",
            }, statusCode: 400);

        var config = http.RequestServices.GetRequiredService<AppConfig>();
        // Hello pozostaje dostepne: stary klient odczyta wymagania i zglosi wersje.
        if (http.Request.Path != "/api/v1/hello" &&
            ExtensionVersions.IsTooOld(extensionVersion, config.MinExtensionVersion))
            return Results.Json(new
            {
                error = "OUTDATED_CLIENT",
                message = ExtensionVersions.UpdateMessage,
                minExtensionVersion = config.MinExtensionVersion,
                latestExtensionVersion = config.LatestExtensionVersion,
            }, statusCode: 409);

        http.Items[nameof(DeviceIdentity)] = identity;
        return await next(ctx);
    }

    /// <summary>
    /// Strona WWW wykonujaca fetch zawsze wysyla wlasny Origin. Wtyczka wysyla
    /// origin rozszerzenia albo zaden. Odrzucamy wszystko inne - strona otwarta
    /// w przegladarce nie ma prawa rozmawiac z tym API.
    /// </summary>
    private static async ValueTask<object?> RejectForeignOrigin(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var origin = ctx.HttpContext.Request.Headers.Origin.ToString();
        if (!string.IsNullOrEmpty(origin) && !IsExtensionOrigin(origin))
            return Results.Json(new { error = "FORBIDDEN_ORIGIN" }, statusCode: 403);
        return await next(ctx);
    }

    private static bool IsExtensionOrigin(string origin) =>
        origin.StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase) ||
        origin.StartsWith("moz-extension://", StringComparison.OrdinalIgnoreCase) ||
        origin.StartsWith("extension://", StringComparison.OrdinalIgnoreCase);

    private static DeviceIdentity Device(HttpContext http) => (DeviceIdentity)http.Items[nameof(DeviceIdentity)]!;

    public static string Ip(HttpContext http) => http.Connection.RemoteIpAddress?.ToString() ?? "?";
}
