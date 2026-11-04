using FrogSync.Server.Infrastructure;
using FrogSync.Server.Security;
using FrogSync.Server.Sync;

namespace FrogSync.Server.Admin;

/// <summary>
/// Konto administratora: pierwsza konfiguracja, logowanie z 2FA, sesje.
///
/// Brak hasla domyslnego. Przy pierwszym starcie serwer wypisuje w logu
/// jednorazowy kod konfiguracji — bez niego nikt, nawet z tej samej sieci,
/// nie przejmie panelu swiezo postawionego serwera.
/// </summary>
public sealed class AdminService(Database db, Limiters limiters, ILogger<AdminService> logger)
{
    public const int MinPasswordLength = 12;
    public static readonly TimeSpan SessionLifetime = TimeSpan.FromHours(8);

    private readonly Lock _setupLock = new();
    private readonly SemaphoreSlim _loginGate = new(1, 1);
    private string? _setupCode;
    private (string SetupCode, string PasswordHash, string Secret, DateTimeOffset At)? _pending;

    public bool IsConfigured => db.Read(c => Database.Scalar(c, "SELECT 1 FROM admin WHERE id = 1") is not null);

    /// <summary>Wolane przy starcie. Bez konfiguracji generuje kod i wypisuje go w logu.</summary>
    public void AnnounceSetupIfNeeded(string publicHint)
    {
        if (IsConfigured) return;
        lock (_setupLock) _setupCode ??= Secrets.NewSetupCode();

        logger.LogWarning("""

            ============================================================
             FrogSync nie ma jeszcze administratora.
             Otworz {Hint} i podaj kod konfiguracji:

                 {Code}

             Kod dziala do restartu serwera.
            ============================================================
            """, publicHint, _setupCode);
    }

    // ============================================================
    // Pierwsza konfiguracja
    // ============================================================

    public enum SetupError { None, NotNeeded, Locked, BadCode, WeakPassword, BadTotp, Expired }

    public (SetupError Error, string? Secret, string? Uri) StartSetup(string setupCode, string password, string ip)
    {
        if (IsConfigured) return (SetupError.NotNeeded, null, null);
        lock (_setupLock)
        {
            var check = CheckSetupCode(setupCode, ip);
            if (check != SetupError.None) return (check, null, null);
            if ((password ?? "").Length < MinPasswordLength) return (SetupError.WeakPassword, null, null);

            var secret = Totp.GenerateSecret();
            _pending = (_setupCode!, Secrets.HashPassword(password!), secret, DateTimeOffset.UtcNow);
            return (SetupError.None, secret, Totp.GetOtpAuthUri("FrogSync", "admin", secret));
        }
    }

    public SetupError CheckSetupCode(string setupCode, string ip)
    {
        lock (_setupLock)
        {
            if (IsConfigured) return SetupError.NotNeeded;
            if (limiters.Setup.IsLocked(ip, out _)) return SetupError.Locked;
            if (_setupCode is not null && Secrets.ConstantTimeEquals(Normalize(setupCode), _setupCode))
                return SetupError.None;
            limiters.Setup.Fail(ip);
            return SetupError.BadCode;
        }
    }

    public void ClearSetup()
    {
        lock (_setupLock) { _setupCode = null; _pending = null; }
    }

    /// <summary>Konczy konfiguracje dopiero, gdy uzytkownik udowodni, ze aplikacja 2FA dziala.</summary>
    public async Task<(SetupError Error, string? SessionToken)> FinishSetupAsync(string setupCode, string totp, string ip)
    {
        (string SetupCode, string PasswordHash, string Secret, DateTimeOffset At) pending;
        lock (_setupLock)
        {
            if (IsConfigured) return (SetupError.NotNeeded, null);
            if (_pending is null || !Secrets.ConstantTimeEquals(Normalize(setupCode), _pending.Value.SetupCode))
                return (SetupError.BadCode, null);
            if (DateTimeOffset.UtcNow - _pending.Value.At > TimeSpan.FromMinutes(15)) return (SetupError.Expired, null);
            pending = _pending.Value;
        }

        var step = Totp.Verify(pending.Secret, totp, DateTimeOffset.UtcNow);
        if (step is null) return (SetupError.BadTotp, null);

        var token = await db.WriteAsync<string?>((c, tx) =>
        {
            // Ponowne sprawdzenie WEWNATRZ transakcji: dwie rownolegle proby
            // przechodza wczesniejszy test, ale tylko jedna moze utworzyc konto.
            if (Database.Scalar(c, "SELECT 1 FROM admin WHERE id = 1", tx) is not null) return null;

            Database.Exec(c, """
                INSERT INTO admin(id, password_hash, totp_secret, totp_last_step, created_at)
                VALUES (1, @h, @s, @step, @now)
                """, tx, ("@h", pending.PasswordHash), ("@s", pending.Secret), ("@step", step.Value), ("@now", Database.NowMs()));
            Audit.Write(c, tx, "admin-created", "admin", ip);
            return CreateSession(c, tx, ip);
        });

        if (token is null) return (SetupError.NotNeeded, null);
        lock (_setupLock) { _setupCode = null; _pending = null; }
        return (SetupError.None, token);
    }

    // ============================================================
    // Logowanie
    // ============================================================

    public enum LoginError { None, Locked, Invalid, NotConfigured }

    public async Task<(LoginError Error, string? SessionToken, TimeSpan RetryAfter)> LoginAsync(string password, string totp, string ip)
    {
        // Jak przy parowaniu: limit sprawdzany i naliczany w jednej niepodzielnej calosci
        await _loginGate.WaitAsync();
        try { return await LoginLockedAsync(password, totp, ip); }
        finally { _loginGate.Release(); }
    }

    private async Task<(LoginError Error, string? SessionToken, TimeSpan RetryAfter)> LoginLockedAsync(string password, string totp, string ip)
    {
        if (!IsConfigured) return (LoginError.NotConfigured, null, TimeSpan.Zero);
        if (limiters.AdminLogin.IsLocked(ip, out var wait)) return (LoginError.Locked, null, wait);

        var outcome = await db.WriteAsync<string?>((c, tx) =>
        {
            using var cmd = Database.Command(c, "SELECT password_hash, totp_secret, totp_last_step FROM admin WHERE id = 1", tx);
            using var r = cmd.ExecuteReader();
            r.Read();
            var (hash, secret, lastStep) = (r.GetString(0), r.GetString(1), r.GetInt64(2));
            r.Close();

            // Haslo i kod sprawdzamy zawsze oba, zeby czas odpowiedzi nie zdradzal,
            // ktory z nich byl bledny
            var passwordOk = Secrets.VerifyPassword(password ?? "", hash);
            var step = Totp.Verify(secret, totp ?? "", DateTimeOffset.UtcNow, lastAcceptedStep: lastStep);

            // Ten sam kod 2FA nie moze zostac uzyty dwa razy
            if (!passwordOk || step is null || step.Value <= lastStep)
            {
                Audit.Write(c, tx, "admin-login-failed", null, ip);
                return null;
            }

            Database.Exec(c, "UPDATE admin SET totp_last_step = @s WHERE id = 1", tx, ("@s", step.Value));
            Audit.Write(c, tx, "admin-login", "admin", ip);
            return CreateSession(c, tx, ip);
        });

        if (outcome is null)
        {
            limiters.AdminLogin.Fail(ip);
            return (LoginError.Invalid, null, TimeSpan.Zero);
        }

        limiters.AdminLogin.Succeed(ip);
        return (LoginError.None, outcome, TimeSpan.Zero);
    }

    public bool ValidateSession(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200) return false;
        return db.Read(c => Database.Scalar(c, "SELECT 1 FROM admin_sessions WHERE token_hash = @h AND expires_at > @now", null,
            ("@h", Secrets.TokenHash(token)), ("@now", Database.NowMs())) is not null);
    }

    public Task LogoutAsync(string? token, string ip) => db.WriteAsync((c, tx) =>
    {
        if (!string.IsNullOrEmpty(token))
            Database.Exec(c, "DELETE FROM admin_sessions WHERE token_hash = @h", tx, ("@h", Secrets.TokenHash(token)));
        Audit.Write(c, tx, "admin-logout", "admin", ip);
    });

    public async Task<bool> ChangePasswordAsync(string current, string totp, string next, string ip)
    {
        if ((next ?? "").Length < MinPasswordLength) return false;
        if (limiters.AdminLogin.IsLocked(ip, out _)) return false;

        var ok = await db.WriteAsync((c, tx) =>
        {
            using var cmd = Database.Command(c, "SELECT password_hash, totp_secret, totp_last_step FROM admin WHERE id = 1", tx);
            using var r = cmd.ExecuteReader();
            r.Read();
            var (hash, secret, lastStep) = (r.GetString(0), r.GetString(1), r.GetInt64(2));
            r.Close();

            var step = Totp.Verify(secret, totp ?? "", DateTimeOffset.UtcNow, lastAcceptedStep: lastStep);
            if (!Secrets.VerifyPassword(current ?? "", hash) || step is null || step.Value <= lastStep) return false;

            Database.Exec(c, "UPDATE admin SET password_hash = @h, totp_last_step = @s WHERE id = 1", tx,
                ("@h", Secrets.HashPassword(next!)), ("@s", step.Value));
            // Zmiana hasla wylogowuje wszystkie sesje
            Database.Exec(c, "DELETE FROM admin_sessions", tx);
            Audit.Write(c, tx, "admin-password-changed", "admin", ip);
            return true;
        });

        if (!ok) limiters.AdminLogin.Fail(ip);
        return ok;
    }

    /// <summary>
    /// Awaryjne odzyskanie dostepu (zgubiony telefon z 2FA). Wymaga dostepu
    /// do kontenera, wiec nie da sie go wywolac przez siec:
    ///   docker exec frogsync dotnet FrogSync.Server.dll --reset-admin
    /// Zakladki, profile i urzadzenia zostaja nietkniete.
    /// </summary>
    public static void ResetAdmin(Database db)
    {
        using var c = db.Open();
        using var tx = c.BeginTransaction();
        Database.Exec(c, "DELETE FROM admin", tx);
        Database.Exec(c, "DELETE FROM admin_sessions", tx);
        Audit.Write(c, tx, "admin-reset", "konsola", null);
        tx.Commit();
    }

    private static string CreateSession(Microsoft.Data.Sqlite.SqliteConnection c, Microsoft.Data.Sqlite.SqliteTransaction tx, string ip)
    {
        var token = Secrets.NewToken();
        var now = Database.NowMs();
        Database.Exec(c, "DELETE FROM admin_sessions WHERE expires_at < @now", tx, ("@now", now));
        Database.Exec(c, "INSERT INTO admin_sessions(token_hash, created_at, expires_at, ip) VALUES (@h, @now, @exp, @ip)", tx,
            ("@h", Secrets.TokenHash(token)), ("@now", now), ("@exp", now + (long)SessionLifetime.TotalMilliseconds), ("@ip", ip));
        return token;
    }

    private static string Normalize(string? code) => (code ?? "").Trim().ToUpperInvariant();

    // ============================================================
    // Profile i urzadzenia
    // ============================================================

    public object State() => db.Read(c =>
    {
        var profiles = new List<object>();
        using (var cmd = Database.Command(c, """
            SELECT p.id, p.name, p.created_at,
                   (SELECT COUNT(*) FROM nodes n WHERE n.profile_id = p.id AND n.deleted = 0 AND n.kind = 'bookmark'),
                   (SELECT COALESCE(MAX(seq), 0) FROM nodes n WHERE n.profile_id = p.id)
            FROM profiles p ORDER BY p.name
            """, null))
        using (var r = cmd.ExecuteReader())
            while (r.Read())
                profiles.Add(new { id = r.GetString(0), name = r.GetString(1), createdAt = r.GetInt64(2), bookmarks = r.GetInt64(3), head = r.GetInt64(4) });

        var devices = new List<object>();
        using (var cmd = Database.Command(c, """
            SELECT d.id, d.name, d.browser, d.profile_id, d.created_at, d.last_seen_at, d.last_ip, d.cursor, d.revoked_at,
                   (SELECT COALESCE(MAX(seq), 0) FROM nodes n WHERE n.profile_id = d.profile_id)
            FROM devices d ORDER BY d.revoked_at IS NOT NULL, d.name
            """, null))
        using (var r = cmd.ExecuteReader())
            while (r.Read())
                devices.Add(new
                {
                    id = r.GetString(0), name = r.GetString(1), browser = r.GetString(2), profileId = r.GetString(3),
                    createdAt = r.GetInt64(4), lastSeenAt = r.IsDBNull(5) ? (long?)null : r.GetInt64(5),
                    lastIp = r.IsDBNull(6) ? null : r.GetString(6),
                    behind = Math.Max(0, r.GetInt64(9) - r.GetInt64(7)),
                    revokedAt = r.IsDBNull(8) ? (long?)null : r.GetInt64(8),
                });

        return new { profiles, devices };
    });

    public Task<string> CreateProfileAsync(string name, string ip)
    {
        var trimmed = (name ?? "").Trim();
        if (trimmed.Length is 0 or > 100) throw new ArgumentException("Nazwa profilu: 1-100 znakow");

        return db.WriteAsync((c, tx) =>
        {
            if (Database.Scalar(c, "SELECT 1 FROM profiles WHERE name = @n", tx, ("@n", trimmed)) is not null)
                throw new ArgumentException("Profil o tej nazwie juz istnieje");

            var id = Guid.NewGuid().ToString();
            Database.Exec(c, "INSERT INTO profiles(id, name, created_at) VALUES (@id, @n, @now)", tx,
                ("@id", id), ("@n", trimmed), ("@now", Database.NowMs()));
            SyncService.CreateRoots(c, tx, id);
            Audit.Write(c, tx, "profile-created", "admin", ip, trimmed);
            return id;
        });
    }

    public Task RenameProfileAsync(string id, string name, string ip)
    {
        var trimmed = (name ?? "").Trim();
        if (trimmed.Length is 0 or > 100) throw new ArgumentException("Nazwa profilu: 1-100 znakow");
        return db.WriteAsync((c, tx) =>
        {
            if (Database.Exec(c, "UPDATE profiles SET name = @n WHERE id = @id", tx, ("@n", trimmed), ("@id", id)) == 0)
                throw new ArgumentException("Nie ma takiego profilu");
            Audit.Write(c, tx, "profile-renamed", "admin", ip, trimmed);
        });
    }

    public Task RevokeDeviceAsync(string id, string ip) => db.WriteAsync((c, tx) =>
    {
        var name = Database.Scalar(c, "SELECT name FROM devices WHERE id = @id", tx, ("@id", id)) as string
                   ?? throw new ArgumentException("Nie ma takiego urzadzenia");
        Database.Exec(c, "UPDATE devices SET revoked_at = @now WHERE id = @id AND revoked_at IS NULL", tx,
            ("@now", Database.NowMs()), ("@id", id));
        Audit.Write(c, tx, "device-revoked", "admin", ip, name);
    });

    public Task RenameDeviceAsync(string id, string name, string ip)
    {
        var trimmed = (name ?? "").Trim();
        if (trimmed.Length is 0 or > 100) throw new ArgumentException("Nazwa urzadzenia: 1-100 znakow");
        return db.WriteAsync((c, tx) =>
        {
            if (Database.Exec(c, "UPDATE devices SET name = @n WHERE id = @id", tx, ("@n", trimmed), ("@id", id)) == 0)
                throw new ArgumentException("Nie ma takiego urzadzenia");
            Audit.Write(c, tx, "device-renamed", "admin", ip, trimmed);
        });
    }
}
