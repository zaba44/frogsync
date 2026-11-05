namespace FrogSync.Server.Infrastructure;

/// <summary>
/// Konfiguracja z zmiennych srodowiskowych — w Dockerze to jedyny wygodny kanal.
/// Kazda wartosc ma bezpieczna wartosc domyslna: serwer uruchomiony bez czytania
/// instrukcji przyjmuje polaczenia tylko z sieci prywatnych i tylko po HTTPS.
/// </summary>
public sealed class AppConfig
{
    public required string DataDir { get; init; }
    public int Port { get; init; } = 8443;

    /// <summary>Plik PFX z certyfikatem. Brak pliku = certyfikat samopodpisany (z ostrzezeniem w logu).</summary>
    public required string CertPath { get; init; }
    public string? CertPassword { get; init; }

    /// <summary>
    /// Swiadome otwarcie na internet. Domyslnie false: serwer odrzuca kazde
    /// polaczenie spoza adresow prywatnych, loopback i VPN (100.64/10).
    /// </summary>
    public bool AllowPublic { get; init; }

    /// <summary>Dodatkowy katalog na kopie (np. folder Nextcloud). Kopie trafiaja tam PO zapisaniu lokalnym, poza obsluga zadan.</summary>
    public string? BackupExtraDir { get; init; }

    /// <summary>Puste minimum nie blokuje starszych wydan.</summary>
    public string MinExtensionVersion { get; init; } = "";

    /// <summary>Wersja rozszerzenia odpowiadajaca wydaniu serwera.</summary>
    public string LatestExtensionVersion { get; init; } = ExtensionVersions.BuiltInVersion;

    public int BackupKeep { get; init; } = 30;
    public TimeSpan BackupInterval { get; init; } = TimeSpan.FromHours(6);

    public string DatabasePath => Path.Combine(DataDir, "frogsync.db");
    public string BackupDir    => Path.Combine(DataDir, "backups");

    public static AppConfig FromEnvironment()
    {
        var data = Env("FROGSYNC_DATA") ?? (OperatingSystem.IsLinux() ? "/data" : Path.Combine(AppContext.BaseDirectory, "data"));

        return new AppConfig
        {
            DataDir        = data,
            Port           = int.TryParse(Env("FROGSYNC_PORT"), out var port) ? port : 8443,
            CertPath       = Env("FROGSYNC_CERT") ?? Path.Combine(data, "certs", "server.pfx"),
            CertPassword   = Env("FROGSYNC_CERT_PASSWORD"),
            AllowPublic    = IsTrue(Env("FROGSYNC_ALLOW_PUBLIC")),
            BackupExtraDir = Env("FROGSYNC_BACKUP_EXTRA"),
            MinExtensionVersion = Env("FROGSYNC_MIN_EXTENSION") ?? "",
            BackupKeep     = int.TryParse(Env("FROGSYNC_BACKUP_KEEP"), out var keep) && keep > 0 ? keep : 30,
        };
    }

    private static string? Env(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static bool IsTrue(string? value) =>
        value is not null && (value.Equals("true", StringComparison.OrdinalIgnoreCase) || value == "1" || value.Equals("yes", StringComparison.OrdinalIgnoreCase));
}
