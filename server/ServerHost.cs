using System.Net;
using FrogSync.Server.Admin;
using FrogSync.Server.Device;
using FrogSync.Server.Infrastructure;
using FrogSync.Server.Security;
using FrogSync.Server.Sync;

namespace FrogSync.Server;

/// <summary>
/// Skladanie serwera. Wydzielone z Program.cs, zeby testy mogly postawic
/// prawdziwy serwer na losowym porcie z tymczasowym katalogiem danych.
/// </summary>
public static class ServerHost
{
    public static WebApplication Build(AppConfig config, Action<WebApplicationBuilder>? customize = null)
    {
        ExtensionVersions.Validate(config);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "yyyy-MM-dd HH:mm:ss "; });

        builder.Services.AddSingleton(config);
        var db = new Database(config);
        db.Migrate();
        builder.Services.AddSingleton(db);
        builder.Services.AddSingleton<Limiters>();
        builder.Services.AddSingleton<Audit>();
        builder.Services.AddSingleton<SyncService>();
        builder.Services.AddSingleton<DeviceService>();
        builder.Services.AddSingleton<AdminService>();
        builder.Services.AddSingleton<BackupService>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<BackupService>());
        builder.Services.AddHostedService<MaintenanceService>();

        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNameCaseInsensitive = true);

        // Tylko HTTPS. Magazyn certyfikatu powstaje przed aplikacja, bo Kestrel
        // musi go znac, zanim zacznie nasluchiwac. Pyta o certyfikat przy kazdym
        // polaczeniu, wiec wgranie nowego w panelu dziala bez restartu.
        var bootLogger = LoggerFactory.Create(l => l.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "yyyy-MM-dd HH:mm:ss "; }));
        var certificates = new CertificateStore(config, db, bootLogger.CreateLogger("FrogSync.Certyfikat"));
        builder.Services.AddSingleton(certificates);
        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            kestrel.AddServerHeader = false;
            kestrel.Limits.MaxRequestBodySize = 16 * 1024 * 1024;
            kestrel.ListenAnyIP(config.Port, listen => listen.UseHttps(https =>
                https.ServerCertificateSelector = (_, _) => certificates.Current));
        });

        customize?.Invoke(builder);

        var app = builder.Build();

        app.Use(NetworkFilter(config, app.Logger));
        app.Use(SecurityHeaders);

        app.UseDefaultFiles();
        app.UseStaticFiles();

        DeviceEndpoints.Map(app);
        AdminEndpoints.Map(app);

        app.MapGet("/healthz", () => Results.Ok(new { ok = true }));

        app.Lifetime.ApplicationStarted.Register(() =>
            app.Services.GetRequiredService<AdminService>().AnnounceSetupIfNeeded($"https://<adres-serwera>:{config.Port}/"));

        return app;
    }

    /// <summary>
    /// Domyslnie wpuszczamy tylko adresy prywatne, loopback i zakres VPN.
    /// Otwarcie na internet wymaga swiadomego FROGSYNC_ALLOW_PUBLIC=true.
    /// </summary>
    private static Func<HttpContext, Func<Task>, Task> NetworkFilter(AppConfig config, ILogger logger) => async (http, next) =>
    {
        if (!config.AllowPublic)
        {
            var remote = http.Connection.RemoteIpAddress;
            if (remote is null || !NetworkGuard.IsPrivate(remote))
            {
                logger.LogWarning("Odrzucono polaczenie spoza sieci prywatnej: {Ip}", remote);
                http.Response.StatusCode = (int)HttpStatusCode.Forbidden;
                return;
            }
        }
        await next();
    };

    private static async Task SecurityHeaders(HttpContext http, Func<Task> next)
    {
        var headers = http.Response.Headers;
        headers["X-Content-Type-Options"] = "nosniff";
        headers["Referrer-Policy"] = "no-referrer";
        headers["X-Frame-Options"] = "DENY";
        headers["Cache-Control"] = "no-store";
        // Panel nie ladowal niczego z zewnatrz — i nie bedzie mogl
        headers["Content-Security-Policy"] =
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
        // Swiadomie BEZ Access-Control-Allow-Origin: wtyczka z uprawnieniem do hosta
        // nie podlega CORS, a strony WWW maja nie moc czytac odpowiedzi.
        await next();
    }
}

/// <summary>Sprzatanie raz na dobe: stare wpisy dziennika i idempotencji.</summary>
public sealed class MaintenanceService(Audit audit, SyncService sync, ILogger<MaintenanceService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await audit.PruneAsync();
                await sync.PruneOpsAsync();
            }
            catch (Exception ex) { logger.LogError(ex, "Sprzatanie nie powiodlo sie"); }

            try { await Task.Delay(TimeSpan.FromHours(24), stoppingToken); } catch (OperationCanceledException) { return; }
        }
    }
}
