using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using FrogSync.Server.Infrastructure;
using Microsoft.Data.Sqlite;

namespace FrogSync.Server.StartPage;

public sealed class StartPageService(Database db)
{
    public const int MaxJsonBytes = 64 * 1024;
    public const int MaxLogoBytes = 512 * 1024;
    public const int MaxSections = 64;
    public const int MaxEngines = 32;

    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 16,
    };

    private static readonly Regex SafeId = new(
        @"\A[A-Za-z0-9_-]{1,64}\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private static readonly Regex Color = new(
        @"\A#[0-9A-Fa-f]{6}\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private sealed record ProfileRow(
        string Settings,
        long SettingsVersion,
        long LogoVersion,
        byte[]? Logo,
        string? LogoType);

    public StartPageSnapshot Get(string profileId) =>
        Read((c, tx) => Snapshot(c, tx, profileId));

    public StartPageLogo GetLogo(string profileId) =>
        Read((c, tx) =>
        {
            var row = Profile(c, tx, profileId, includeLogo: true);
            return new StartPageLogo(
                profileId, Generation(c, tx), row.LogoVersion,
                row.Logo, row.LogoType);
        });

    public StartPageFolders GetFolders(string profileId) =>
        Read((c, tx) =>
        {
            _ = Profile(c, tx, profileId);

            using var cmd = Database.Command(c, """
                SELECT id, parent_id, kind, title, order_key
                FROM nodes
                WHERE profile_id = @p
                  AND deleted = 0
                  AND kind IN ('root', 'folder')
                ORDER BY parent_id COLLATE BINARY, order_key COLLATE BINARY, id COLLATE BINARY
                """, tx, ("@p", profileId));

            using var reader = cmd.ExecuteReader();
            var folders = new List<StartPageFolder>();

            while (reader.Read())
            {
                folders.Add(new StartPageFolder(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    reader.GetString(4)));
            }

            return new StartPageFolders(profileId, Generation(c, tx), folders);
        });

    public Task<StartPageSnapshot> SaveAsync(
        string profileId,
        StartPageSave request,
        string? ip,
        CancellationToken ct = default)
    {
        if (request is null ||
            request.SettingsVersion < 0 ||
            string.IsNullOrWhiteSpace(request.Generation))
            throw new ArgumentException("Wymagane generation i settingsVersion.");

        var document = Normalize(request.Configuration);
        var encoded = JsonSerializer.SerializeToUtf8Bytes(document, Json);

        if (encoded.Length > MaxJsonBytes)
            throw new ArgumentException("Konfiguracja przekracza 64 KB.");

        var settings = System.Text.Encoding.UTF8.GetString(encoded);

        return db.WriteAsync((c, tx) =>
        {
            var current = Snapshot(c, tx, profileId);

            if (request.Generation != current.Generation ||
                request.SettingsVersion != current.SettingsVersion)
                throw new StartPageConflict(current);

            foreach (var section in document.Sections)
            {
                var found = Database.Scalar(c, """
                    SELECT 1 FROM nodes
                    WHERE profile_id = @p AND id = @id
                      AND kind = 'folder' AND deleted = 0
                    """, tx, ("@p", profileId), ("@id", section.FolderId));

                if (found is null)
                    throw new ArgumentException(
                        "Kazda sekcja musi wskazywac zywy folder tego profilu.");
            }

            var next = checked(current.SettingsVersion + 1);

            Database.Exec(c, """
                UPDATE profiles
                SET settings = @settings, settings_version = @version
                WHERE id = @p
                """, tx,
                ("@settings", settings), ("@version", next), ("@p", profileId));

            Audit.Write(c, tx, "startpage-settings", "admin", ip,
                $"profile={profileId}; settingsVersion={next}");

            return Snapshot(c, tx, profileId);
        }, ct);
    }

    // bytes == null oznacza usuniecie logo.
    public Task<StartPageSnapshot> SaveLogoAsync(
        string profileId,
        string generation,
        long expectedVersion,
        byte[]? bytes,
        string? contentType,
        string? ip,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(generation) || expectedVersion < 0)
            throw new ArgumentException("Wymagane generation i logoVersion.");

        if (bytes is not null)
        {
            if (bytes.Length > MaxLogoBytes)
                throw new ArgumentException("Logo przekracza 512 KB.");

            StartPageImage.Validate(bytes, contentType);
            bytes = bytes.ToArray();
        }

        return db.WriteAsync((c, tx) =>
        {
            var current = Snapshot(c, tx, profileId);

            if (generation != current.Generation ||
                expectedVersion != current.LogoVersion)
                throw new StartPageConflict(current);

            var row = Profile(c, tx, profileId, includeLogo: true);

            // Ponowne usuniecie nieistniejacego logo nie tworzy nowej wersji.
            if (bytes is null && row.Logo is null)
                return current;

            var next = checked(current.LogoVersion + 1);

            Database.Exec(c, """
                UPDATE profiles
                SET logo = @logo, logo_type = @type, logo_version = @version
                WHERE id = @p
                """, tx,
                ("@logo", bytes),
                ("@type", bytes is null ? null : contentType),
                ("@version", next),
                ("@p", profileId));

            Audit.Write(c, tx,
                bytes is null ? "startpage-logo-deleted" : "startpage-logo",
                "admin", ip, $"profile={profileId}; logoVersion={next}");

            return Snapshot(c, tx, profileId);
        }, ct);
    }

    internal static string ETag<T>(T value) =>
        "\"" + Convert.ToHexString(
            SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, Json))) + "\"";

    private T Read<T>(Func<SqliteConnection, SqliteTransaction, T> work) =>
        db.Read(c =>
        {
            // Generacja, konfiguracja i dostepnosc folderow z jednego obrazu bazy.
            using var tx = c.BeginTransaction(deferred: true);
            var result = work(c, tx);
            tx.Commit();
            return result;
        });

    private static string Generation(SqliteConnection c, SqliteTransaction tx) =>
        (string)Database.Scalar(c,
            "SELECT value FROM meta WHERE key = 'generation'", tx)!;

    private static ProfileRow Profile(
        SqliteConnection c,
        SqliteTransaction tx,
        string profileId,
        bool includeLogo = false)
    {
        using var cmd = Database.Command(c,
            $"""
            SELECT settings, settings_version, logo_version,
                   {(includeLogo ? "logo" : "NULL")}, logo_type
            FROM profiles WHERE id = @p
            """, tx, ("@p", profileId));

        using var reader = cmd.ExecuteReader();

        if (!reader.Read())
            throw new KeyNotFoundException("Nie ma takiego profilu.");

        return new ProfileRow(
            reader.GetString(0),
            reader.GetInt64(1),
            reader.GetInt64(2),
            reader.IsDBNull(3) ? null : (byte[])reader.GetValue(3),
            reader.IsDBNull(4) ? null : reader.GetString(4));
    }

    private static StartPageSnapshot Snapshot(
        SqliteConnection c,
        SqliteTransaction tx,
        string profileId)
    {
        var row = Profile(c, tx, profileId);

        var document = row.Settings.Trim() == "{}"
            ? new StartPageDocument(1, [], [])
            : JsonSerializer.Deserialize<StartPageDocument>(row.Settings, Json)
              ?? throw new InvalidOperationException("Niepoprawna zapisana konfiguracja.");

        var sections = new List<StartPageSectionView>();

        foreach (var section in document.Sections)
        {
            var title = Database.Scalar(c, """
                SELECT title FROM nodes
                WHERE profile_id = @p AND id = @id
                  AND kind = 'folder' AND deleted = 0
                """, tx, ("@p", profileId), ("@id", section.FolderId)) as string;

            sections.Add(new StartPageSectionView(
                section.Id, section.FolderId, section.Title,
                title is not null, title));
        }

        return new StartPageSnapshot(
            profileId,
            Generation(c, tx),
            row.SettingsVersion,
            row.LogoVersion,
            new StartPageView(document.Version, sections, document.Engines));
    }

    private static StartPageDocument Normalize(StartPageDocument? input)
    {
        if (input is null || input.Version != 1 ||
            input.Sections is null || input.Engines is null)
            throw new ArgumentException("Wymagany dokument version=1 z sections i engines.");

        if (input.Sections.Count > MaxSections || input.Engines.Count > MaxEngines)
            throw new ArgumentException("Maksymalnie 64 sekcje i 32 wyszukiwarki.");

        var sections = new List<StartPageSection>();
        var engines = new List<StartPageEngine>();
        var sectionIds = new HashSet<string>(StringComparer.Ordinal);
        var folderIds = new HashSet<string>(StringComparer.Ordinal);
        var engineIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var section in input.Sections)
        {
            if (section is null || !ValidId(section.Id) ||
                !sectionIds.Add(section.Id) ||
                !Guid.TryParseExact(section.FolderId, "D", out var folder))
                throw new ArgumentException("Niepoprawne lub powtorzone ID sekcji/folderu.");

            var folderId = folder.ToString("D");

            if (!folderIds.Add(folderId))
                throw new ArgumentException("Folder moze wystepowac tylko w jednej sekcji.");

            var title = section.Title?.Trim();

            if (title == "")
                title = null;

            if (title is not null && !ValidText(title, 200))
                throw new ArgumentException("Nazwa sekcji: maksymalnie 200 znakow.");

            sections.Add(new StartPageSection(section.Id, folderId, title));
        }

        foreach (var engine in input.Engines)
        {
            if (engine is null || !ValidId(engine.Id) || !engineIds.Add(engine.Id))
                throw new ArgumentException("Niepoprawne lub powtorzone ID wyszukiwarki.");

            var name = engine.Name?.Trim();
            var url = engine.Url?.Trim();
            var color = engine.Color?.Trim();

            if (name is null || !ValidText(name, 100))
                throw new ArgumentException("Nazwa wyszukiwarki: 1-100 znakow.");

            if (color is null || !Color.IsMatch(color))
                throw new ArgumentException("Kolor wyszukiwarki musi miec postac #RRGGBB.");

            if (engine.Suggest is not ("google" or "none"))
                throw new ArgumentException("suggest musi miec wartosc google albo none.");

            if (url is null || url.Length > 2048 || url.Any(char.IsWhiteSpace) ||
                url.Any(char.IsControl))
                throw new ArgumentException("Niepoprawny adres wyszukiwarki.");

            var marker = url.IndexOf("%s", StringComparison.Ordinal);

            if (marker < 0 || url.IndexOf("%s", marker + 2, StringComparison.Ordinal) >= 0)
                throw new ArgumentException("Adres musi zawierac dokladnie jeden znacznik %s.");

            var probe = url.Replace("%s", "FrogSync", StringComparison.Ordinal);

            if (!Uri.IsWellFormedUriString(probe, UriKind.Absolute) ||
                !Uri.TryCreate(probe, UriKind.Absolute, out var uri) ||
                uri.Scheme != Uri.UriSchemeHttps ||
                string.IsNullOrEmpty(uri.Host) ||
                !string.IsNullOrEmpty(uri.UserInfo))
                throw new ArgumentException("Adres wyszukiwarki musi byc poprawnym HTTPS bez hasla.");

            // Zapytanie nie moze stac sie czescia nazwy hosta.
            var alternative = new Uri(url.Replace(
                "%s", "AnotherQuery", StringComparison.Ordinal));

            if (!string.Equals(uri.Authority, alternative.Authority,
                    StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Znacznik %s musi znajdowac sie za nazwa hosta.");

            engines.Add(new StartPageEngine(
                engine.Id, name, url, color.ToUpperInvariant(), engine.Suggest));
        }

        return new StartPageDocument(1, sections, engines);
    }

    private static bool ValidId(string? value) =>
        value is not null && SafeId.IsMatch(value);

    private static bool ValidText(string value, int maximum) =>
        value.Length is > 0 && value.Length <= maximum && !value.Any(char.IsControl);
}
