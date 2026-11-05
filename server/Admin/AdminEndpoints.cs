using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.Features;
using FrogSync.Server.Device;
using FrogSync.Server.Infrastructure;
using FrogSync.Server.Security;

namespace FrogSync.Server.Admin;

/// <summary>
/// API panelu. Sesja w ciasteczku __Host- (tylko HTTPS, tylko ten host,
/// SameSite=Strict). Kazda zmiana wymaga dodatkowo naglowka X-FrogSync —
/// formularz z obcej strony nie potrafi go dolaczyc, wiec CSRF odpada podwojnie.
/// </summary>
public static class AdminEndpoints
{
    private const string Cookie = "__Host-frogsync";
    private const string CsrfHeader = "X-FrogSync";

    public sealed record SetupStart([property: JsonPropertyName("setupCode")] string SetupCode,
                                    [property: JsonPropertyName("password")]  string Password);
    public sealed record SetupFinish([property: JsonPropertyName("setupCode")] string SetupCode,
                                     [property: JsonPropertyName("totp")]      string Totp);
    public sealed record Login([property: JsonPropertyName("password")] string Password,
                               [property: JsonPropertyName("totp")]     string Totp);
    public sealed record NameBody([property: JsonPropertyName("name")] string Name);
    public sealed record PairingBody([property: JsonPropertyName("deviceName")] string DeviceName);
    public sealed record CertificateBody(
        [property: JsonPropertyName("pfxBase64")] string? PfxBase64,
        [property: JsonPropertyName("password")]  string? Password,
        [property: JsonPropertyName("certPem")]   string? CertPem,
        [property: JsonPropertyName("keyPem")]    string? KeyPem);
    public sealed record RestoreBody([property: JsonPropertyName("name")] string Name);
    public sealed record PasswordBody([property: JsonPropertyName("current")] string Current,
                                      [property: JsonPropertyName("totp")]    string Totp,
                                      [property: JsonPropertyName("next")]    string Next);

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/admin/api");
        api.AddEndpointFilter(RequireCsrfHeaderOnWrites);

        api.MapGet("/status", (AdminService admin, HttpContext http) =>
            Results.Ok(new { configured = admin.IsConfigured, signedIn = admin.ValidateSession(http.Request.Cookies[Cookie]) }));

        api.MapPost("/setup/start", (SetupStart body, AdminService admin, HttpContext http) =>
        {
            var (error, secret, uri) = admin.StartSetup(body.SetupCode, body.Password, DeviceEndpoints.Ip(http));
            return error switch
            {
                AdminService.SetupError.None => Results.Ok(new { secret, uri }),
                AdminService.SetupError.WeakPassword => Fail(400, "WEAK_PASSWORD", $"Haslo musi miec co najmniej {AdminService.MinPasswordLength} znakow."),
                AdminService.SetupError.Locked => Fail(429, "LOCKED", "Zbyt wiele blednych prob. Odczekaj 15 minut."),
                AdminService.SetupError.NotNeeded => Fail(409, "ALREADY_CONFIGURED", "Administrator juz istnieje."),
                _ => Fail(400, "BAD_SETUP_CODE", "Bledny kod konfiguracji. Znajdziesz go w logu kontenera."),
            };
        });

        api.MapPost("/setup/finish", async (SetupFinish body, AdminService admin, HttpContext http) =>
        {
            var (error, token) = await admin.FinishSetupAsync(body.SetupCode, body.Totp, DeviceEndpoints.Ip(http));
            if (error != AdminService.SetupError.None)
                return error switch
                {
                    AdminService.SetupError.BadTotp => Fail(400, "BAD_TOTP", "Kod z aplikacji sie nie zgadza. Sprawdz, czy zegar telefonu jest dokladny."),
                    AdminService.SetupError.NotNeeded => Fail(409, "ALREADY_CONFIGURED", "Administrator juz istnieje."),
                    _ => Fail(400, "SETUP_FAILED", "Zacznij konfiguracje od nowa."),
                };
            SetCookie(http, token!);
            return Results.Ok(new { ok = true });
        });

        api.MapPost("/setup/restore", async (AdminService admin, BackupService backups, HttpContext http) =>
        {
            var ip = DeviceEndpoints.Ip(http);
            var check = admin.CheckSetupCode(http.Request.Headers["X-Setup-Code"].ToString(), ip);
            if (check != AdminService.SetupError.None)
                return check switch
                {
                    AdminService.SetupError.NotNeeded => Fail(409, "ALREADY_CONFIGURED", "Administrator juz istnieje."),
                    AdminService.SetupError.Locked => Fail(429, "LOCKED", "Zbyt wiele blednych prob. Odczekaj 15 minut."),
                    _ => Fail(400, "BAD_SETUP_CODE", "Bledny kod konfiguracji. Znajdziesz go w logu kontenera."),
                };
            var response = await RestoreUpload(http, backups, true, null);
            if (admin.IsConfigured) admin.ClearSetup();
            return response;
        });

        api.MapPost("/login", async (Login body, AdminService admin, HttpContext http) =>
        {
            var (error, token, retry) = await admin.LoginAsync(body.Password, body.Totp, DeviceEndpoints.Ip(http));
            switch (error)
            {
                case AdminService.LoginError.None:
                    SetCookie(http, token!);
                    return Results.Ok(new { ok = true });
                case AdminService.LoginError.Locked:
                    return Fail(429, "LOCKED", $"Zbyt wiele blednych prob. Sprobuj za {Math.Ceiling(retry.TotalMinutes)} min.");
                case AdminService.LoginError.NotConfigured:
                    return Fail(409, "NOT_CONFIGURED", "Najpierw skonfiguruj administratora.");
                default:
                    return Fail(401, "INVALID", "Bledne haslo lub kod z aplikacji.");
            }
        });

        var authed = api.MapGroup("").AddEndpointFilter(RequireSession);

        FrogSync.Server.StartPage.StartPageEndpoints.MapAdmin(authed);

        authed.MapPost("/logout", async (AdminService admin, HttpContext http) =>
        {
            await admin.LogoutAsync(http.Request.Cookies[Cookie], DeviceEndpoints.Ip(http));
            http.Response.Cookies.Delete(Cookie, CookieOptions());
            return Results.Ok(new { ok = true });
        });

        authed.MapGet("/state", (AdminService admin, BackupService backups, Audit audit) =>
            Results.Ok(new { data = admin.State(), backups = backups.List(), audit = audit.Recent(50) }));

        authed.MapPost("/profiles", async (NameBody body, AdminService admin, HttpContext http) =>
            await Guard(async () => Results.Ok(new { id = await admin.CreateProfileAsync(body.Name, DeviceEndpoints.Ip(http)) })));

        authed.MapPost("/profiles/{id}/rename", async (string id, NameBody body, AdminService admin, HttpContext http) =>
            await Guard(async () => { await admin.RenameProfileAsync(id, body.Name, DeviceEndpoints.Ip(http)); return Results.Ok(new { ok = true }); }));

        authed.MapPost("/profiles/{id}/pairing", async (string id, PairingBody body, DeviceService devices, HttpContext http) =>
            await Guard(async () =>
            {
                var (code, expires) = await devices.CreatePairingCodeAsync(id, body.DeviceName, DeviceEndpoints.Ip(http));
                return Results.Ok(new { code, expiresAt = expires });
            }));

        authed.MapPost("/devices/{id}/revoke", async (string id, AdminService admin, HttpContext http) =>
            await Guard(async () => { await admin.RevokeDeviceAsync(id, DeviceEndpoints.Ip(http)); return Results.Ok(new { ok = true }); }));

        authed.MapPost("/devices/{id}/rename", async (string id, NameBody body, AdminService admin, HttpContext http) =>
            await Guard(async () => { await admin.RenameDeviceAsync(id, body.Name, DeviceEndpoints.Ip(http)); return Results.Ok(new { ok = true }); }));

        authed.MapPost("/backup", async (BackupService backups, Audit audit, HttpContext http) =>
        {
            var file = await backups.RunAsync("reczna");
            await audit.WriteAsync("backup-manual", "admin", DeviceEndpoints.Ip(http), file);
            return Results.Ok(new { file });
        });

        authed.MapGet("/backups/{name}", (string name, BackupService backups) =>
            backups.FindBackup(name) is { } path ? Results.File(path, "application/octet-stream", name)
                : Fail(404, "NOT_FOUND", "Nie ma takiej kopii. Odswiez liste kopii."));

        authed.MapPost("/restore/upload", (AdminService admin, BackupService backups, HttpContext http) =>
            RestoreUpload(http, backups, false, () => admin.ValidateSession(http.Request.Cookies[Cookie])));

        authed.MapPost("/restore", async (RestoreBody body, BackupService backups, AdminService admin, HttpContext http) =>
            await Guard(async () =>
            {
                var safety = await backups.RestoreAsync(body.Name, DeviceEndpoints.Ip(http),
                    () => admin.ValidateSession(http.Request.Cookies[Cookie]));
                http.Response.Cookies.Delete(Cookie, CookieOptions());
                return Results.Ok(new { ok = true, safetyBackup = safety });
            }));

        authed.MapGet("/certificate", (CertificateStore certs) => Results.Ok(certs.Info()));

        // Certyfikat z wlasnego CA: PFX/P12 (base64, opcjonalne haslo) albo para PEM.
        // Zaczyna dzialac od nastepnego polaczenia, bez restartu.
        authed.MapPost("/certificate", async (CertificateBody body, CertificateStore certs, Audit audit, HttpContext http) =>
            await Guard(async () =>
            {
                CertificateInfo info;
                if (!string.IsNullOrWhiteSpace(body.PfxBase64))
                {
                    byte[] bytes;
                    try { bytes = Convert.FromBase64String(body.PfxBase64); }
                    catch (FormatException) { throw new ArgumentException("Uszkodzony plik."); }
                    info = await certs.ReplaceFromPfx(bytes, body.Password);
                }
                else if (!string.IsNullOrWhiteSpace(body.CertPem) && !string.IsNullOrWhiteSpace(body.KeyPem))
                    info = await certs.ReplaceFromPem(body.CertPem, body.KeyPem);
                else
                    throw new ArgumentException("Wskaz plik PFX/P12 albo certyfikat i klucz w formacie PEM.");

                await audit.WriteAsync("certificate-uploaded", "admin", DeviceEndpoints.Ip(http),
                    $"{info.Subject}; {string.Join(", ", info.Names)}; do {DateTimeOffset.FromUnixTimeMilliseconds(info.NotAfter):yyyy-MM-dd}");
                return Results.Ok(info);
            }));

        authed.MapPost("/certificate/reset", async (CertificateStore certs, Audit audit, HttpContext http) =>
        {
            var info = await certs.ResetToSelfSigned();
            await audit.WriteAsync("certificate-reset", "admin", DeviceEndpoints.Ip(http));
            return Results.Ok(info);
        });

        authed.MapPost("/password", async (PasswordBody body, AdminService admin, HttpContext http) =>
        {
            if (!await admin.ChangePasswordAsync(body.Current, body.Totp, body.Next, DeviceEndpoints.Ip(http)))
                return Fail(400, "PASSWORD_NOT_CHANGED",
                    $"Haslo nie zostalo zmienione. Sprawdz obecne haslo i kod; nowe musi miec co najmniej {AdminService.MinPasswordLength} znakow.");
            http.Response.Cookies.Delete(Cookie, CookieOptions());
            return Results.Ok(new { ok = true, signedOut = true });
        });
    }

    // ============================================================

    private static async ValueTask<object?> RequireSession(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var http = ctx.HttpContext;
        var admin = http.RequestServices.GetRequiredService<AdminService>();
        if (!admin.ValidateSession(http.Request.Cookies[Cookie]))
            return Fail(401, "SIGNED_OUT", "Sesja wygasla — zaloguj sie ponownie.");
        return await next(ctx);
    }

    private static async ValueTask<object?> RequireCsrfHeaderOnWrites(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var request = ctx.HttpContext.Request;
        if (!HttpMethods.IsGet(request.Method) && request.Headers[CsrfHeader] != "1")
            return Fail(403, "CSRF", "Brak naglowka zabezpieczajacego.");
        return await next(ctx);
    }

    private static Task<IResult> RestoreUpload(HttpContext http, BackupService backups, bool setup, Func<bool>? authorized) =>
        Guard(async () =>
        {
            var contentType = http.Request.ContentType?.Split(';')[0].Trim();
            if (!string.Equals(contentType, "application/octet-stream", StringComparison.OrdinalIgnoreCase))
                return Fail(415, "BAD_CONTENT_TYPE", "Wybierz plik kopii .db i wyslij go jako application/octet-stream.");

            if (http.Request.ContentLength > BackupService.UploadLimit)
                return Fail(413, "TOO_LARGE", "Kopia przekracza limit 512 MB.");
            var size = http.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (size is { IsReadOnly: false }) size.MaxRequestBodySize = BackupService.UploadLimit;
            try
            {
                var safety = await backups.RestoreUploadAsync(http.Request.Body, DeviceEndpoints.Ip(http),
                    setup, authorized, http.RequestAborted);
                http.Response.Cookies.Delete(Cookie, CookieOptions());
                return Results.Ok(new { ok = true, safetyBackup = safety });
            }
            catch (BadHttpRequestException ex) when (ex.StatusCode == 413)
            {
                return Fail(413, "TOO_LARGE", "Kopia przekracza limit 512 MB.");
            }
        });

    private static async Task<IResult> Guard(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (BackupService.RestoreStateChanged) { return Fail(409, "RESTORE_STATE_CHANGED", "Stan panelu sie zmienil. Odswiez strone i sprobuj ponownie."); }
        catch (ArgumentException ex) { return Fail(400, "BAD_REQUEST", ex.Message); }
    }

    private static IResult Fail(int status, string error, string message) =>
        Results.Json(new { error, message }, statusCode: status);

    private static void SetCookie(HttpContext http, string token) =>
        http.Response.Cookies.Append(Cookie, token, CookieOptions());

    private static CookieOptions CookieOptions() => new()
    {
        HttpOnly = true,
        Secure = true,
        SameSite = SameSiteMode.Strict,
        Path = "/",
        MaxAge = AdminService.SessionLifetime,
    };
}
