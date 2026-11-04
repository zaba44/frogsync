using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text;

namespace FrogSync.Server;

public static class OrderKey
{
    public const string Alphabet =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    private static readonly BigInteger[] Bands = BuildBands();
    private static readonly BigInteger Minimum = -Bands[26];
    private static readonly BigInteger Maximum = Bands[26] - 1;

    private readonly record struct Parts(
        BigInteger Integer,
        string Prefix,
        string Fraction);

    // Format klasyczny: A-Z/a-z okresla dlugosc czesci calkowitej.
    // Ulamek nie konczy sie '0': a0 jest poprawne, a0V0 nie.
    // Porownywanie ordinalne; w SQLite COLLATE BINARY.
    public static string Between(string? a, string? b)
    {
        if (a is not null &&
            b is not null &&
            string.CompareOrdinal(a, b) >= 0)
        {
            throw new ArgumentException(
                "Dolna granica musi byc mniejsza od gornej.");
        }

        Parts? left = a is null ? null : Parse(a);
        Parts? right = b is null ? null : Parse(b);

        if (left is null && right is null)
            return "a0";

        if (left is null)
        {
            var r = right!.Value;

            if (r.Fraction.Length > 0)
            {
                return r.Integer == Minimum
                    ? r.Prefix + FractionBetween("", r.Fraction)
                    : r.Prefix;
            }

            var previous = r.Integer - 1;

            return EncodeInteger(previous)
                + (previous == Minimum ? "V" : "");
        }

        if (right is null)
        {
            var l = left.Value;

            return l.Integer < Maximum
                ? EncodeInteger(l.Integer + 1)
                : l.Prefix + FractionBetween(l.Fraction, null);
        }

        var lo = left.Value;
        var hi = right.Value;

        if (lo.Integer == hi.Integer)
            return lo.Prefix + FractionBetween(lo.Fraction, hi.Fraction);

        if (hi.Integer - lo.Integer > 1)
            return EncodeInteger(lo.Integer + 1);

        if (hi.Fraction.Length > 0)
            return hi.Prefix;

        return lo.Prefix + FractionBetween(lo.Fraction, null);
    }

    // Rowny rozstaw w jednym pasmie; dlugosc O(log62(n)).
    // Caly wynik przypisujemy do folderu w jednej transakcji.
    public static string[] Rebalance(int n)
    {
        if (n < 0)
            throw new ArgumentOutOfRangeException(nameof(n));

        if (n == 0)
            return Array.Empty<string>();

        var capacity = new BigInteger(62);
        var width = 1;

        while (capacity <= n)
        {
            capacity *= 62;
            width++;
        }

        var result = new string[n];

        for (var i = 0; i < n; i++)
        {
            var value =
                ((BigInteger)i + 1) * capacity / ((BigInteger)n + 1);

            result[i] =
                ((char)('a' + width - 1)).ToString()
                + EncodeDigits(value, width);
        }

        return result;
    }

    private static Parts Parse(string key)
    {
        if (key.Length == 0)
            throw new ArgumentException("Pusty klucz.", nameof(key));

        var head = key[0];
        var negative = head is >= 'A' and <= 'Z';

        var width = negative
            ? 'Z' - head + 1
            : head is >= 'a' and <= 'z'
                ? head - 'a' + 1
                : 0;

        if (width == 0 || key.Length < width + 1)
        {
            throw new ArgumentException(
                "Niepoprawny naglowek lub dlugosc klucza.",
                nameof(key));
        }

        BigInteger value = 0;

        for (var i = 1; i < key.Length; i++)
        {
            var digit = Alphabet.IndexOf(key[i]);

            if (digit < 0)
            {
                throw new ArgumentException(
                    "Znak spoza base62.",
                    nameof(key));
            }

            if (i <= width)
                value = value * 62 + digit;
        }

        var fraction = key[(width + 1)..];

        if (fraction.EndsWith('0'))
        {
            throw new ArgumentException(
                "Ulamek nie moze konczyc sie zerem.",
                nameof(key));
        }

        var integer = negative
            ? value - Bands[width]
            : value + Bands[width - 1];

        if (integer == Minimum && fraction.Length == 0)
        {
            throw new ArgumentException(
                "Najmniejsza wartosc jest zarezerwowana.",
                nameof(key));
        }

        return new Parts(integer, key[..(width + 1)], fraction);
    }

    private static string EncodeInteger(BigInteger value)
    {
        if (value < Minimum || value > Maximum)
            throw new ArgumentOutOfRangeException(nameof(value));

        var width = 1;

        if (value.Sign >= 0)
        {
            while (value >= Bands[width])
                width++;

            return ((char)('a' + width - 1)).ToString()
                + EncodeDigits(value - Bands[width - 1], width);
        }

        while (value < -Bands[width])
            width++;

        return ((char)('Z' - width + 1)).ToString()
            + EncodeDigits(value + Bands[width], width);
    }

    private static string EncodeDigits(BigInteger value, int width)
    {
        var chars = new char[width];

        for (var i = width - 1; i >= 0; i--)
        {
            value = BigInteger.DivRem(value, 62, out var remainder);
            chars[i] = Alphabet[(int)remainder];
        }

        return new string(chars);
    }

    // Bez rekurencji: dlugie prefiksy nie zuzywaja stosu.
    private static string FractionBetween(string a, string? b)
    {
        var result = new StringBuilder();
        var upperOpen = b is null;

        for (var i = 0; ; i++)
        {
            var low = i < a.Length ? Alphabet.IndexOf(a[i]) : 0;

            if (!upperOpen && i >= b!.Length)
            {
                throw new ArgumentException(
                    "Brak miejsca pomiedzy granicami.");
            }

            var high = upperOpen ? 62 : Alphabet.IndexOf(b![i]);

            if (low == high)
            {
                result.Append(Alphabet[low]);
                continue;
            }

            if (high - low > 1)
            {
                return result
                    .Append(Alphabet[(low + high) / 2])
                    .ToString();
            }

            result.Append(Alphabet[low]);
            upperOpen = true;
        }
    }

    private static BigInteger[] BuildBands()
    {
        var result = new BigInteger[27];
        BigInteger power = 1;

        for (var i = 1; i < result.Length; i++)
        {
            power *= 62;
            result[i] = result[i - 1] + power;
        }

        return result;
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
            catch (ArgumentException)
            {
            }
        }

        try
        {
            Check(Between(null, null) == "a0", "Poczatek.");
            Check(Between(null, "a0") == "Zz", "Przed a0.");
            Check(Between("a0", null) == "a1", "Po a0.");
            Check(
                Between("a0", "a1") == "a0V",
                "Pomiedzy sasiadami.");

            Reject(
                () => Between("a1", "a0"),
                "Odwrocone granice.");

            Reject(
                () => Between("a0", "a0"),
                "Rowne granice.");

            foreach (var bad in new[] { "", "a0V0", "a0!", "b0", "0" })
            {
                Reject(
                    () => Between(bad, null),
                    "Zly klucz: " + bad);
            }

            Reject(() => Rebalance(-1), "Ujemne n.");

            var minimum = "A" + new string('0', 26);

            Reject(
                () => Between(null, minimum),
                "Zarezerwowana granica.");

            var nearMin = Between(null, minimum + "1");

            Check(
                string.CompareOrdinal(nearMin, minimum + "1") < 0,
                "Dolny kraniec.");

            _ = Parse(nearMin);

            var maximum = new string('z', 27);

            Check(
                string.CompareOrdinal(
                    Between(maximum, null),
                    maximum) > 0,
                "Gorny kraniec.");

            foreach (var n in new[] { 0, 1, 61, 62, 10_000 })
            {
                var keys = Rebalance(n);

                Check(keys.Length == n, "Rebalance: liczba.");

                BigInteger? previousGap = null;

                for (var i = 0; i < n; i++)
                {
                    var item = Parse(keys[i]);

                    if (i == 0)
                        continue;

                    Check(
                        string.CompareOrdinal(keys[i - 1], keys[i]) < 0,
                        "Porzadek Rebalance.");

                    var gap =
                        item.Integer - Parse(keys[i - 1]).Integer;

                    if (previousGap.HasValue)
                    {
                        Check(
                            BigInteger.Abs(
                                gap - previousGap.Value) <= 1,
                            "Rozstaw Rebalance.");
                    }

                    previousGap = gap;
                }
            }

            var list = new List<string>();
            var random = new Random(6238);

            for (var i = 0; i < 10_000; i++)
            {
                var index = random.Next(list.Count + 1);

                var a = index == 0 ? null : list[index - 1];
                var b = index == list.Count ? null : list[index];

                var key = Between(a, b);

                Check(
                    a is null || string.CompareOrdinal(a, key) < 0,
                    "Losowanie: dolna granica.");

                Check(
                    b is null || string.CompareOrdinal(key, b) < 0,
                    "Losowanie: gorna granica.");

                _ = Parse(key);
                list.Insert(index, key);
            }

            for (var i = 1; i < list.Count; i++)
            {
                Check(
                    string.CompareOrdinal(list[i - 1], list[i]) < 0,
                    "Porzadek 10000 wstawien.");
            }

            var right = "a1";

            for (var i = 0; i < 2_000; i++)
                right = Between("a0", right);

            Check(
                string.CompareOrdinal("a0", right) < 0,
                "Dlugie prefiksy.");
        }
        catch (Exception ex)
        {
            errors.Add("Wyjatek: " + ex.Message);
        }

        return errors;
    }
}
