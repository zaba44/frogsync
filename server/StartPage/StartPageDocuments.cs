using System.Text.Json;
using System.Text.RegularExpressions;

namespace FrogSync.Server.StartPage;

internal static class StartPageDocuments
{
    private static readonly Regex IdPattern = new(
        @"\A[A-Za-z0-9_-]{1,64}\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private static readonly Regex ColorPattern = new(
        @"\A#[0-9A-Fa-f]{6}\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public static StartPageDocument Empty() => new()
    {
        Version = 2,
        Blocks = [],
        Engines = [],
        Template = "classic",
        Configured = false,
    };

    public static StartPageDocument Read(string json)
    {
        using var parsed = JsonDocument.Parse(json);

        if (parsed.RootElement.ValueKind == JsonValueKind.Object &&
            !parsed.RootElement.EnumerateObject().Any())
            return Empty();

        var document = JsonSerializer.Deserialize<StartPageDocument>(
            json, StartPageService.Json)
            ?? throw new InvalidOperationException("Niepoprawne settings profilu.");

        // Konwersja dotyczy tylko odpowiedzi, bez zapisu i podbijania wersji.
        return Normalize(document);
    }

    public static StartPageDocument Normalize(StartPageDocument? input)
    {
        if (input?.Engines is null)
            throw new ArgumentException("Wymagana lista engines.");

        List<StartPageBlock> source;
        string template;

        if (input.Version == 1)
        {
            if (input.Sections is null || input.Blocks is not null ||
                input.Template is not null || input.Configured is not null)
                throw new ArgumentException("Niepoprawny dokument v1.");

            source = input.Sections.Select(s => s is null
                ? throw new ArgumentException("Pusta sekcja.")
                : new StartPageBlock
                {
                    Id = s.Id,
                    Type = "folder",
                    FolderId = s.FolderId,
                    Title = s.Title,
                }).ToList();

            template = "classic";
        }
        else if (input.Version == 2)
        {
            if (input.Sections is not null || input.Blocks is null ||
                input.Configured != true)
                throw new ArgumentException(
                    "Dokument v2 wymaga blocks, engines, template i configured=true.");

            source = input.Blocks;
            template = input.Template ?? "";

            if (template is not ("classic" or "compact" or "glass" or "live"))
                throw new ArgumentException("Nieznany szablon strony startowej.");
        }
        else
        {
            throw new ArgumentException("Obslugiwane wersje dokumentu: 1 i 2.");
        }

        if (source.Count > 64 || input.Engines.Count > 32)
            throw new ArgumentException("Maksymalnie 64 bloki i 32 wyszukiwarki.");

        var blocks = new List<StartPageBlock>();
        var blockIds = new HashSet<string>(StringComparer.Ordinal);
        var folderIds = new HashSet<string>(StringComparer.Ordinal);
        var tileIds = new HashSet<string>(StringComparer.Ordinal);
        var tileCount = 0;
        var topCount = 0;

        foreach (var block in source)
        {
            if (block is null || !ValidId(block.Id) || !blockIds.Add(block.Id))
                throw new ArgumentException("Niepoprawne lub powtorzone ID bloku.");

            var title = OptionalTitle(block.Title);

            switch (block.Type)
            {
                case "folder":
                    if (block.Tiles is not null ||
                        !Guid.TryParseExact(block.FolderId, "D", out var folder))
                        throw new ArgumentException("Blok folder wymaga GUID folderu.");

                    var folderId = folder.ToString("D");

                    if (!folderIds.Add(folderId))
                        throw new ArgumentException("Folder moze wystepowac tylko raz.");

                    blocks.Add(new StartPageBlock
                    {
                        Id = block.Id,
                        Type = "folder",
                        Title = title,
                        FolderId = folderId,
                    });
                    break;

                case "custom":
                    if (block.FolderId is not null || block.Tiles is null)
                        throw new ArgumentException("Blok custom wymaga tiles, bez folderId.");

                    tileCount += block.Tiles.Count;

                    if (tileCount > 200)
                        throw new ArgumentException(
                            "Maksymalnie 200 wlasnych kafelkow w calym profilu.");

                    var tiles = new List<StartPageTile>();

                    foreach (var tile in block.Tiles)
                    {
                        if (tile is null || !ValidId(tile.Id) || !tileIds.Add(tile.Id))
                            throw new ArgumentException(
                                "ID kafelkow musza byc unikalne w dokumencie.");

                        var tileTitle = tile.Title?.Trim();

                        if (tileTitle is null || !ValidText(tileTitle, 200))
                            throw new ArgumentException("Nazwa kafelka: 1-200 znakow.");

                        var url = tile.Url?.Trim();

                        if (!ValidHttpUrl(url))
                            throw new ArgumentException(
                                "Kafelek wymaga poprawnego adresu HTTP lub HTTPS bez hasla.");

                        var color = tile.Color?.Trim();

                        if (color is not null && !ColorPattern.IsMatch(color))
                            throw new ArgumentException("Kolor kafelka: #RRGGBB.");

                        tiles.Add(new StartPageTile(
                            tile.Id, tileTitle, url!, color?.ToUpperInvariant()));
                    }

                    blocks.Add(new StartPageBlock
                    {
                        Id = block.Id,
                        Type = "custom",
                        Title = title,
                        Tiles = tiles,
                    });
                    break;

                case "top":
                    if (block.FolderId is not null || block.Tiles is not null ||
                        ++topCount > 1)
                        throw new ArgumentException(
                            "Dozwolony jeden blok top, bez folderId i tiles.");

                    blocks.Add(new StartPageBlock
                    {
                        Id = block.Id,
                        Type = "top",
                        Title = title,
                    });
                    break;

                default:
                    throw new ArgumentException("Nieznany rodzaj bloku.");
            }
        }

        var engines = new List<StartPageEngine>();
        var engineIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var engine in input.Engines)
        {
            if (engine is null || !ValidId(engine.Id) || !engineIds.Add(engine.Id))
                throw new ArgumentException("Niepoprawne lub powtorzone ID wyszukiwarki.");

            var name = engine.Name?.Trim();
            var url = engine.Url?.Trim();
            var color = engine.Color?.Trim();

            if (name is null || !ValidText(name, 100))
                throw new ArgumentException("Nazwa wyszukiwarki: 1-100 znakow.");

            if (color is null || !ColorPattern.IsMatch(color))
                throw new ArgumentException("Kolor wyszukiwarki: #RRGGBB.");

            if (engine.Suggest is not ("google" or "none"))
                throw new ArgumentException("suggest: google albo none.");

            if (url is null || url.Length > 2048 ||
                url.Any(char.IsWhiteSpace) || url.Any(char.IsControl))
                throw new ArgumentException("Niepoprawny adres wyszukiwarki.");

            var marker = url.IndexOf("%s", StringComparison.Ordinal);

            if (marker < 0 ||
                url.IndexOf("%s", marker + 2, StringComparison.Ordinal) >= 0)
                throw new ArgumentException("Wymagany dokladnie jeden znacznik %s.");

            var probe = url.Replace("%s", "FrogSync", StringComparison.Ordinal);

            if (!ValidHttpUrl(probe) ||
                !Uri.TryCreate(probe, UriKind.Absolute, out var uri) ||
                uri.Scheme != Uri.UriSchemeHttps)
                throw new ArgumentException("Wyszukiwarka wymaga HTTPS.");

            var alternative = new Uri(
                url.Replace("%s", "AnotherQuery", StringComparison.Ordinal));

            if (!string.Equals(uri.Authority, alternative.Authority,
                    StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("%s musi znajdowac sie za nazwa hosta.");

            engines.Add(new StartPageEngine(
                engine.Id, name, url, color.ToUpperInvariant(), engine.Suggest));
        }

        return new StartPageDocument
        {
            Version = 2,
            Blocks = blocks,
            Engines = engines,
            Template = template,
            Configured = true,
        };
    }

    private static string? OptionalTitle(string? input)
    {
        var title = input?.Trim();

        if (string.IsNullOrEmpty(title))
            return null;

        if (!ValidText(title, 200))
            throw new ArgumentException("Nazwa bloku: maksymalnie 200 znakow.");

        return title;
    }

    private static bool ValidHttpUrl(string? url) =>
        url is not null && url.Length is > 0 and <= 2048 &&
        !url.Any(char.IsWhiteSpace) && !url.Any(char.IsControl) &&
        Uri.IsWellFormedUriString(url, UriKind.Absolute) &&
        Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme is "https" or "http" &&
        !string.IsNullOrEmpty(uri.Host) && string.IsNullOrEmpty(uri.UserInfo);

    private static bool ValidId(string? value) =>
        value is not null && IdPattern.IsMatch(value);

    private static bool ValidText(string value, int maximum) =>
        value.Length is > 0 && value.Length <= maximum && !value.Any(char.IsControl);
}
