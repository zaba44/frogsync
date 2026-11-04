using Microsoft.Data.Sqlite;
using FrogSync.Server.Security;

namespace FrogSync.Server.Infrastructure;

/// <summary>
/// Kopie zapasowe bazy.
///
/// Spojna kopia przez SQLite Backup API — dziala na zywej bazie i nie blokuje
/// zapisow. Najpierw lokalnie (backups/ obok bazy), dopiero potem kopia pliku
/// do katalogu dodatkowego, np. Nextcloud. Wolny lub zablokowany katalog
/// dodatkowy konczy sie ostrzezeniem w logu, nigdy przestojem serwera.
/// </summary>
public sealed class BackupService(AppConfig config, Database db, CertificateStore certificates, ILogger<BackupService> logger) : BackgroundService
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public string? LastWarning { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Pierwsza kopia chwile po starcie, potem cyklicznie
        try { await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken); } catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RunAsync("automatyczna"); }
            catch (Exception ex) { logger.LogError(ex, "Kopia zapasowa nie powiodla sie"); }

            try { await Task.Delay(config.BackupInterval, stoppingToken); } catch (OperationCanceledException) { return; }
        }
    }

    public async Task<string> RunAsync(string reason)
    {
        await _gate.WaitAsync();
        try
        {
            Directory.CreateDirectory(config.BackupDir);
            // Sufiks gwarantuje unikalnosc przy dwoch kopiach w tej samej sekundzie.
            // Zapis do pliku tymczasowego i zmiana nazwy na koncu: niedokonczona kopia
            // nigdy nie wyglada jak gotowa.
            var name = $"frogsync-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid().ToString("N")[..6]}.db";
            var path = Path.Combine(config.BackupDir, name);
            var temp = path + ".tmp";

            using (var source = db.Open())
            using (var target = new SqliteConnection($"Data Source={temp};Pooling=False"))
            {
                target.Open();
                Restrict(temp);
                source.BackupDatabase(target);
            }
            SqliteConnection.ClearAllPools();
            File.Move(temp, path);

            Prune(config.BackupDir);
            logger.LogInformation("Kopia {Reason}: {Name}", reason, name);

            if (!string.IsNullOrWhiteSpace(config.BackupExtraDir))
            {
                try
                {
                    Directory.CreateDirectory(config.BackupExtraDir);
                    var extra = Path.Combine(config.BackupExtraDir, name);
                    File.Copy(path, extra, overwrite: true);
                    Restrict(extra);
                    Prune(config.BackupExtraDir);
                    LastWarning = null;
                }
                catch (Exception ex)
                {
                    LastWarning = $"Kopia lokalna jest, ale nie udalo sie zapisac do {config.BackupExtraDir}: {ex.Message}";
                    logger.LogWarning("{Warning}", LastWarning);
                }
            }
            return name;
        }
        finally { _gate.Release(); }
    }

    public const long UploadLimit = 512L * 1024 * 1024;

    public string? FindBackup(string name)
    {
        if (!Directory.Exists(config.BackupDir) || name != Path.GetFileName(name)) return null;
        return new DirectoryInfo(config.BackupDir).EnumerateFiles("frogsync-*.db")
            .FirstOrDefault(f => f.Name == name && (f.Attributes & FileAttributes.ReparsePoint) == 0)?.FullName;
    }

    public Task<string> RestoreAsync(string name, string? ip, Func<bool>? authorized = null) =>
        StageRestoreAsync(async (file, ct) =>
        {
            var path = FindBackup(name) ?? throw new ArgumentException("Nie ma takiej kopii.");
            await using var source = File.OpenRead(path);
            await source.CopyToAsync(file, ct);
        }, name, ip, false, authorized, default);

    public Task<string> RestoreUploadAsync(Stream body, string? ip, bool setup, Func<bool>? authorized, CancellationToken ct) =>
        StageRestoreAsync(async (file, token) =>
        {
            var buffer = new byte[81920];
            long total = 0;
            int size;
            while ((size = await body.ReadAsync(buffer.AsMemory(), token)) > 0)
            {
                total += size;
                if (total > UploadLimit) throw new BadHttpRequestException("Limit kopii: 512 MB.", 413);
                await file.WriteAsync(buffer.AsMemory(0, size), token);
            }
        }, "wgrany plik", ip, setup, authorized, ct);

    public sealed class RestoreStateChanged : Exception { }

    private async Task<string> StageRestoreAsync(Func<Stream, CancellationToken, Task> stage,
        string label, string? ip, bool setup, Func<bool>? authorized, CancellationToken ct)
    {
        Directory.CreateDirectory(config.BackupDir);
        var temp = Path.Combine(config.BackupDir, $".restore-{Guid.NewGuid():N}.tmp");
        var safety = $"frogsync-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.db";
        var safetyPath = Path.Combine(config.BackupDir, safety);
        var safetyTemp = safetyPath + ".tmp";
        try
        {
            await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                Restrict(temp);
                await stage(file, ct);
            }

            Validate(temp);
            using var staged = OpenFile(temp, SqliteOpenMode.ReadWrite);
            try
            {
                Database.Migrate(staged);
                if (setup && Database.Scalar(staged, "SELECT 1 FROM admin WHERE id = 1") is null)
                    throw new ArgumentException("Kopia nie ma administratora. Wybierz kopie skonfigurowanego serwera.");
                using var tx = staged.BeginTransaction();
                Database.NewGeneration(staged, tx);
                Database.Exec(staged, "DELETE FROM admin_sessions; UPDATE devices SET cursor = 0;", tx);
                Audit.Write(staged, tx, "backup-restored", "admin", ip, $"{label} (kopia bezpieczenstwa: {safety})");
                tx.Commit();
            }
            catch (SqliteException ex) when (ex.SqliteErrorCode is 1 or 11 or 26)
            {
                throw new ArgumentException("Kopia jest uszkodzona. Wybierz inna kopie FrogSync.", ex);
            }

            await _gate.WaitAsync(ct);
            try
            {
                await db.ExclusiveAsync(live =>
                {
                    ct.ThrowIfCancellationRequested();
                    if ((setup && Database.Scalar(live, "SELECT 1 FROM admin WHERE id = 1") is not null) ||
                        (authorized is not null && !authorized())) throw new RestoreStateChanged();

                    using (var snapshot = OpenFile(safetyTemp, SqliteOpenMode.ReadWriteCreate))
                    {
                        Restrict(safetyTemp);
                        live.BackupDatabase(snapshot);
                    }
                    File.Move(safetyTemp, safetyPath);
                    staged.BackupDatabase(live);
                    certificates.Reload();
                });
                logger.LogWarning("Odtworzono baze: {Source}. Kopia bezpieczenstwa: {Safety}", label, safety);
                return safety;
            }
            finally { _gate.Release(); }
        }
        finally
        {
            foreach (var file in new[] { temp, temp + "-journal", temp + "-wal", temp + "-shm", safetyTemp })
                try { File.Delete(file); } catch (IOException ex) { logger.LogWarning(ex, "Nie mozna usunac pliku tymczasowego."); }
        }
    }

    private static void Validate(string path)
    {
        try
        {
            using var c = OpenFile(path, SqliteOpenMode.ReadOnly);
            if (Database.Scalar(c, "PRAGMA integrity_check") as string != "ok")
                throw new ArgumentException("Kopia jest uszkodzona. Wybierz inna kopie FrogSync.");
            var count = Convert.ToInt32(Database.Scalar(c,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('schema_version','nodes','admin','profiles','devices','meta','admin_sessions')"));
            if (count != 7)
                throw new ArgumentException("To nie jest kopia FrogSync. Wybierz plik .db pobrany z panelu.");
            var version = Database.Scalar(c, "SELECT MAX(version) FROM schema_version");
            if (version is not long number || number < 1)
                throw new ArgumentException("To nie jest kopia FrogSync. Wybierz plik .db pobrany z panelu.");
            if (number > Database.SchemaVersion)
                throw new ArgumentException("Kopia pochodzi z nowszej wersji serwera — zaktualizuj serwer.");
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode is 1 or 11 or 26)
        {
            var message = ex.SqliteErrorCode == 26
                ? "To nie jest kopia FrogSync. Wybierz plik .db pobrany z panelu."
                : "Kopia jest uszkodzona. Wybierz inna kopie FrogSync.";
            throw new ArgumentException(message, ex);
        }
    }

    private static SqliteConnection OpenFile(string path, SqliteOpenMode mode)
    {
        var c = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = path, Mode = mode, Pooling = false }.ToString());
        try { c.Open(); return c; }
        catch { c.Dispose(); throw; }
    }

    private static void Restrict(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    public object List()
    {
        var files = Directory.Exists(config.BackupDir)
            ? new DirectoryInfo(config.BackupDir).GetFiles("frogsync-*.db")
                .Where(f => (f.Attributes & FileAttributes.ReparsePoint) == 0)
                .OrderByDescending(f => f.Name, StringComparer.Ordinal)
                .Select(f => new { name = f.Name, sizeKb = f.Length / 1024, at = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds() })
                .ToList<object>()
            : [];
        return new { files, warning = LastWarning, extraDir = config.BackupExtraDir };
    }

    private void Prune(string dir)
    {
        var stale = new DirectoryInfo(dir).GetFiles("frogsync-*.db")
            .OrderByDescending(f => f.Name, StringComparer.Ordinal)
            .Skip(config.BackupKeep);
        foreach (var file in stale)
            try { file.Delete(); } catch { /* zablokowana kopia zostanie usunieta nastepnym razem */ }
    }
}
