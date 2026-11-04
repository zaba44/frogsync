using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using FrogSync.Server.Infrastructure;

namespace FrogSync.Server.Security;

/// <summary>
/// Certyfikat HTTPS z podmiana w locie.
///
/// Serwer startuje z certyfikatem samopodpisanym, a wlasciwy — z wlasnego CA —
/// wgrywasz w panelu. Kestrel pyta ten magazyn o certyfikat przy kazdym nowym
/// polaczeniu, wiec nowy certyfikat dziala od razu, bez restartu kontenera.
///
/// Kolejnosc wczytywania przy starcie:
///   1. baza SQLite         — wgrany z panelu
///   2. FROGSYNC_CERT        — wskazany w konfiguracji (domyslnie certs/server.pfx)
///   3. certs/selfsigned.pfx — wygenerowany automatycznie
/// Trybu bez HTTPS nie ma w ogole.
/// </summary>
public sealed class CertificateStore
{
    private const string BlobKey = "tls-pkcs12";
    private readonly Database _db;
    private readonly AppConfig _config;
    private readonly ILogger _logger;
    private readonly Lock _lock = new();
    private X509Certificate2 _current;

    public CertificateStore(AppConfig config, Database db, ILogger logger)
    {
        _config = config;
        _logger = logger;
        _db = db;
        ImportLegacy();
        _current = LoadAtStartup(out var source);
        Source = source;
        LogInfo(_current, source);
    }

    private string UploadedPath   => Path.Combine(_config.DataDir, "certs", "uploaded.pfx");
    public string SelfSignedPath => Path.Combine(_config.DataDir, "certs", "selfsigned.pfx");

    /// <summary>uploaded | configured | selfsigned</summary>
    public string Source { get; private set; }

    public X509Certificate2 Current { get { lock (_lock) return _current; } }

    public CertificateInfo Info()
    {
        var cert = Current;
        return new CertificateInfo(
            Subject: cert.Subject,
            Issuer: cert.Issuer,
            Names: SubjectNames(cert),
            NotBefore: new DateTimeOffset(cert.NotBefore).ToUnixTimeMilliseconds(),
            NotAfter: new DateTimeOffset(cert.NotAfter).ToUnixTimeMilliseconds(),
            Fingerprint: cert.GetCertHashString(HashAlgorithmName.SHA256),
            SelfSigned: Source == "selfsigned",
            Source: Source);
    }

    // ============================================================
    // Wgrywanie z panelu
    // ============================================================

    /// <summary>Plik PFX/P12 (z haslem albo bez).</summary>
    public async Task<CertificateInfo> ReplaceFromPfx(byte[] pfx, string? password)
    {
        X509Certificate2 cert;
        try { cert = X509CertificateLoader.LoadPkcs12(pfx, string.IsNullOrEmpty(password) ? null : password, X509KeyStorageFlags.Exportable); }
        catch (CryptographicException)
        {
            throw new ArgumentException("Nie udalo sie otworzyc pliku PFX/P12 — bledne haslo albo uszkodzony plik.");
        }
        return await Replace(cert);
    }

    /// <summary>Certyfikat i klucz w formacie PEM (np. cert.crt + cert.key albo fullchain.pem + klucz).</summary>
    public async Task<CertificateInfo> ReplaceFromPem(string certPem, string keyPem)
    {
        X509Certificate2 cert;
        try
        {
            // Pierwszy blok to certyfikat serwera; ewentualne posrednie ignorujemy —
            // przy wlasnym CA klienci i tak ufaja jego certyfikatowi glownemu.
            using var fromPem = X509Certificate2.CreateFromPem(certPem, keyPem);
            // Na Windows klucz z PEM jest efemeryczny i Kestrel nie potrafi go uzyc —
            // eksport i ponowny import w PKCS#12 to standardowe obejscie.
            cert = X509CertificateLoader.LoadPkcs12(fromPem.Export(X509ContentType.Pkcs12), null, X509KeyStorageFlags.Exportable);
        }
        catch (CryptographicException ex)
        {
            throw new ArgumentException("Nie udalo sie odczytac certyfikatu i klucza PEM: " + ex.Message);
        }
        return await Replace(cert);
    }

    private async Task<CertificateInfo> Replace(X509Certificate2 cert)
    {
        using (cert)
        {
            Validate(cert);
            var pfx = cert.Export(X509ContentType.Pkcs12);
            await _db.WriteAsync((c, tx) => Database.Exec(c, """
                INSERT INTO blobs(key, value, updated_at) VALUES (@k, @v, @now)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """, tx, ("@k", BlobKey), ("@v", pfx), ("@now", Database.NowMs())));
        }
        Reload();
        return Info();
    }

    public async Task<CertificateInfo> ResetToSelfSigned()
    {
        await _db.WriteAsync((c, tx) => Database.Exec(c, "DELETE FROM blobs WHERE key = @k", tx, ("@k", BlobKey)));
        Reload();
        return Info();
    }

    private void ImportLegacy()
    {
        if (!TryLoad(UploadedPath, null, out var cert)) return;
        using (cert)
        {
            var pfx = cert!.Export(X509ContentType.Pkcs12);
            _db.WriteAsync((c, tx) => Database.Exec(c,
                "INSERT OR IGNORE INTO blobs(key, value, updated_at) VALUES (@k, @v, @now)",
                tx, ("@k", BlobKey), ("@v", pfx), ("@now", Database.NowMs()))).GetAwaiter().GetResult();
        }
        File.Delete(UploadedPath);
    }

    public void Reload()
    {
        lock (_lock)
        {
            _current = LoadAtStartup(out var source);
            Source = source;
            LogInfo(_current, source);
        }
    }

    private static void Validate(X509Certificate2 cert)
    {
        if (!cert.HasPrivateKey)
            throw new ArgumentException("Certyfikat nie zawiera klucza prywatnego. Wyeksportuj go razem z kluczem.");

        var now = DateTime.Now;
        if (cert.NotAfter < now) throw new ArgumentException($"Certyfikat wygasl {cert.NotAfter:yyyy-MM-dd}.");
        if (cert.NotBefore > now.AddDays(1)) throw new ArgumentException($"Certyfikat jest wazny dopiero od {cert.NotBefore:yyyy-MM-dd}.");

        foreach (var ext in cert.Extensions)
        {
            if (ext is X509EnhancedKeyUsageExtension eku &&
                !eku.EnhancedKeyUsages.Cast<Oid>().Any(o => o.Value == "1.3.6.1.5.5.7.3.1"))
                throw new ArgumentException("Certyfikat nie jest przeznaczony do uwierzytelniania serwera (brak Server Authentication).");
        }

        if (SubjectNames(cert).Count == 0)
            throw new ArgumentException("Certyfikat nie ma zadnej nazwy ani adresu IP w polu SAN — przegladarki go odrzuca.");
    }

    // ============================================================
    // Start
    // ============================================================

    private X509Certificate2 LoadAtStartup(out string source)
    {
        if (_db.Read(c => Database.Scalar(c, "SELECT value FROM blobs WHERE key = @k", null, ("@k", BlobKey))) is byte[] pfx)
        {
            try
            {
                var cert = X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.Exportable);
                if (cert.HasPrivateKey) { source = "uploaded"; return cert; }
                cert.Dispose();
            }
            catch (CryptographicException ex) { _logger.LogWarning(ex, "Nie mozna wczytac certyfikatu z bazy."); }
        }
        if (TryLoad(_config.CertPath, _config.CertPassword, out var configured)) { source = "configured"; return configured!; }
        source = "selfsigned";
        return LoadOrCreateSelfSigned();
    }

    private bool TryLoad(string path, string? password, out X509Certificate2? cert)
    {
        cert = null;
        if (!File.Exists(path)) return false;
        try
        {
            var loaded = X509CertificateLoader.LoadPkcs12FromFile(path, password, X509KeyStorageFlags.Exportable);
            if (!loaded.HasPrivateKey) throw new InvalidOperationException("brak klucza prywatnego");
            cert = loaded;
            return true;
        }
        catch (Exception ex)
        {
            // Zly plik nie moze unieruchomic serwera — wtedy nie daloby sie juz
            // wejsc do panelu, zeby go poprawic. Spadamy na nastepne zrodlo.
            _logger.LogError("Nie udalo sie wczytac certyfikatu {Path}: {Message}. Uzywam nastepnego zrodla.", path, ex.Message);
            return false;
        }
    }

    private X509Certificate2 LoadOrCreateSelfSigned()
    {
        if (TryLoad(SelfSignedPath, null, out var existing) && existing!.NotAfter > DateTime.Now.AddDays(7))
            return existing;

        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=FrogSync (samopodpisany)", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        // Wszystkie adresy tej maszyny w SAN — wtedy przegladarka zgloszy wylacznie
        // brak zaufania, a nie dodatkowo niezgodnosc nazwy.
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        san.AddDnsName(Environment.MachineName.ToLowerInvariant());
        foreach (var address in LocalAddresses()) san.AddIpAddress(address);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));

        using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(2));
        Directory.CreateDirectory(Path.GetDirectoryName(SelfSignedPath)!);
        File.WriteAllBytes(SelfSignedPath, created.Export(X509ContentType.Pkcs12));
        RestrictPermissions(SelfSignedPath);

        return X509CertificateLoader.LoadPkcs12FromFile(SelfSignedPath, null, X509KeyStorageFlags.Exportable);
    }

    private static IEnumerable<IPAddress> LocalAddresses()
    {
        var result = new HashSet<IPAddress> { IPAddress.Loopback };
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                foreach (var unicast in nic.GetIPProperties().UnicastAddresses)
                    if (unicast.Address.AddressFamily == AddressFamily.InterNetwork) result.Add(unicast.Address);
            }
        }
        catch { /* bez listy interfejsow zostaje loopback */ }
        return result;
    }

    // ============================================================

    public static List<string> SubjectNames(X509Certificate2 cert)
    {
        var names = new List<string>();
        foreach (var ext in cert.Extensions)
        {
            if (ext is not X509SubjectAlternativeNameExtension san) continue;
            names.AddRange(san.EnumerateDnsNames());
            names.AddRange(san.EnumerateIPAddresses().Select(ip => ip.ToString()));
        }
        return names;
    }

    private void LogInfo(X509Certificate2 cert, string source)
    {
        if (source == "selfsigned")
            _logger.LogWarning(
                "Uzywam certyfikatu SAMOPODPISANEGO (odcisk SHA-256 {Thumb}). Wgraj certyfikat z wlasnego CA w panelu: Certyfikat HTTPS.",
                cert.GetCertHashString(HashAlgorithmName.SHA256));
        else
            _logger.LogInformation("Certyfikat ({Source}): {Subject}, nazwy {Names}, wazny do {NotAfter:yyyy-MM-dd}",
                source == "uploaded" ? "wgrany z panelu" : "z konfiguracji", cert.Subject, string.Join(", ", SubjectNames(cert)), cert.NotAfter);

        if (source != "selfsigned" && cert.NotAfter < DateTime.Now.AddDays(30))
            _logger.LogWarning("Certyfikat wygasa {NotAfter:yyyy-MM-dd} — przygotuj nowy.", cert.NotAfter);
    }

    private static void RestrictPermissions(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}

public sealed record CertificateInfo(
    string Subject, string Issuer, List<string> Names,
    long NotBefore, long NotAfter, string Fingerprint, bool SelfSigned, string Source);
