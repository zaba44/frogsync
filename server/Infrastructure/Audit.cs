using Microsoft.Data.Sqlite;

namespace FrogSync.Server.Infrastructure;

/// <summary>Dziennik zdarzen bezpieczenstwa: parowania, odwolania, logowania, zmiany konfiguracji.</summary>
public sealed class Audit(Database db, ILogger<Audit> logger)
{
    public const int RetentionDays = 365;

    public Task WriteAsync(string kind, string? actor, string? ip, string? detail = null)
    {
        logger.LogInformation("audit {Kind} actor={Actor} ip={Ip} {Detail}", kind, actor, ip, detail);
        return db.WriteAsync((c, tx) => Write(c, tx, kind, actor, ip, detail));
    }

    /// <summary>Zapis w ramach trwajacej transakcji — zdarzenie i zmiana commituja sie razem albo wcale.</summary>
    public static void Write(SqliteConnection c, SqliteTransaction tx, string kind, string? actor, string? ip, string? detail = null)
    {
        Database.Exec(c, "INSERT INTO audit(at, kind, actor, ip, detail) VALUES (@at, @k, @a, @ip, @d)", tx,
            ("@at", Database.NowMs()), ("@k", kind), ("@a", actor), ("@ip", ip), ("@d", detail));
    }

    public List<AuditEntry> Recent(int limit) => db.Read(c =>
    {
        using var cmd = Database.Command(c, "SELECT at, kind, actor, ip, detail FROM audit ORDER BY id DESC LIMIT @n", null,
            ("@n", Math.Clamp(limit, 1, 1000)));
        using var r = cmd.ExecuteReader();
        var list = new List<AuditEntry>();
        while (r.Read())
            list.Add(new AuditEntry(r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2),
                r.IsDBNull(3) ? null : r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4)));
        return list;
    });

    public Task PruneAsync() => db.WriteAsync((c, tx) =>
        Database.Exec(c, "DELETE FROM audit WHERE at < @cut", tx,
            ("@cut", Database.NowMs() - (long)RetentionDays * 86_400_000)));
}

public sealed record AuditEntry(long At, string Kind, string? Actor, string? Ip, string? Detail);
