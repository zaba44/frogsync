using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FrogSync.Server.Infrastructure;

/// <summary>Wersje wydan rozszerzenia. Protokol API jest odrebna wielkoscia.</summary>
public static class ExtensionVersions
{
    public const string Header = "X-FrogSync-Version";
    public const string DownloadUrl = "https://github.com/zaba44/frogsync/releases/latest";
    public const string UpdateMessage =
        "Serwer wymaga nowszej wersji wtyczki — zaktualizuj FrogSync.";

    public static string BuiltInVersion { get; } = ReadBuiltInVersion();

    public static bool IsValid(string? text) =>
        text is not null && text.Length <= 17 &&
        Regex.IsMatch(text, @"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z",
            RegexOptions.CultureInvariant) &&
        text.Split('.').All(part => int.TryParse(part, out var value) && value <= 65535);

    public static int Compare(string a, string b)
    {
        if (!IsValid(a) || !IsValid(b))
            throw new ArgumentException("Wersja musi miec postac X.Y.Z.");
        return Version.Parse(a).CompareTo(Version.Parse(b));
    }

    public static bool IsTooOld(string? version, string minimum) =>
        minimum.Length > 0 && (!IsValid(version) || Compare(version!, minimum) < 0);

    public static string Status(string? version, string minimum, string latest)
    {
        if (IsTooOld(version, minimum)) return "incompatible";
        if (!IsValid(version)) return "unknown";
        return latest.Length > 0 && Compare(version!, latest) < 0 ? "update" : "current";
    }

    public static void Validate(AppConfig config)
    {
        foreach (var value in new[] { config.MinExtensionVersion, config.LatestExtensionVersion })
            if (value.Length > 0 && !IsValid(value))
                throw new ArgumentException("Wersja rozszerzenia w konfiguracji musi miec postac X.Y.Z.");
    }

    private static string ReadBuiltInVersion()
    {
        using var stream = typeof(ExtensionVersions).Assembly
            .GetManifestResourceStream("FrogSync.Release.json")
            ?? throw new InvalidOperationException("Brak wbudowanej informacji o wydaniu FrogSync.");
        using var json = JsonDocument.Parse(stream);
        var version = json.RootElement.GetProperty("version").GetString();
        return IsValid(version) ? version! :
            throw new InvalidOperationException("Nieprawidlowa wersja w extension/package.json.");
    }
}
