using System.Security.Cryptography;
using System.Text;

namespace FrogSync.Server.Security;

/// <summary>Hasla, tokeny i kody. Serwer nigdy nie przechowuje tokenu ani kodu wprost — tylko skrot.</summary>
public static class Secrets
{
    private const int Pbkdf2Iterations = 600_000;   // zalecenie OWASP dla PBKDF2-SHA256
    private const int SaltBytes = 16;
    private const int HashBytes = 32;

    public static string HashPassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Pbkdf2Iterations, HashAlgorithmName.SHA256, HashBytes);
        return $"pbkdf2-sha256${Pbkdf2Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool VerifyPassword(string password, string stored)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2-sha256" || !int.TryParse(parts[1], out var iterations)) return false;

        var salt = Convert.FromBase64String(parts[2]);
        var expected = Convert.FromBase64String(parts[3]);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    /// <summary>Token o wysokiej entropii (256 bitow) — do niego wystarczy zwykly SHA-256, bez rozciagania.</summary>
    public static string NewToken() => Base64Url(RandomNumberGenerator.GetBytes(32));

    public static string TokenHash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    /// <summary>Szesciocyfrowy kod parowania, losowany jednostajnie.</summary>
    public static string NewPairingCode() => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    /// <summary>Kod jednorazowy do pierwszej konfiguracji, wypisywany w logu kontenera.</summary>
    public static string NewSetupCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // bez 0/O i 1/I
        Span<char> chars = stackalloc char[9];
        for (var i = 0; i < chars.Length; i++)
            chars[i] = i == 4 ? '-' : alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
        return new string(chars);
    }

    public static bool ConstantTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    public static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
