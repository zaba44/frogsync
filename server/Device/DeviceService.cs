using FrogSync.Server.Infrastructure;
using FrogSync.Server.Security;

namespace FrogSync.Server.Device;

public sealed record DeviceIdentity(string DeviceId, string DeviceName, string ProfileId, string ProfileName);

public sealed record PairResult(string Token, string DeviceId, string ProfileId, string ProfileName);

/// <summary>
/// Urzadzenia i parowanie.
///
/// Parowanie: administrator generuje w panelu szesciocyfrowy kod, wtyczka go
/// wysyla i dostaje token. Kod jest jednorazowy i wazny 5 minut. Token jest
/// bezterminowy, ale odwolywalny w panelu; serwer trzyma tylko jego skrot.
///
/// Inaczej niz w Homepage token nigdy nie trafia do adresu strony, wiec nie
/// zostaje w historii, w ustawieniach innych dodatkow ani w kopii zakladek.
/// </summary>
public sealed class DeviceService(Database db, Limiters limiters)
{
    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(5);

    // Sprawdzenie blokady, proba i naliczenie bledu musza byc jedna niepodzielna
    // calosc — inaczej rownolegle zadania przechodza obok limitu.
    private readonly SemaphoreSlim _pairGate = new(1, 1);
    private const string GlobalPairingKey = "*";

    public async Task<(string Code, long ExpiresAt)> CreatePairingCodeAsync(string profileId, string deviceName, string? adminIp)
    {
        var name = (deviceName ?? "").Trim();
        if (name.Length is 0 or > 100) throw new ArgumentException("Nazwa urzadzenia: 1-100 znakow");

        return await db.WriteAsync((c, tx) =>
        {
            if (Database.Scalar(c, "SELECT 1 FROM profiles WHERE id = @p", tx, ("@p", profileId)) is null)
                throw new ArgumentException("Nie ma takiego profilu");

            // Wygasle kody sprzatamy przy okazji
            Database.Exec(c, "DELETE FROM pairing_codes WHERE expires_at < @now - 86400000", tx, ("@now", Database.NowMs()));

            // Kod musi byc unikalny wsrod aktywnych — przy milionie wartosci kolizja jest
            // malo prawdopodobna, ale tania do wykluczenia
            string code;
            var now = Database.NowMs();
            do code = Secrets.NewPairingCode();
            while (Database.Scalar(c, "SELECT 1 FROM pairing_codes WHERE code_hash = @h AND used_at IS NULL AND expires_at > @now", tx,
                       ("@h", Secrets.TokenHash(code)), ("@now", now)) is not null);

            var expires = now + (long)CodeLifetime.TotalMilliseconds;
            Database.Exec(c, """
                INSERT INTO pairing_codes(id, code_hash, profile_id, device_name, created_at, expires_at)
                VALUES (@id, @h, @p, @n, @now, @exp)
                """, tx, ("@id", Guid.NewGuid().ToString()), ("@h", Secrets.TokenHash(code)), ("@p", profileId),
                ("@n", name), ("@now", now), ("@exp", expires));

            Audit.Write(c, tx, "pairing-code-created", "admin", adminIp, $"profil {profileId}, urzadzenie \"{name}\"");
            return (code, expires);
        });
    }

    public enum PairOutcome { Ok, Invalid, Locked, ProfileChanged }
    public sealed record PairPreview(bool HasContent, int Bookmarks, string ProfileName, string PreviewId);
    public sealed record PairAttempt(PairOutcome Outcome, PairResult? Result, TimeSpan RetryAfter, PairPreview? Preview = null);

    public async Task<PairAttempt> PairAsync(string code, string browser, string ip, bool? expectContent = null, bool preview = false)
    {
        await _pairGate.WaitAsync();
        try { return await PairLockedAsync(code, browser, ip, expectContent, preview); }
        finally { _pairGate.Release(); }
    }

    private async Task<PairAttempt> PairLockedAsync(string code, string browser, string ip, bool? expectContent = null, bool preview = false)
    {
        if (limiters.PairingGlobal.IsLocked(GlobalPairingKey, out var globalWait)) return new(PairOutcome.Locked, null, globalWait);
        if (limiters.PairingPerIp.IsLocked(ip, out var ipWait)) return new(PairOutcome.Locked, null, ipWait);

        var normalized = new string((code ?? "").Where(char.IsDigit).ToArray());
        var result = normalized.Length != 6 ? null : await db.WriteAsync<PairAttempt?>((c, tx) =>
        {
            var now = Database.NowMs();
            using var cmd = Database.Command(c, """
                SELECT pc.id, pc.profile_id, pc.device_name, p.name
                FROM pairing_codes pc JOIN profiles p ON p.id = pc.profile_id
                WHERE pc.code_hash = @h AND pc.used_at IS NULL AND pc.expires_at > @now
                """, tx, ("@h", Secrets.TokenHash(normalized)), ("@now", now));
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return null;

            var (codeId, profileId, deviceName, profileName) = (r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3));
            r.Close();

            var hasContent = Database.Scalar(c,
                "SELECT 1 FROM nodes WHERE profile_id = @p AND deleted = 0 AND kind <> 'root' LIMIT 1",
                tx, ("@p", profileId)) is not null;
            if (preview || (expectContent.HasValue && expectContent.Value != hasContent))
            {
                var bookmarks = Convert.ToInt32(Database.Scalar(c,
                    "SELECT COUNT(*) FROM nodes WHERE profile_id = @p AND deleted = 0 AND kind = 'bookmark'", tx, ("@p", profileId)));
                var generation = Database.Scalar(c, "SELECT value FROM meta WHERE key = 'generation'", tx);
                return new PairAttempt(preview ? PairOutcome.Ok : PairOutcome.ProfileChanged, null, TimeSpan.Zero,
                    new(hasContent, bookmarks, profileName, Secrets.TokenHash($"{codeId}:{generation}:{hasContent}")));
            }

            var token = Secrets.NewToken();
            var deviceId = Guid.NewGuid().ToString();
            Database.Exec(c, """
                INSERT INTO devices(id, profile_id, name, browser, token_hash, created_at, last_seen_at, last_ip)
                VALUES (@id, @p, @n, @b, @h, @now, @now, @ip)
                """, tx, ("@id", deviceId), ("@p", profileId), ("@n", deviceName), ("@b", Truncate(browser, 100)),
                ("@h", Secrets.TokenHash(token)), ("@now", now), ("@ip", ip));
            Database.Exec(c, "UPDATE pairing_codes SET used_at = @now, device_id = @d WHERE id = @id", tx,
                ("@now", now), ("@d", deviceId), ("@id", codeId));

            Audit.Write(c, tx, "device-paired", deviceName, ip, $"profil \"{profileName}\", przegladarka {Truncate(browser, 100)}");
            return new PairAttempt(PairOutcome.Ok, new(token, deviceId, profileId, profileName), TimeSpan.Zero);
        });

        if (result is null)
        {
            limiters.PairingPerIp.Fail(ip);
            limiters.PairingGlobal.Fail(GlobalPairingKey);
            await db.WriteAsync((c, tx) => Audit.Write(c, tx, "pairing-failed", null, ip));
            return new(PairOutcome.Invalid, null, TimeSpan.Zero);
        }

        if (result.Result is not null) limiters.PairingPerIp.Succeed(ip);
        return result;
    }

    /// <summary>Uwierzytelnienie wtyczki po tokenie Bearer. Odwolane urzadzenie = brak dostepu.</summary>
    public DeviceIdentity? Authenticate(string? token, string ip)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200) return null;
        var hash = Secrets.TokenHash(token);

        var identity = db.Read(c =>
        {
            using var cmd = Database.Command(c, """
                SELECT d.id, d.name, d.profile_id, p.name, d.last_seen_at
                FROM devices d JOIN profiles p ON p.id = d.profile_id
                WHERE d.token_hash = @h AND d.revoked_at IS NULL
                """, null, ("@h", hash));
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return ((DeviceIdentity?)null, 0L);
            return (new DeviceIdentity(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3)), r.IsDBNull(4) ? 0L : r.GetInt64(4));
        });

        if (identity.Item1 is null) return null;

        // "Ostatnio widziane" odswiezamy najwyzej raz na minute — bez tego kazde
        // zapytanie wtyczki oznaczaloby zapis do bazy
        if (Database.NowMs() - identity.Item2 > 60_000)
        {
            var id = identity.Item1.DeviceId;
            _ = db.WriteAsync((c, tx) => Database.Exec(c, "UPDATE devices SET last_seen_at = @now, last_ip = @ip WHERE id = @id", tx,
                ("@now", Database.NowMs()), ("@ip", ip), ("@id", id)));
        }
        return identity.Item1;
    }

    public Task SaveCursorAsync(string deviceId, long cursor) => db.WriteAsync((c, tx) =>
        Database.Exec(c, "UPDATE devices SET cursor = MAX(cursor, @c) WHERE id = @id", tx, ("@c", cursor), ("@id", deviceId)));

    private static string Truncate(string? value, int max) =>
        string.IsNullOrEmpty(value) ? "" : value.Length <= max ? value : value[..max];
}
