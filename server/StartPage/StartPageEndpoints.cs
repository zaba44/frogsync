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
                Task.FromResult(Configuration(http,
                    service.Get(Device(http).ProfileId)))));

        authed.MapGet("/startpage/logo",
            (HttpContext http, StartPageService service) => Guard(() =>
                Task.FromResult(Logo(http,
                    service.GetLogo(Device(http).ProfileId)))));
    }

    public static void MapAdmin(RouteGroupBuilder authed)
    {
        authed.MapGet("/profiles/{id}/startpage",
            (string id, HttpContext http, StartPageService service) => Guard(() =>
                Task.FromResult(Configuration(http, service.Get(id)))));

        authed.MapPut("/profiles/{id}/startpage",
            (string id, HttpContext http, StartPageService service) => Guard(async () =>
            {
                if (!http.Request.HasJsonContentType())
                    return Error(415, "UNSUPPORTED_MEDIA_TYPE", "Wymagany application/json.");

                var bytes = await ReadBody(http, StartPageService.MaxJsonBytes);
                var request = JsonSerializer.Deserialize<StartPageSave>(
                    bytes, StartPageService.Json);

                if (request is null)
                    throw new ArgumentException("Brak konfiguracji.");

                var saved = await service.SaveAsync(
                    id, request, DeviceEndpoints.Ip(http), http.RequestAborted);

                return Results.Json(saved, StartPageService.Json);
            }));

        authed.MapGet("/profiles/{id}/folders",
            (string id, HttpContext http, StartPageService service) => Guard(() =>
            {
                var result = service.GetFolders(id);
                return Task.FromResult(ConditionalJson(http, result));
            }));

        // GET jest potrzebny do podgladu logo w panelu z sesja administratora.
        authed.MapGet("/profiles/{id}/startpage/logo",
            (string id, HttpContext http, StartPageService service) => Guard(() =>
                Task.FromResult(Logo(http, service.GetLogo(id)))));

        authed.MapPut("/profiles/{id}/startpage/logo",
            (string id, HttpContext http, StartPageService service) => Guard(async () =>
            {
                var (generation, version) = LogoStamp(http);

                var type = (http.Request.ContentType ?? "")
                    .Split(';', 2)[0].Trim().ToLowerInvariant();

                if (type is not ("image/png" or "image/jpeg" or "image/webp"))
                    return Error(415, "UNSUPPORTED_MEDIA_TYPE",
                        "Dozwolone PNG, JPEG i WebP; bez SVG.");

                var bytes = await ReadBody(http, StartPageService.MaxLogoBytes);

                var saved = await service.SaveLogoAsync(
                    id, generation, version, bytes, type,
                    DeviceEndpoints.Ip(http), http.RequestAborted);

                return Results.Json(saved, StartPageService.Json);
            }));

        authed.MapDelete("/profiles/{id}/startpage/logo",
            (string id, HttpContext http, StartPageService service) => Guard(async () =>
            {
                var (generation, version) = LogoStamp(http);

                var saved = await service.SaveLogoAsync(
                    id, generation, version, null, null,
                    DeviceEndpoints.Ip(http), http.RequestAborted);

                return Results.Json(saved, StartPageService.Json);
            }));
    }

    private static DeviceIdentity Device(HttpContext http) =>
        (DeviceIdentity)http.Items[nameof(DeviceIdentity)]!;

    private static IResult Configuration(HttpContext http, StartPageSnapshot value) =>
        ConditionalJson(http, value);

    private static IResult ConditionalJson<T>(HttpContext http, T value)
    {
        var etag = StartPageService.ETag(value);
        http.Response.Headers.ETag = etag;

        return Matches(http, etag)
            ? Results.StatusCode(StatusCodes.Status304NotModified)
            : Results.Json(value, StartPageService.Json);
    }

    private static IResult Logo(HttpContext http, StartPageLogo logo)
    {
        http.Response.Headers["X-FrogSync-Generation"] = logo.Generation;
        http.Response.Headers["X-FrogSync-Logo-Version"] =
            logo.LogoVersion.ToString(CultureInfo.InvariantCulture);

        // Brak zasobu zawsze daje 404, rowniez ze starym If-None-Match.
        if (logo.Bytes is null)
            return Error(404, "LOGO_NOT_FOUND", "Profil nie ma logo.");

        var etag = StartPageService.ETag(new
        {
            logo.ProfileId,
            logo.Generation,
            logo.LogoVersion,
        });

        http.Response.Headers.ETag = etag;

        return Matches(http, etag)
            ? Results.StatusCode(StatusCodes.Status304NotModified)
            : Results.File(logo.Bytes, logo.ContentType!);
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

    private static (string Generation, long Version) LogoStamp(HttpContext http)
    {
        var generation = http.Request.Query["generation"].ToString();

        if (string.IsNullOrWhiteSpace(generation) ||
            !long.TryParse(http.Request.Query["logoVersion"].ToString(),
                NumberStyles.None, CultureInfo.InvariantCulture, out var version) ||
            version < 0)
            throw new ArgumentException("Wymagane generation i logoVersion w query.");

        return (generation, version);
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
        try
        {
            return await work();
        }
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
        catch (BadHttpRequestException ex) when (ex.StatusCode == 413)
        {
            return Error(413, "TOO_LARGE", "Przekroczony limit danych.");
        }
    }

    private static IResult Error(int status, string error, string message) =>
        Results.Json(new { error, message }, statusCode: status);
}
