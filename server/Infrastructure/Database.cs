using Microsoft.Data.Sqlite;

namespace FrogSync.Server.Infrastructure;

/// <summary>
/// Dostep do SQLite.
///
/// Zapisy ida przez jeden semafor i transakcje BEGIN IMMEDIATE — przy tej skali
/// (kilka przegladarek) to prostsze i pewniejsze niz liczenie na blokady SQLite
/// pod rownoleglym obciazeniem. Odczyty ida rownolegle dzieki trybowi WAL.
///
/// Kopia zapasowa NIE dziala pod tym semaforem: robi ja SQLite Backup API,
/// ktore nie blokuje zapisow. W Homepage kopia do Nextcloud siedziala pod ta sama
/// blokada co obsluga zadan i wolny Nextcloud zatrzymywal caly serwer.
/// </summary>
public sealed class Database
{
    private readonly string _connectionString;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    public Database(AppConfig config)
    {
        Directory.CreateDirectory(config.DataDir);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = config.DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = true,
        }.ToString();
    }

    public SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        Exec(connection, "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
        return connection;
    }

    /// <summary>Transakcja zapisu. Rzuca wyjatek = rollback, nic nie zostaje zapisane polowicznie.</summary>
    public async Task<T> WriteAsync<T>(Func<SqliteConnection, SqliteTransaction, T> work, CancellationToken ct = default)
    {
        await _writeGate.WaitAsync(ct);
        try
        {
            using var connection = Open();
            using var tx = connection.BeginTransaction(deferred: false);   // BEGIN IMMEDIATE
            var result = work(connection, tx);
            tx.Commit();
            return result;
        }
        finally { _writeGate.Release(); }
    }

    public Task WriteAsync(Action<SqliteConnection, SqliteTransaction> work, CancellationToken ct = default) =>
        WriteAsync<bool>((c, t) => { work(c, t); return true; }, ct);

    /// <summary>Wylaczny dostep do bazy bez otwartej transakcji — dla odtwarzania kopii.</summary>
    public async Task ExclusiveAsync(Action<SqliteConnection> work)
    {
        await _writeGate.WaitAsync();
        try
        {
            using var connection = Open();
            work(connection);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            _writeGate.Release();
        }
    }

    public T Read<T>(Func<SqliteConnection, T> work)
    {
        using var connection = Open();
        return work(connection);
    }

    // ============================================================
    // Pomocniki
    // ============================================================

    public static int Exec(SqliteConnection c, string sql, SqliteTransaction? tx = null, params (string, object?)[] args)
    {
        using var cmd = Command(c, sql, tx, args);
        return cmd.ExecuteNonQuery();
    }

    public static object? Scalar(SqliteConnection c, string sql, SqliteTransaction? tx = null, params (string, object?)[] args)
    {
        using var cmd = Command(c, sql, tx, args);
        var value = cmd.ExecuteScalar();
        return value is DBNull ? null : value;
    }

    public static SqliteCommand Command(SqliteConnection c, string sql, SqliteTransaction? tx, params (string, object?)[] args)
    {
        var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = tx;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd;
    }

    public string Generation() =>
        Read(c => (string)Scalar(c, "SELECT value FROM meta WHERE key = 'generation'")!);

    /// <summary>Nadaje bazie nowa generacje — wolane po odtworzeniu kopii.</summary>
    public static void NewGeneration(SqliteConnection c, SqliteTransaction? tx) =>
        Exec(c, "UPDATE meta SET value = lower(hex(randomblob(16))) WHERE key = 'generation'", tx);

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Kolejny numer globalnego dziennika zmian. Wolac wylacznie wewnatrz transakcji zapisu.</summary>
    public static long NextSeq(SqliteConnection c, SqliteTransaction tx)
    {
        Exec(c, "UPDATE seq SET value = value + 1 WHERE id = 1", tx);
        return (long)Scalar(c, "SELECT value FROM seq WHERE id = 1", tx)!;
    }

    // ============================================================
    // Schemat
    // ============================================================

    private static readonly string[] Migrations =
    [
        // 1 — schemat poczatkowy
        """
        CREATE TABLE seq(id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
        INSERT INTO seq(id, value) VALUES (1, 0);

        -- Generacja bazy: zmienia sie przy odtworzeniu kopii. Wtyczka z kursorem
        -- z innej generacji musi uzgodnic stan od nowa, zamiast cicho przeskoczyc zmiany.
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES ('generation', lower(hex(randomblob(16))));

        CREATE TABLE profiles(
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
            created_at    INTEGER NOT NULL,
            settings      TEXT NOT NULL DEFAULT '{}',
            settings_version INTEGER NOT NULL DEFAULT 0,
            logo          BLOB,
            logo_type     TEXT,
            logo_version  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE devices(
            id            TEXT PRIMARY KEY,
            profile_id    TEXT NOT NULL REFERENCES profiles(id),
            name          TEXT NOT NULL,
            browser       TEXT NOT NULL DEFAULT '',
            token_hash    TEXT NOT NULL UNIQUE,
            created_at    INTEGER NOT NULL,
            last_seen_at  INTEGER,
            last_ip       TEXT,
            cursor        INTEGER NOT NULL DEFAULT 0,
            revoked_at    INTEGER
        );

        CREATE TABLE pairing_codes(
            id            TEXT PRIMARY KEY,
            code_hash     TEXT NOT NULL,
            profile_id    TEXT NOT NULL REFERENCES profiles(id),
            device_name   TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL,
            used_at       INTEGER,
            device_id     TEXT
        );

        -- Drzewo zakladek. Wiersz nigdy nie znika: usuniecie to deleted = 1
        -- z nowym seq, dzieki czemu kazde urzadzenie dowie sie o nim z dziennika.
        -- *_v to numer wersji rekordu, przy ktorej dana grupa pol zmienila sie
        -- ostatnio — konflikt zglaszamy tylko gdy ktos zmienil TE SAME pola.
        CREATE TABLE nodes(
            profile_id    TEXT NOT NULL REFERENCES profiles(id),
            id            TEXT NOT NULL,
            parent_id     TEXT,
            kind          TEXT NOT NULL CHECK (kind IN ('root', 'folder', 'bookmark', 'separator')),
            title         TEXT NOT NULL DEFAULT '',
            url           TEXT,
            order_key     TEXT NOT NULL,
            meta          TEXT NOT NULL DEFAULT '{}',
            deleted       INTEGER NOT NULL DEFAULT 0,
            version       INTEGER NOT NULL,
            title_v       INTEGER NOT NULL,
            url_v         INTEGER NOT NULL,
            place_v       INTEGER NOT NULL,
            meta_v        INTEGER NOT NULL,
            life_v        INTEGER NOT NULL,     -- wersja ostatniego usuniecia albo przywrocenia
            seq           INTEGER NOT NULL,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            updated_by    TEXT,
            PRIMARY KEY (profile_id, id)
        );
        CREATE INDEX nodes_by_seq    ON nodes(profile_id, seq);
        CREATE INDEX nodes_by_parent ON nodes(profile_id, parent_id, deleted, order_key);

        -- Idempotencja: ta sama operacja wyslana drugi raz (np. po utracie
        -- odpowiedzi) dostaje zapisany wynik zamiast wykonac sie ponownie.
        -- Klucz obejmuje urzadzenie: identyczny clientOpId z dwoch przegladarek
        -- to dwie rozne operacje. payload_hash wykrywa ponowne uzycie ID z inna trescia.
        CREATE TABLE ops(
            device_id     TEXT NOT NULL,
            client_op_id  TEXT NOT NULL,
            profile_id    TEXT NOT NULL,
            payload_hash  TEXT NOT NULL,
            result        TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (device_id, client_op_id)
        );

        CREATE TABLE admin(
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            password_hash   TEXT NOT NULL,
            totp_secret     TEXT NOT NULL,
            totp_last_step  INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL
        );

        CREATE TABLE admin_sessions(
            token_hash    TEXT PRIMARY KEY,
            created_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL,
            ip            TEXT
        );

        CREATE TABLE audit(
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            at            INTEGER NOT NULL,
            kind          TEXT NOT NULL,
            actor         TEXT,
            ip            TEXT,
            detail        TEXT
        );
        CREATE INDEX audit_by_time ON audit(at);
        """,
        """
        CREATE TABLE blobs(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL);
        """,
        // 3 - zgoda na pominiecie zdalnego hamulca dotyczy konkretnego usuniecia.
        """
        ALTER TABLE nodes ADD COLUMN delete_approved INTEGER NOT NULL DEFAULT 0
            CHECK (delete_approved IN (0, 1));
        """,
        // 4 - ostatnia poprawna wersja zgloszona przez uwierzytelnione urzadzenie.
        """
        ALTER TABLE devices ADD COLUMN extension_version TEXT NOT NULL DEFAULT '';
        """,
    ];

    public static int SchemaVersion => Migrations.Length;

    public void Migrate()
    {
        using var c = Open();
        Migrate(c);
    }

    internal static void Migrate(SqliteConnection c)
    {
        Exec(c, "CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)");
        var current = Convert.ToInt32(Scalar(c, "SELECT COALESCE(MAX(version), 0) FROM schema_version") ?? 0);

        for (var i = current; i < Migrations.Length; i++)
        {
            using var tx = c.BeginTransaction();
            Exec(c, Migrations[i], tx);
            Exec(c, "INSERT INTO schema_version(version) VALUES (@v)", tx, ("@v", i + 1));
            tx.Commit();
        }
    }
}
