using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FrogSync.Server;

public static class Totp
{
    public const int PeriodSeconds = 30;

    private const string Base32Alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string GenerateSecret()
    {
        var bytes = RandomNumberGenerator.GetBytes(20);

        try
        {
            return EncodeBase32(bytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    // null oznacza niepoprawny lub juz uzyty kod.
    // Bez lastAcceptedStep metoda tylko sprawdza kod, np. podczas konfiguracji.
    // Po sukcesie wolajacy MUSI atomowo zapisac krok, jesli nadal jest wiekszy
    // od zapisanego w bazie; dopiero potem moze wystawic sesje.
    public static long? Verify(
        string secretBase32,
        string code,
        DateTimeOffset now,
        int window = 1,
        long lastAcceptedStep = -1)
    {
        if (window is < 0 or > 10)
            throw new ArgumentOutOfRangeException(nameof(window));

        if (lastAcceptedStep < -1)
            throw new ArgumentOutOfRangeException(nameof(lastAcceptedStep));

        if (code is null || code.Length != 6)
            return null;

        foreach (var c in code)
        {
            if (c is < '0' or > '9')
                return null;
        }

        var seconds = now.ToUnixTimeSeconds();

        if (seconds < 0)
            return null;

        var key = ReadSecret(secretBase32);

        try
        {
            var step = seconds / PeriodSeconds;
            var provided = Encoding.ASCII.GetBytes(code);

            long matched = -1;

            for (var delta = -window; delta <= window; delta++)
            {
                var candidate = step + delta;

                if (candidate < 0)
                    continue;

                var expected = Encoding.ASCII.GetBytes(
                    CodeForStep(key, candidate, 6));

                if (CryptographicOperations.FixedTimeEquals(
                    provided,
                    expected))
                {
                    matched = Math.Max(matched, candidate);
                }
            }

            return matched > lastAcceptedStep ? matched : null;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    public static string GetOtpAuthUri(
        string issuer,
        string account,
        string secret)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(issuer);
        ArgumentException.ThrowIfNullOrWhiteSpace(account);

        if (issuer.Contains(':') || account.Contains(':'))
        {
            throw new ArgumentException(
                "Issuer i account nie moga zawierac dwukropka.");
        }

        var key = ReadSecret(secret);

        try
        {
            var canonical = EncodeBase32(key);

            return "otpauth://totp/"
                + Uri.EscapeDataString(issuer)
                + ":"
                + Uri.EscapeDataString(account)
                + "?secret=" + canonical
                + "&issuer=" + Uri.EscapeDataString(issuer)
                + "&algorithm=SHA1&digits=6&period=30";
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    public static string EncodeBase32(ReadOnlySpan<byte> bytes)
    {
        var output = new StringBuilder();
        var buffer = 0;
        var bits = 0;

        foreach (var value in bytes)
        {
            buffer = (buffer << 8) | value;
            bits += 8;

            while (bits >= 5)
            {
                bits -= 5;
                output.Append(Base32Alphabet[(buffer >> bits) & 31]);
            }

            buffer &= (1 << bits) - 1;
        }

        if (bits > 0)
            output.Append(Base32Alphabet[(buffer << (5 - bits)) & 31]);

        return output.ToString();
    }

    // Przyjmuje duze/male litery, opcjonalny poprawny padding RFC 4648.
    // Odrzuca spacje, zly padding i niezerowe niewykorzystane bity.
    public static byte[] DecodeBase32(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var paddingAt = text.IndexOf('=');
        var length = paddingAt < 0 ? text.Length : paddingAt;
        var remainder = length % 8;

        if (remainder is not (0 or 2 or 4 or 5 or 7))
            throw new FormatException("Niepoprawna dlugosc Base32.");

        if (paddingAt >= 0)
        {
            var expected = (8 - remainder) % 8;

            if (expected == 0 ||
                text.Length % 8 != 0 ||
                text.Length - length != expected)
            {
                throw new FormatException("Niepoprawny padding Base32.");
            }

            for (var i = length; i < text.Length; i++)
            {
                if (text[i] != '=')
                    throw new FormatException("Znak po paddingu Base32.");
            }
        }

        var output = new byte[(int)((long)length * 5 / 8)];
        var buffer = 0;
        var bits = 0;
        var offset = 0;

        for (var i = 0; i < length; i++)
        {
            var c = text[i];

            if (c is >= 'a' and <= 'z')
                c = (char)(c - 'a' + 'A');

            var digit = Base32Alphabet.IndexOf(c);

            if (digit < 0)
                throw new FormatException("Znak spoza alfabetu Base32.");

            buffer = (buffer << 5) | digit;
            bits += 5;

            if (bits >= 8)
            {
                bits -= 8;
                output[offset++] = (byte)(buffer >> bits);
            }

            buffer &= (1 << bits) - 1;
        }

        if (buffer != 0)
            throw new FormatException("Niezerowe koncowe bity Base32.");

        return output;
    }

    private static byte[] ReadSecret(string secret)
    {
        var key = DecodeBase32(secret);

        if (key.Length >= 16)
            return key;

        CryptographicOperations.ZeroMemory(key);

        throw new ArgumentException(
            "Sekret TOTP musi miec co najmniej 128 bitow.",
            nameof(secret));
    }

    private static string CodeForStep(
        ReadOnlySpan<byte> key,
        long step,
        int digits)
    {
        Span<byte> counter = stackalloc byte[8];
        Span<byte> hash = stackalloc byte[20];

        BinaryPrimitives.WriteInt64BigEndian(counter, step);
        HMACSHA1.HashData(key, counter, hash);

        var offset = hash[19] & 15;

        var binary =
            BinaryPrimitives.ReadUInt32BigEndian(hash.Slice(offset, 4))
            & 0x7fffffffU;

        var number = binary
            % (digits == 8 ? 100_000_000U : 1_000_000U);

        CryptographicOperations.ZeroMemory(hash);

        return number.ToString(
            digits == 8 ? "D8" : "D6",
            CultureInfo.InvariantCulture);
    }

    public static List<string> SelfTest()
    {
        var errors = new List<string>();

        void Check(bool ok, string name)
        {
            if (!ok)
                errors.Add(name);
        }

        void Reject(Action action, string name)
        {
            try
            {
                action();
                errors.Add(name);
            }
            catch (Exception ex)
                when (ex is ArgumentException or FormatException)
            {
            }
        }

        try
        {
            var key = Encoding.ASCII.GetBytes("12345678901234567890");
            var secret = EncodeBase32(key);

            Check(
                secret == "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
                "Base32 sekretu RFC.");

            // Appendix B ma osiem cyfr; sprawdzamy tez szesc ostatnich cyfr.
            var vectors = new (long Time, string Eight, string Six)[]
            {
                (59, "94287082", "287082"),
                (1111111109, "07081804", "081804"),
                (1111111111, "14050471", "050471"),
                (1234567890, "89005924", "005924"),
                (2000000000, "69279037", "279037"),
                (20000000000, "65353130", "353130")
            };

            foreach (var v in vectors)
            {
                Check(
                    CodeForStep(key, v.Time / 30, 8) == v.Eight,
                    "RFC SHA1: " + v.Time);

                Check(
                    Verify(
                        secret,
                        v.Six,
                        DateTimeOffset.FromUnixTimeSeconds(v.Time),
                        0) == v.Time / 30,
                    "RFC szesc cyfr: " + v.Time);
            }

            var now =
                DateTimeOffset.FromUnixTimeSeconds(1234567890);

            var step = now.ToUnixTimeSeconds() / 30;
            var code = CodeForStep(key, step, 6);

            Check(
                Verify(
                    secret, code, now,
                    lastAcceptedStep: step) is null,
                "Replay.");

            Check(
                Verify(
                    secret, code, now,
                    lastAcceptedStep: step - 1) == step,
                "Nowy krok.");

            var previous = CodeForStep(key, step - 1, 6);
            var future = CodeForStep(key, step + 1, 6);

            Check(
                Verify(secret, previous, now) == step - 1,
                "Okno wstecz.");

            Check(
                Verify(secret, future, now) == step + 1,
                "Okno naprzod.");

            Check(
                Verify(secret, previous, now, 0) is null,
                "Bez okna.");

            Check(
                Verify(
                    secret, previous, now,
                    lastAcceptedStep: step) is null,
                "Starszy krok.");

            Check(
                Verify(
                    secret,
                    CodeForStep(key, step + 2, 6),
                    now) is null,
                "Poza oknem.");

            Check(
                Verify(
                    secret,
                    code,
                    DateTimeOffset.FromUnixTimeSeconds(-1)) is null,
                "Przed epoka.");

            foreach (var bad in new[]
            {
                "",
                "12345",
                "1234567",
                "12 345",
                "\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16"
            })
            {
                Check(
                    Verify(secret, bad, now) is null,
                    "Zly kod.");
            }

            Reject(
                () => Verify(secret, code, now, -1),
                "Ujemne okno.");

            Reject(
                () => Verify(secret, code, now, 11),
                "Za duze okno.");

            var base32 = new (string Plain, string Encoded)[]
            {
                ("", ""),
                ("f", "MY"),
                ("fo", "MZXQ"),
                ("foo", "MZXW6"),
                ("foob", "MZXW6YQ"),
                ("fooba", "MZXW6YTB"),
                ("foobar", "MZXW6YTBOI")
            };

            foreach (var v in base32)
            {
                Check(
                    EncodeBase32(
                        Encoding.ASCII.GetBytes(v.Plain)) == v.Encoded,
                    "Base32 encode.");

                Check(
                    Encoding.ASCII.GetString(
                        DecodeBase32(v.Encoded)) == v.Plain,
                    "Base32 decode.");
            }

            Check(
                Encoding.ASCII.GetString(
                    DecodeBase32("mzxw6ytboi======")) == "foobar",
                "Padding/litery.");

            foreach (var bad in new[]
            {
                "A",
                "AAA",
                "AAAAAA",
                "MY=",
                "MY=======",
                "M!",
                "MZ",
                "MY======A",
                "========"
            })
            {
                Reject(
                    () => DecodeBase32(bad),
                    "Niepoprawne Base32: " + bad);
            }

            var random = new Random(4648);

            for (var n = 0; n <= 128; n++)
            {
                var bytes = new byte[n];
                random.NextBytes(bytes);

                Check(
                    bytes.AsSpan().SequenceEqual(
                        DecodeBase32(EncodeBase32(bytes))),
                    "Base32 roundtrip.");
            }

            var generated = GenerateSecret();

            Check(
                generated.Length == 32 &&
                DecodeBase32(generated).Length == 20,
                "Dlugosc sekretu.");

            Check(
                generated != GenerateSecret(),
                "Losowosc sekretu.");

            var uri = GetOtpAuthUri(
                "Frog Sync",
                "a+b@example.com",
                secret.ToLowerInvariant());

            Check(
                uri.Contains(
                    "Frog%20Sync:a%2Bb%40example.com?secret=" + secret)
                && uri.Contains(
                    "&issuer=Frog%20Sync&algorithm=SHA1&digits=6&period=30"),
                "URI.");
        }
        catch (Exception ex)
        {
            errors.Add("Wyjatek: " + ex.Message);
        }

        return errors;
    }
}
