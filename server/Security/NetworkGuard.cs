using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;

namespace FrogSync.Server;

public static class NetworkGuard
{
    // To klasyfikacja adresu, a nie dowod pochodzenia klienta za proxy/NAT.
    public static bool IsPrivate(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);

        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();

        var b = address.GetAddressBytes();

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            return b[0] == 127
                || b[0] == 10
                || (b[0] == 172 && (b[1] & 0xF0) == 16)
                || (b[0] == 192 && b[1] == 168)
                || (b[0] == 169 && b[1] == 254)
                || (b[0] == 100 && (b[1] & 0xC0) == 64);
        }

        if (address.AddressFamily != AddressFamily.InterNetworkV6)
            return false;

        var loopback = b[15] == 1;

        for (var i = 0; i < 15; i++)
            loopback &= b[i] == 0;

        return loopback
            || (b[0] & 0xFE) == 0xFC
            || (b[0] == 0xFE && (b[1] & 0xC0) == 0x80);
    }

    public static List<string> SelfTest()
    {
        var errors = new List<string>();

        var cases = new (string Address, bool Expected)[]
        {
            ("0.0.0.0", false),
            ("8.8.8.8", false),
            ("255.255.255.255", false),

            ("126.255.255.255", false),
            ("127.0.0.0", true),
            ("127.255.255.255", true),
            ("128.0.0.0", false),

            ("9.255.255.255", false),
            ("10.0.0.0", true),
            ("10.255.255.255", true),
            ("11.0.0.0", false),

            ("172.15.255.255", false),
            ("172.16.0.0", true),
            ("172.31.255.255", true),
            ("172.32.0.0", false),

            ("192.167.255.255", false),
            ("192.168.0.0", true),
            ("192.168.255.255", true),
            ("192.169.0.0", false),

            ("169.253.255.255", false),
            ("169.254.0.0", true),
            ("169.254.255.255", true),
            ("169.255.0.0", false),

            ("100.63.255.255", false),
            ("100.64.0.0", true),
            ("100.127.255.255", true),
            ("100.128.0.0", false),

            ("::", false),
            ("::1", true),
            ("::2", false),

            ("::ffff:127.0.0.1", true),
            ("::ffff:10.220.44.12", true),
            ("::ffff:172.17.0.1", true),
            ("::ffff:192.168.144.66", true),
            ("::ffff:169.254.1.2", true),
            ("::ffff:100.64.0.1", true),
            ("::ffff:8.8.8.8", false),
            ("::ffff:0.0.0.0", false),

            ("::192.168.1.1", false),
            ("2001:db8::1", false),

            ("fbff:ffff::1", false),
            ("fc00::", true),
            ("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("fd12:3456::1%7", true),
            ("fe00::", false),

            ("fe7f:ffff::1", false),
            ("fe80::", true),
            ("fe80::1%3", true),
            ("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("fec0::", false),
            ("ff02::1", false)
        };

        foreach (var item in cases)
        {
            try
            {
                if (IsPrivate(IPAddress.Parse(item.Address))
                    != item.Expected)
                {
                    errors.Add(
                        "Bledna klasyfikacja: " + item.Address);
                }
            }
            catch (Exception ex)
            {
                errors.Add(item.Address + ": " + ex.Message);
            }
        }

        try
        {
            IsPrivate(null!);
            errors.Add("Nie odrzucono null.");
        }
        catch (ArgumentNullException)
        {
        }

        return errors;
    }
}
