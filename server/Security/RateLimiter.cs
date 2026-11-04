using System.Collections.Concurrent;

namespace FrogSync.Server.Security;

/// <summary>
/// Blokada po serii nieudanych prob — osobno dla kazdego adresu i dla kazdego rodzaju operacji.
///
/// Kod parowania ma tylko milion mozliwych wartosci, wiec oprocz blokady na adres
/// jest tez limit globalny: jesli w krotkim czasie przyjdzie duzo blednych kodow
/// z roznych adresow, parowanie wylacza sie na chwile dla wszystkich.
/// Stan trzymamy w pamieci: restart serwera zeruje liczniki, ale tez uniewaznia
/// nic nie wnoszace proby — kody i tak wygasaja po 5 minutach.
/// </summary>
public sealed class RateLimiter
{
    private sealed class Bucket
    {
        public int Failures;
        public DateTimeOffset WindowStart;
        public DateTimeOffset LockedUntil;
    }

    private readonly ConcurrentDictionary<string, Bucket> _buckets = new();
    private readonly int _maxFailures;
    private readonly TimeSpan _window;
    private readonly TimeSpan _baseLockout;

    public RateLimiter(int maxFailures, TimeSpan window, TimeSpan baseLockout)
    {
        _maxFailures = maxFailures;
        _window = window;
        _baseLockout = baseLockout;
    }

    public bool IsLocked(string key, out TimeSpan remaining)
    {
        remaining = TimeSpan.Zero;
        if (!_buckets.TryGetValue(key, out var bucket)) return false;
        lock (bucket)
        {
            var now = DateTimeOffset.UtcNow;
            if (bucket.LockedUntil > now) { remaining = bucket.LockedUntil - now; return true; }
            return false;
        }
    }

    public void Fail(string key)
    {
        var bucket = _buckets.GetOrAdd(key, _ => new Bucket { WindowStart = DateTimeOffset.UtcNow });
        lock (bucket)
        {
            var now = DateTimeOffset.UtcNow;
            if (now - bucket.WindowStart > _window) { bucket.Failures = 0; bucket.WindowStart = now; }
            bucket.Failures++;
            if (bucket.Failures >= _maxFailures)
            {
                // Kazda kolejna seria w tym samym oknie podwaja blokade (do 24 h)
                var multiplier = Math.Min(64, 1 << Math.Min(6, bucket.Failures - _maxFailures));
                var lockout = TimeSpan.FromTicks(Math.Min(TimeSpan.FromHours(24).Ticks, _baseLockout.Ticks * multiplier));
                bucket.LockedUntil = now + lockout;
            }
        }
    }

    public void Succeed(string key) => _buckets.TryRemove(key, out _);
}

public sealed class Limiters
{
    /// <summary>Logowanie do panelu: 5 bledow w 15 min = blokada adresu od 15 min w gore.</summary>
    public RateLimiter AdminLogin { get; } = new(5, TimeSpan.FromMinutes(15), TimeSpan.FromMinutes(15));

    /// <summary>Kod parowania na adres: 5 bledow w 15 min.</summary>
    public RateLimiter PairingPerIp { get; } = new(5, TimeSpan.FromMinutes(15), TimeSpan.FromMinutes(15));

    /// <summary>Kod parowania globalnie: 20 bledow w 5 min wylacza parowanie wszystkim na 5 min.</summary>
    public RateLimiter PairingGlobal { get; } = new(20, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));

    /// <summary>Kod pierwszej konfiguracji.</summary>
    public RateLimiter Setup { get; } = new(5, TimeSpan.FromMinutes(15), TimeSpan.FromMinutes(15));
}
