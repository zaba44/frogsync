using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FrogSync.Server.Infrastructure;
using Microsoft.Data.Sqlite;

namespace FrogSync.Server.StartPage;

public sealed class StartPageService(Database db)
{
    public const int MaxJsonBytes = 64 * 1024;
    public const int MaxLogoBytes = 512 * 1024;
    public const int MaxBackgroundBytes = 2 * 1024 * 1024;

    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 16,
    };

    private sealed record ProfileRow(
        string Settings,
        long SettingsVersion,
        long LogoVersion,
        long BackgroundVersion);

    public StartPageSnapshot Get(string profileId) =>
        Read((c, tx) => Snapshot(c, tx, profileId));

    public StartPageAsset GetAsset(string profileId, bool background) =>
        Read((c, tx) =>
        {
            var prefix = background ? "background" : "logo";

            using var cmd = Database.Command(c,
                $"SELECT {prefix}_version, {prefix}, {prefix}_type FROM profiles WHERE id = @p",
                tx, ("@p", profileId));

            using var reader = cmd.ExecuteReader();

            if (!reader.Read())
                throw new KeyNotFoundException("Nie ma takiego profilu.");

            var version = reader.GetInt64(0);
            var bytes = reader.IsDBNull(1) ? null : (byte[])reader.GetValue(1);
            var type = reader.IsDBNull(2) ? null : reader.GetString(2);

            reader.Close();

            return new StartPageAsset(
                profileId, Generation(c, tx), version, bytes, type);
        });

    public StartPageFolders GetFolders(string profileId) =>
        Read((c, tx) =>
        {
            _ = Profile(c, tx, profileId);

            using var cmd = Database.Command(c, """
                SELECT id, parent_id, kind, title, order_key
                FROM nodes
                WHERE profile_id = @p AND deleted = 0
                  AND kind IN ('root', 'folder')
                ORDER BY parent_id COLLATE BINARY, order_key COLLATE BINARY, id COLLATE BINARY
                """, tx, ("@p", profileId));

            using var reader = cmd.ExecuteReader();
            var folders = new List<StartPageFolder>();

            while (reader.Read())
                folders.Add(new StartPageFolder(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.GetString(2), reader.GetString(3), reader.GetString(4)));

            reader.Close();

            return new StartPageFolders(profileId, Generation(c, tx), folders);
        });

    public Task<StartPageSnapshot> SaveAsync(
        string profileId, StartPageSave request, string? ip,
        CancellationToken ct = default)
    {
        ValidateStamp(request?.Generation, request?.SettingsVersion ?? -1);
        var document = StartPageDocuments.Normalize(request!.Configuration);

        return db.WriteAsync((c, tx) =>
        {
            var current = Snapshot(c, tx, profileId);
            CheckSettings(current, request.Generation, request.SettingsVersion);

            // Stary panel nie moze cicho usunac funkcji dodanych w v2.
            if (request.Configuration.Version == 1 &&
                (current.Configuration.Template != "classic" ||
                 current.Configuration.Blocks!.Any(b => b.Type != "folder")))
                throw new ArgumentException("Ten profil wymaga panelu obslugujacego dokument v2.");

            foreach (var block in document.Blocks!.Where(b => b.Type == "folder"))
            {
                var live = Database.Scalar(c, """
                    SELECT 1 FROM nodes
                    WHERE profile_id = @p AND id = @id
                      AND kind = 'folder' AND deleted = 0
                    """, tx, ("@p", profileId), ("@id", block.FolderId));

                // Niedostepna sekcja moze pozostac przy edycji innych ustawien.
                var retained = current.Configuration.Blocks!.Any(old =>
                    old.Type == "folder" && old.Id == block.Id &&
                    old.FolderId == block.FolderId);

                if (live is null && !retained)
                    throw new ArgumentException("Nowy blok folder musi wskazywac zywy folder tego profilu.");
            }

            WriteSettings(c, tx, profileId, current, document, "admin", ip);
            return Snapshot(c, tx, profileId);
        }, ct);
    }

    public Task<StartPageSnapshot> SaveCustomAsync(
        string profileId, string deviceId, StartPageCustomSave request,
        string? ip, CancellationToken ct = default)
    {
        ValidateStamp(request?.Generation, request?.SettingsVersion ?? -1);

        if (request?.Blocks is null ||
            request.Blocks.Any(b => b is null || b.Type != "custom"))
            throw new ArgumentException("Urzadzenie moze przeslac wylacznie bloki custom.");

        return db.WriteAsync((c, tx) =>
        {
            var current = Snapshot(c, tx, profileId);
            CheckSettings(current, request.Generation, request.SettingsVersion);

            var remaining = new Queue<StartPageBlock>(request.Blocks);
            var merged = new List<StartPageBlock>();

            // Zachowujemy kolejnosc i tresc blokow innych niz custom.
            // Custom zajmuja dotychczasowe miejsca; nadmiar trafia na koniec.
            foreach (var block in current.Configuration.Blocks!)
            {
                if (block.Type != "custom")
                    merged.Add(block);
                else if (remaining.TryDequeue(out var replacement))
                    merged.Add(replacement);
            }

            merged.AddRange(remaining);

            var document = StartPageDocuments.Normalize(current.Configuration with
            {
                Blocks = merged,
                Configured = true,
            });

            WriteSettings(c, tx, profileId, current, document, deviceId, ip);
            return Snapshot(c, tx, profileId);
        }, ct);
    }

    public Task<StartPageSnapshot> SaveAssetAsync(
        string profileId, string generation, long expectedVersion,
        byte[]? bytes, string? contentType, bool background, string? ip,
        CancellationToken ct = default)
    {
        ValidateStamp(generation, expectedVersion);

        if (bytes is not null)
        {
            var maximum = background ? MaxBackgroundBytes : MaxLogoBytes;

            if (bytes.Length > maximum)
                throw new ArgumentException("Obraz przekracza limit rozmiaru.");

            StartPageImage.Validate(bytes, contentType);
            bytes = bytes.ToArray();
        }

        return db.WriteAsync((c, tx) =>
        {
            var current = Snapshot(c, tx, profileId);
            var currentVersion = background ? current.BackgroundVersion : current.LogoVersion;

            if (generation != current.Generation || expectedVersion != currentVersion)
                throw new StartPageConflict(current);

            var prefix = background ? "background" : "logo";
            var exists = Database.Scalar(c,
                $"SELECT {prefix} IS NOT NULL FROM profiles WHERE id = @p",
                tx, ("@p", profileId));

            if (bytes is null && Convert.ToInt64(exists) == 0)
                return current;

            var next = checked(currentVersion + 1);

            Database.Exec(c, $"""
                UPDATE profiles
                SET {prefix} = @bytes, {prefix}_type = @type, {prefix}_version = @version
                WHERE id = @p
                """, tx,
                ("@bytes", bytes),
                ("@type", bytes is null ? null : contentType),
                ("@version", next),
                ("@p", profileId));

            var kind = "startpage-" + prefix + (bytes is null ? "-deleted" : "");

            Audit.Write(c, tx, kind, "admin", ip,
                $"profile={profileId}; {prefix}Version={next}");

            return Snapshot(c, tx, profileId);
        }, ct);
    }

    private static void WriteSettings(
        SqliteConnection c, SqliteTransaction tx,
        string profileId, StartPageSnapshot current,
        StartPageDocument document, string actor, string? ip)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(document, Json);

        if (bytes.Length > MaxJsonBytes)
            throw new ArgumentException("Konfiguracja przekracza 64 KB.");

        var next = checked(current.SettingsVersion + 1);

        Database.Exec(c, """
            UPDATE profiles
            SET settings = @settings, settings_version = @version
            WHERE id = @p
            """, tx,
            ("@settings", Encoding.UTF8.GetString(bytes)),
            ("@version", next), ("@p", profileId));

        Audit.Write(c, tx, "startpage-settings", actor, ip,
            $"profile={profileId}; settingsVersion={next}; format=2");
    }

    private static void ValidateStamp(string? generation, long version)
    {
        if (string.IsNullOrWhiteSpace(generation) || version < 0)
            throw new ArgumentException("Wymagane generation i nieujemna wersja.");
    }

    private static void CheckSettings(
        StartPageSnapshot current, string generation, long version)
    {
        if (generation != current.Generation || version != current.SettingsVersion)
            throw new StartPageConflict(current);
    }

    internal static string ETag<T>(T value) =>
        "\"" + Convert.ToHexString(
            SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, Json))) + "\"";

    private T Read<T>(Func<SqliteConnection, SqliteTransaction, T> work) =>
        db.Read(c =>
        {
            using var tx = c.BeginTransaction(deferred: true);
            var result = work(c, tx);
            tx.Commit();
            return result;
        });

    private static string Generation(SqliteConnection c, SqliteTransaction tx) =>
        (string)Database.Scalar(c,
            "SELECT value FROM meta WHERE key = 'generation'", tx)!;

    private static ProfileRow Profile(
        SqliteConnection c, SqliteTransaction tx, string profileId)
    {
        using var cmd = Database.Command(c, """
            SELECT settings, settings_version, logo_version, background_version
            FROM profiles WHERE id = @p
            """, tx, ("@p", profileId));

        using var reader = cmd.ExecuteReader();

        if (!reader.Read())
            throw new KeyNotFoundException("Nie ma takiego profilu.");

        return new ProfileRow(
            reader.GetString(0), reader.GetInt64(1),
            reader.GetInt64(2), reader.GetInt64(3));
    }

    private static StartPageSnapshot Snapshot(
        SqliteConnection c, SqliteTransaction tx, string profileId)
    {
        var row = Profile(c, tx, profileId);
        var document = StartPageDocuments.Read(row.Settings);

        var blocks = document.Blocks!.Select(block =>
        {
            if (block.Type != "folder")
                return block;

            var title = Database.Scalar(c, """
                SELECT title FROM nodes
                WHERE profile_id = @p AND id = @id
                  AND kind = 'folder' AND deleted = 0
                """, tx, ("@p", profileId), ("@id", block.FolderId)) as string;

            return block with { Available = title is not null, FolderTitle = title };
        }).ToList();

        return new StartPageSnapshot(
            profileId, Generation(c, tx), row.SettingsVersion,
            row.LogoVersion, row.BackgroundVersion,
            document with { Blocks = blocks });
    }
}
