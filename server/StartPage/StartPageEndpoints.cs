using System.Globalization;
using System.Text.Json;
using FrogSync.Server.Device;

namespace FrogSync.Server.StartPage;

public static class StartPageEndpoints
{
    public static void MapDevice(RouteGroupBuilder authed)
    {
        authed.MapGet("/startpage",
            (HttpContext http, StartPageService service) => Guard(() =>
                Task.FromResult(ConditionalJson(http,
                    service.Get(Device(http).ProfileId)))));

        authed.MapPut("/startpage/custom",
            (HttpContext http, StartPageService service) => Guard(async () =>
            {
                var request = await ReadJson<StartPageCustomSave>(http);
                var device = Device(http);

                return Results.Json(await service.SaveCustomAsync(
                    device.ProfileId, device.DeviceId, request,
                    DeviceEndpoints.Ip(http), http.RequestAborted),
                    StartPageService.Json);
            }));

        foreach (var background in new[] { false, true })
        {
            var name = background ? "background" : "logo";

            authed.MapGet("/startpage/" + name,
                (HttpContext http, StartPageService service) => Guard(() =>
                    Task.FromResult(Image(http,
                        service.GetAsset(Device(http).ProfileId, background), background))));
        }
    }

    public static void MapAdmin(RouteGroupBuilder authed)
    {
        authed.MapGet("/profiles/{id}/startpage",
            (string id, HttpContext http, StartPageService service) => Guard(() =>
                Task.FromResult(ConditionalJson(http, service.Get(id)))));

        authed.MapPut("/profiles/{id}/startpage",
            (string id, HttpContext http, StartPageService service) => Guard(async () =>
            {
                var request = await ReadJson<StartPageSave>(http);

                return Results.Json(await service.SaveAsync(
                    id, request, DeviceEndpoints.Ip(http), http.RequestAborted),
                    StartPageService.Json);
            }));

        authed.MapGet("/profiles/{id}/folders",
            (string id, HttpContext http, StartPageService service) => Guard(() =>
                Task.FromResult(ConditionalJson(http, service.GetFolders(id)))));

        foreach (var background in new[] { false, true })
        {
            var name = background ? "background" : "logo";
            var path = "/profiles/{id}/startpage/" + name;

            authed.MapGet(path,
                (string id, HttpContext http, StartPageService service) => Guard(() =>
                    Task.FromResult(Image(http, service.GetAsset(id, background), background))));

            authed.MapPut(path,
                (string id, HttpContext http, StartPageService service) => Guard(async () =>
                {
                    var (generation, version) = AssetStamp(http, background);
                    var type = (http.Request.ContentType ?? "")
                        .Split(';', 2)[0].Trim().ToLowerInvariant();

                    if (type is not ("image/png" or "image/jpeg" or "image/webp"))
                        return Error(415, "UNSUPPORTED_MEDIA_TYPE",
                            "Dozwolone PNG, JPEG i WebP; bez SVG.");

                    var bytes = await ReadBody(http,
                        background ? StartPageService.MaxBackgroundBytes : StartPageService.MaxLogoBytes);

                    return Results.Json(await service.SaveAssetAsync(
                        id, generation, version, bytes, type, background,
                        DeviceEndpoints.Ip(http), http.RequestAborted),
                        StartPageService.Json);
                }));

            authed.MapDelete(path,
                (string id, HttpContext http, StartPageService service) => Guard(async () =>
                {
                    var (generation, version) = AssetStamp(http, background);

                    return Results.Json(await service.SaveAssetAsync(
                        id, generation, version, null, null, background,
                        DeviceEndpoints.Ip(http), http.RequestAborted),
                        StartPageService.Json);
                }));
        }
    }

    private static DeviceIdentity Device(HttpContext http) =>
        (DeviceIdentity)http.Items[nameof(DeviceIdentity)]!;

    private static IResult ConditionalJson<T>(HttpContext http, T value)
    {
        var etag = StartPageService.ETag(value);
        http.Response.Headers.ETag = etag;

        return Matches(http, etag)
            ? Results.StatusCode(304)
            : Results.Json(value, StartPageService.Json);
    }

    private static IResult Image(HttpContext http, StartPageAsset asset, bool background)
    {
        var name = background ? "background" : "logo";
        var versionHeader = background
            ? "X-FrogSync-Background-Version"
            : "X-FrogSync-Logo-Version";

        http.Response.Headers["X-FrogSync-Generation"] = asset.Generation;
        http.Response.Headers[versionHeader] =
            asset.Version.ToString(CultureInfo.InvariantCulture);

        if (asset.Bytes is null)
            return Error(404,
                background ? "BACKGROUND_NOT_FOUND" : "LOGO_NOT_FOUND",
                "Profil nie ma tego obrazu.");

        var etag = StartPageService.ETag(new
        {
            asset.ProfileId,
            asset.Generation,
            asset.Version,
            asset = name,
        });

        http.Response.Headers.ETag = etag;

        return Matches(http, etag)
            ? Results.StatusCode(304)
            : Results.File(asset.Bytes, asset.ContentType!);
    }

    private static bool Matches(HttpContext http, string etag)
    {
        foreach (var value in http.Request.Headers.IfNoneMatch.ToString().Split(','))
        {
            var candidate = value.Trim();

            if (candidate.StartsWith("W/", StringComparison.Ordinal))
                candidate = candidate[2..];

            if (candidate == "*" || candidate == etag)
                return true;
        }

        return false;
    }

    private static (string Generation, long Version) AssetStamp(
        HttpContext http, bool background)
    {
        var generation = http.Request.Query["generation"].ToString();
        var field = background ? "backgroundVersion" : "logoVersion";

        if (string.IsNullOrWhiteSpace(generation) ||
            !long.TryParse(http.Request.Query[field].ToString(),
                NumberStyles.None, CultureInfo.InvariantCulture, out var version) ||
            version < 0)
            throw new ArgumentException($"Wymagane generation i {field}.");

        return (generation, version);
    }

    private static async Task<T> ReadJson<T>(HttpContext http) where T : class
    {
        if (!http.Request.HasJsonContentType())
            throw new BadHttpRequestException("Wymagany application/json.", 415);

        return JsonSerializer.Deserialize<T>(
            await ReadBody(http, StartPageService.MaxJsonBytes),
            StartPageService.Json)
            ?? throw new ArgumentException("Brak dokumentu JSON.");
    }

    private static async Task<byte[]> ReadBody(HttpContext http, int maximum)
    {
        if (http.Request.ContentLength is { } length && length > maximum)
            throw new BadHttpRequestException("Przekroczony limit danych.", 413);

        using var output = new MemoryStream();
        var buffer = new byte[8192];

        while (true)
        {
            var count = await http.Request.Body.ReadAsync(
                buffer.AsMemory(), http.RequestAborted);

            if (count == 0)
                return output.ToArray();

            if (output.Length + count > maximum)
                throw new BadHttpRequestException("Przekroczony limit danych.", 413);

            await output.WriteAsync(buffer.AsMemory(0, count), http.RequestAborted);
        }
    }

    private static async Task<IResult> Guard(Func<Task<IResult>> work)
    {
        try { return await work(); }
        catch (StartPageConflict ex)
        {
            return Results.Json(new
            {
                error = "STARTPAGE_CHANGED",
                message = "Dane zmienily sie. Porownaj formularz z aktualna konfiguracja.",
                current = ex.Current,
            }, statusCode: 409);
        }
        catch (KeyNotFoundException)
        {
            return Error(404, "PROFILE_NOT_FOUND", "Nie ma takiego profilu.");
        }
        catch (JsonException)
        {
            return Error(400, "BAD_REQUEST", "Niepoprawny dokument JSON.");
        }
        catch (ArgumentException ex)
        {
            return Error(400, "BAD_REQUEST", ex.Message);
        }
        catch (BadHttpRequestException ex) when (ex.StatusCode is 413 or 415)
        {
            return Error(ex.StatusCode,
                ex.StatusCode == 413 ? "TOO_LARGE" : "UNSUPPORTED_MEDIA_TYPE",
                ex.Message);
        }
    }

    private static IResult Error(int status, string error, string message) =>
        Results.Json(new { error, message }, statusCode: status);
}
