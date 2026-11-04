using System.Text.Json;
using System.Text.RegularExpressions;
using FrogSync.Server.Infrastructure;
using Microsoft.Data.Sqlite;

namespace FrogSync.Server.Sync;

/// <summary>
/// Dziennik zmian drzewa zakladek.
///
/// Kazda zmiana dostaje kolejny numer seq nadawany przez serwer. Wtyczka trzyma
/// kursor i pyta o wszystko po nim. Nie porownujemy zadnych zegarow ani stanow —
/// to bylo zrodlem bledow w obu poprzednich projektach.
///
/// Konflikt wykrywamy per grupa pol (tytul, adres, polozenie, metadane): jesli
/// ktos inny zmienil TE SAME pola od wersji, ktora widziala wtyczka, operacja
/// wraca jako konflikt z aktualnym stanem. Zmiana tytulu na jednym komputerze
/// i przeniesienie na drugim nie koliduja ze soba.
/// </summary>
public sealed partial class SyncService(Database db)
{
    public const int MaxOpsPerBatch = 500;
    public const int MaxNodesPerProfile = 200_000;
    public const int MaxTitle = 1_000;
    public const int MaxUrl = 8_192;
    public const int MaxMetaBytes = 8_192;

    [GeneratedRegex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    private static partial Regex GuidPattern();

    private static readonly JsonElement EmptyMeta = JsonDocument.Parse("{}").RootElement.Clone();

    // ============================================================
    // Profil — korzenie
    // ============================================================

    public static void CreateRoots(SqliteConnection c, SqliteTransaction tx, string profileId)
    {
        var now = Database.NowMs();
        for (var i = 0; i < NodeKinds.RootIds.Length; i++)
        {
            var seq = Database.NextSeq(c, tx);
            Database.Exec(c, """
                INSERT INTO nodes(profile_id, id, parent_id, kind, title, order_key, version,
                                  title_v, url_v, place_v, meta_v, life_v, seq, created_at, updated_at)
                VALUES (@p, @id, NULL, 'root', @t, @o, 1, 1, 1, 1, 1, 1, @s, @now, @now)
                """, tx,
                ("@p", profileId), ("@id", NodeKinds.RootIds[i]), ("@t", NodeKinds.RootIds[i][5..]),
                ("@o", "a" + i), ("@s", seq), ("@now", now));
        }
    }

    // ============================================================
    // Odczyt dziennika
    // ============================================================

    public ChangesResponse GetChanges(string profileId, long after, int limit)
    {
        limit = Math.Clamp(limit, 1, 2_000);
        return db.Read(c =>
        {
            var nodes = new List<NodeDto>();
            using (var cmd = Database.Command(c, $"{SelectNode} WHERE profile_id = @p AND seq > @after ORDER BY seq LIMIT @n", null,
                       ("@p", profileId), ("@after", after), ("@n", limit + 1)))
            using (var r = cmd.ExecuteReader())
                while (r.Read()) nodes.Add(ReadNode(r));

            var more = nodes.Count > limit;
            if (more) nodes.RemoveAt(nodes.Count - 1);

            var head = HeadOf(c, null, profileId);
            return new ChangesResponse
            {
                Nodes = nodes,
                More = more,
                Next = nodes.Count > 0 ? nodes[^1].Seq : Math.Max(after, 0),
                Head = head,
                Generation = (string)Database.Scalar(c, "SELECT value FROM meta WHERE key = 'generation'")!,
            };
        });
    }

    public long Head(string profileId) => db.Read(c => HeadOf(c, null, profileId));

    private static long HeadOf(SqliteConnection c, SqliteTransaction? tx, string profileId) =>
        (long)(Database.Scalar(c, "SELECT COALESCE(MAX(seq), 0) FROM nodes WHERE profile_id = @p", tx, ("@p", profileId)) ?? 0L);

    // ============================================================
    // Operacje
    // ============================================================

    public sealed class ResetRequired(string generation) : Exception("RESET_REQUIRED")
    {
        public string Generation { get; } = generation;
    }

    public async Task<OpsResponse> ApplyAsync(string profileId, string deviceId, IReadOnlyList<SyncOp> ops, string? generation)
    {
        if (ops.Count > MaxOpsPerBatch)
            throw new ArgumentException($"Najwyzej {MaxOpsPerBatch} operacji naraz");

        return await db.WriteAsync((c, tx) =>
        {
            var current = (string)Database.Scalar(c, "SELECT value FROM meta WHERE key = 'generation'", tx)!;
            if (!string.Equals(current, generation, StringComparison.Ordinal)) throw new ResetRequired(current);

            var results = new List<OpResult>(ops.Count);
            foreach (var op in ops)
            {
                // Kazda operacja we wlasnym punkcie zapisu: blad jednej nie cofa
                // pozostalych, a polowicznie wykonana nigdy nie zostaje w bazie.
                using var save = Database.Command(c, "SAVEPOINT op", tx);
                save.ExecuteNonQuery();
                try
                {
                    results.Add(ApplyOne(c, tx, profileId, deviceId, op));
                    Database.Exec(c, "RELEASE op", tx);
                }
                catch (OpRejected ex)
                {
                    Database.Exec(c, "ROLLBACK TO op; RELEASE op", tx);
                    var result = new OpResult { ClientOpId = op.ClientOpId, Status = "rejected", Reason = ex.Message };
                    TryRemember(c, tx, profileId, deviceId, op, result);
                    results.Add(result);
                }
            }
            return new OpsResponse { Results = results, Head = HeadOf(c, tx, profileId) };
        });
    }

    private OpResult ApplyOne(SqliteConnection c, SqliteTransaction tx, string profileId, string deviceId, SyncOp op)
    {
        if (string.IsNullOrWhiteSpace(op.ClientOpId) || op.ClientOpId.Length > 100)
            throw new OpRejected("Brak lub zbyt dlugi clientOpId");

        // Idempotencja: ta sama operacja tego samego urzadzenia po raz drugi = zapisany
        // wynik pierwszego razu (rowniez conflict i rejected — powtorzenie identycznego
        // zadania ma dostac identyczna odpowiedz; rozstrzygniecie konfliktu idzie z nowym ID).
        var payloadHash = PayloadHash(op);
        using (var check = Database.Command(c, "SELECT payload_hash, result FROM ops WHERE device_id = @d AND client_op_id = @o", tx,
                   ("@d", deviceId), ("@o", op.ClientOpId)))
        using (var r = check.ExecuteReader())
        {
            if (r.Read())
            {
                if (r.GetString(0) != payloadHash)
                    throw new OpRejected("Ten clientOpId byl juz uzyty dla innej operacji");
                var previous = JsonSerializer.Deserialize<OpResult>(r.GetString(1))!;
                previous.Duplicate = true;
                return previous;
            }
        }

        var result = op.Type switch
        {
            "create" => Create(c, tx, profileId, deviceId, op),
            "update" => Update(c, tx, profileId, deviceId, op),
            "move"   => Move(c, tx, profileId, deviceId, op),
            "delete" => Delete(c, tx, profileId, deviceId, op),
            _        => throw new OpRejected($"Nieznany typ operacji: {op.Type}"),
        };

        Remember(c, tx, profileId, deviceId, op.ClientOpId, payloadHash, result);
        return result;
    }

    private static string PayloadHash(SyncOp op) =>
        FrogSync.Server.Security.Secrets.TokenHash(JsonSerializer.Serialize(op));

    // ---- create ----

    private OpResult Create(SqliteConnection c, SqliteTransaction tx, string profileId, string deviceId, SyncOp op)
    {
        ValidateNewId(op.NodeId);
        var kind = op.Kind ?? throw new OpRejected("Brak rodzaju wezla");
        if (kind is not (NodeKinds.Folder or NodeKinds.Bookmark or NodeKinds.Separator))
            throw new OpRejected($"Nie mozna utworzyc wezla rodzaju {kind}");

        var title = ValidateTitle(op.Title ?? "");
        var url = kind == NodeKinds.Bookmark ? ValidateUrl(op.Url) : null;
        var meta = ValidateMeta(op.Meta);

        var existing = Load(c, tx, profileId, op.NodeId);
        if (existing is not null)
            return Conflict(op, "exists", existing);

        var count = (long)(Database.Scalar(c, "SELECT COUNT(*) FROM nodes WHERE profile_id = @p", tx, ("@p", profileId)) ?? 0L);
        if (count >= MaxNodesPerProfile) throw new OpRejected("Przekroczono limit wezlow w profilu");

        var parentId = op.ParentId ?? throw new OpRejected("Brak folderu nadrzednego");
        var parentProblem = CheckParent(c, tx, profileId, parentId);
        if (parentProblem is not null)
            return Conflict(op, parentProblem, null);

        var order = Place(c, tx, profileId, parentId, op.AfterId, op.BeforeId, op.NodeId, op.Force, out var placeProblem);
        if (order is null) return Conflict(op, placeProblem!, null);

        var seq = Database.NextSeq(c, tx);
        var now = Database.NowMs();
        Database.Exec(c, """
            INSERT INTO nodes(profile_id, id, parent_id, kind, title, url, order_key, meta, version,
                              title_v, url_v, place_v, meta_v, life_v, seq, created_at, updated_at, updated_by)
            VALUES (@p, @id, @parent, @kind, @title, @url, @order, @meta, 1, 1, 1, 1, 1, 1, @seq, @now, @now, @dev)
            """, tx,
            ("@p", profileId), ("@id", op.NodeId), ("@parent", parentId), ("@kind", kind), ("@title", title),
            ("@url", url), ("@order", order), ("@meta", meta), ("@seq", seq), ("@now", now), ("@dev", deviceId));

        return Applied(op, Load(c, tx, profileId, op.NodeId)!);
    }

    // ---- update (tytul, adres, metadane) ----

    private OpResult Update(SqliteConnection c, SqliteTransaction tx, string profileId, string deviceId, SyncOp op)
    {
        var node = Load(c, tx, profileId, op.NodeId) ?? throw new OpRejected("Nie ma takiego wezla");
        if (node.Kind == NodeKinds.Root) throw new OpRejected("Korzenia nie mozna zmieniac");
        var baseVersion = op.BaseVersion ?? throw new OpRejected("Brak baseVersion");

        var row = LoadVersions(c, tx, profileId, op.NodeId);

        if (node.Deleted && !op.Force) return Conflict(op, "deleted", node);
        string? restoredOrder = null;
        if (node.Deleted)
        {
            // Swiadome przywrocenie: rodzic musi istniec, a dawny klucz kolejnosci
            // mogl juz w tym czasie dostac inny wpis — liczymy miejsce od nowa.
            var parentProblem = CheckParent(c, tx, profileId, node.ParentId!);
            if (parentProblem is not null) return Conflict(op, parentProblem, node);
            restoredOrder = RestorePlace(c, tx, profileId, node.ParentId!, node.Id, node.Order);
        }

        var changesTitle = op.Title is not null && op.Title != node.Title;
        var changesUrl   = op.Url is not null && op.Url != node.Url;
        var changesMeta  = op.Meta is not null;

        if (!op.Force)
        {
            if (changesTitle && row.TitleV > baseVersion) return Conflict(op, "title-changed", node);
            if (changesUrl   && row.UrlV   > baseVersion) return Conflict(op, "url-changed", node);
            if (changesMeta  && row.MetaV  > baseVersion) return Conflict(op, "meta-changed", node);
        }

        if (!changesTitle && !changesUrl && !changesMeta && !node.Deleted)
            return Applied(op, node);   // nic do zrobienia — nie podbijamy seq

        var title = changesTitle ? ValidateTitle(op.Title!) : node.Title;
        var url   = changesUrl ? (node.Kind == NodeKinds.Bookmark ? ValidateUrl(op.Url) : throw new OpRejected("Tylko zakladka ma adres")) : node.Url;
        var meta  = changesMeta ? ValidateMeta(op.Meta) : node.Meta.GetRawText();

        var version = node.Version + 1;
        var seq = Database.NextSeq(c, tx);
        Database.Exec(c, """
            UPDATE nodes SET title = @title, url = @url, meta = @meta, deleted = 0, delete_approved = 0, version = @v,
                   title_v = CASE WHEN @ct THEN @v ELSE title_v END,
                   url_v   = CASE WHEN @cu THEN @v ELSE url_v END,
                   meta_v  = CASE WHEN @cm THEN @v ELSE meta_v END,
                   life_v  = CASE WHEN deleted = 1 THEN @v ELSE life_v END,
                   order_key = COALESCE(@restoredOrder, order_key),
                   seq = @seq, updated_at = @now, updated_by = @dev
            WHERE profile_id = @p AND id = @id
            """, tx,
            ("@title", title), ("@url", url), ("@meta", meta), ("@v", version),
            ("@ct", changesTitle), ("@cu", changesUrl), ("@cm", changesMeta), ("@restoredOrder", restoredOrder),
            ("@seq", seq), ("@now", Database.NowMs()), ("@dev", deviceId), ("@p", profileId), ("@id", op.NodeId));

        return Applied(op, Load(c, tx, profileId, op.NodeId)!);
    }

    // ---- move ----

    private OpResult Move(SqliteConnection c, SqliteTransaction tx, string profileId, string deviceId, SyncOp op)
    {
        var node = Load(c, tx, profileId, op.NodeId) ?? throw new OpRejected("Nie ma takiego wezla");
        if (node.Kind == NodeKinds.Root) throw new OpRejected("Korzenia nie mozna przenosic");
        if (node.Deleted) return Conflict(op, "deleted", node);
        var baseVersion = op.BaseVersion ?? throw new OpRejected("Brak baseVersion");

        var row = LoadVersions(c, tx, profileId, op.NodeId);
        if (!op.Force && row.PlaceV > baseVersion) return Conflict(op, "moved-elsewhere", node);

        var parentId = op.ParentId ?? throw new OpRejected("Brak folderu docelowego");
        var parentProblem = CheckParent(c, tx, profileId, parentId);
        if (parentProblem is not null) return Conflict(op, parentProblem, node);

        if (node.Kind == NodeKinds.Folder && IsDescendantOrSelf(c, tx, profileId, parentId, node.Id))
            throw new OpRejected("Nie mozna przeniesc folderu do jego wlasnego podfolderu");

        var order = Place(c, tx, profileId, parentId, op.AfterId, op.BeforeId, node.Id, op.Force, out var placeProblem);
        if (order is null) return Conflict(op, placeProblem!, node);

        if (parentId == node.ParentId && order == node.Order) return Applied(op, node);

        var version = node.Version + 1;
        var seq = Database.NextSeq(c, tx);
        Database.Exec(c, """
            UPDATE nodes SET parent_id = @parent, order_key = @order, version = @v, place_v = @v,
                   seq = @seq, updated_at = @now, updated_by = @dev
            WHERE profile_id = @p AND id = @id
            """, tx,
            ("@parent", parentId), ("@order", order), ("@v", version), ("@seq", seq),
            ("@now", Database.NowMs()), ("@dev", deviceId), ("@p", profileId), ("@id", node.Id));

        return Applied(op, Load(c, tx, profileId, node.Id)!);
    }

    // ---- delete ----

    private OpResult Delete(SqliteConnection c, SqliteTransaction tx, string profileId, string deviceId, SyncOp op)
    {
        var node = Load(c, tx, profileId, op.NodeId);
        if (node is null) throw new OpRejected("Nie ma takiego wezla");
        if (node.Kind == NodeKinds.Root) throw new OpRejected("Korzenia nie mozna usunac");
        if (node.Deleted) return Applied(op, node);   // juz usuniety — cel osiagniety

        var baseVersion = op.BaseVersion ?? throw new OpRejected("Brak baseVersion");
        var row = LoadVersions(c, tx, profileId, op.NodeId);

        // Usuniecie kontra edycja: jesli ktos zmienil tresc od czasu, gdy ja widzielismy,
        // nie kasujemy po cichu cudzej pracy. Samo przeniesienie nie blokuje usuniecia.
        // life_v: ktos usunal i swiadomie przywrocil wpis — tez nie kasujemy go ponownie.
        if (!op.Force && (row.TitleV > baseVersion || row.UrlV > baseVersion || row.MetaV > baseVersion || row.LifeV > baseVersion))
            return Conflict(op, "edited-since", node);

        // Folder: wersja samego folderu nie mowi nic o jego zawartosci. Jesli INNE
        // urzadzenie zmienilo cos w poddrzewie po tym, co widziala wtyczka (baseSeq),
        // usuniecie skasowaloby te prace bez wiedzy uzytkownika.
        if (node.Kind == NodeKinds.Folder && !op.Force)
        {
            var baseSeq = op.BaseSeq ?? throw new OpRejected("Usuniecie folderu wymaga baseSeq");
            var changedInside = Database.Scalar(c, """
                WITH RECURSIVE sub(id) AS (
                    SELECT @id
                    UNION
                    SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.profile_id = @p
                )
                SELECT 1 FROM nodes n JOIN sub ON n.id = sub.id
                WHERE n.profile_id = @p AND n.id <> @id AND n.seq > @base
                  AND (n.updated_by IS NULL OR n.updated_by <> @dev)
                LIMIT 1
                """, tx, ("@p", profileId), ("@id", node.Id), ("@base", baseSeq), ("@dev", deviceId));
            if (changedInside is not null) return Conflict(op, "subtree-changed", node);
        }

        // Folder: usuwamy cale poddrzewo, kazdy wezel z wlasnym seq, zeby
        // urzadzenia dostaly komplet informacji z dziennika.
        var ids = new List<string>();
        using (var cmd = Database.Command(c, """
            WITH RECURSIVE sub(id) AS (
                SELECT @id
                UNION
                SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
                WHERE n.profile_id = @p AND n.deleted = 0
            )
            SELECT id FROM sub
            """, tx, ("@p", profileId), ("@id", node.Id)))
        using (var r = cmd.ExecuteReader())
            while (r.Read()) ids.Add(r.GetString(0));

        var now = Database.NowMs();
        // Od najglebszych, zeby korzen poddrzewa mial najwyzszy seq
        for (var i = ids.Count - 1; i >= 0; i--)
        {
            var seq = Database.NextSeq(c, tx);
            Database.Exec(c, """
                UPDATE nodes SET deleted = 1, delete_approved = @approved,
                    version = version + 1, life_v = version + 1, seq = @seq,
                    updated_at = @now, updated_by = @dev
                WHERE profile_id = @p AND id = @id AND deleted = 0
                """, tx, ("@approved", op.Approved ? 1 : 0), ("@seq", seq),
                ("@now", now), ("@dev", deviceId), ("@p", profileId), ("@id", ids[i]));
        }

        return Applied(op, Load(c, tx, profileId, node.Id)!);
    }

    // ============================================================
    // Polozenie w folderze
    // ============================================================

    /// <summary>
    /// Wylicza klucz kolejnosci z zamiaru wtyczki:
    ///   afterId istnieje w folderze  -> tuz za nim
    ///   afterId zniknal, beforeId jest -> tuz przed beforeId
    ///   oba null                      -> na poczatek folderu
    ///   kotwice podane, zadna nie zyje -> KONFLIKT (albo koniec folderu przy force)
    ///
    /// Ostatni przypadek to swiadoma decyzja: v2 w takiej sytuacji wrzucala
    /// zakladke na koniec i uzytkownik znajdowal ja po czasie na dole listy.
    /// </summary>
    private static string? Place(SqliteConnection c, SqliteTransaction tx, string profileId, string parentId,
        string? afterId, string? beforeId, string movingId, bool force, out string? problem)
    {
        problem = null;
        var siblings = new List<(string Id, string Key)>();
        using (var cmd = Database.Command(c, """
            SELECT id, order_key FROM nodes
            WHERE profile_id = @p AND parent_id = @parent AND deleted = 0 AND id <> @moving
            ORDER BY order_key
            """, tx, ("@p", profileId), ("@parent", parentId), ("@moving", movingId)))
        using (var r = cmd.ExecuteReader())
            while (r.Read()) siblings.Add((r.GetString(0), r.GetString(1)));

        string? KeyAt(int index) => index >= 0 && index < siblings.Count ? siblings[index].Key : null;

        if (afterId is null && beforeId is null)
            return OrderKey.Between(null, KeyAt(0));

        if (afterId is not null)
        {
            var i = siblings.FindIndex(s => s.Id == afterId);
            if (i >= 0) return OrderKey.Between(siblings[i].Key, KeyAt(i + 1));
        }

        if (beforeId is not null)
        {
            var i = siblings.FindIndex(s => s.Id == beforeId);
            if (i >= 0) return OrderKey.Between(KeyAt(i - 1), siblings[i].Key);
        }

        if (afterId is null && beforeId is not null && siblings.Count == 0)
            return OrderKey.Between(null, null);

        if (force) return OrderKey.Between(KeyAt(siblings.Count - 1), null);

        problem = "anchor-missing";
        return null;
    }

    private static string? CheckParent(SqliteConnection c, SqliteTransaction tx, string profileId, string parentId)
    {
        using var cmd = Database.Command(c, "SELECT kind, deleted FROM nodes WHERE profile_id = @p AND id = @id", tx,
            ("@p", profileId), ("@id", parentId));
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return "parent-missing";
        if (!NodeKinds.IsContainer(r.GetString(0))) throw new OpRejected("Rodzic nie jest folderem");
        return r.GetInt64(1) != 0 ? "parent-deleted" : null;
    }

    public const int MaxDepth = 1_000;

    /// <summary>
    /// Czy candidate lezy w poddrzewie ancestor. Przy przekroczeniu glebokosci albo
    /// petli w danych odpowiadamy "tak" — odrzucenie ruchu jest bezpieczne,
    /// przepuszczenie mogloby zbudowac cykl.
    /// </summary>
    private static bool IsDescendantOrSelf(SqliteConnection c, SqliteTransaction tx, string profileId, string candidate, string ancestor)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var current = candidate;
        while (current is not null)
        {
            if (current == ancestor) return true;
            if (!visited.Add(current) || visited.Count > MaxDepth) return true;
            current = Database.Scalar(c, "SELECT parent_id FROM nodes WHERE profile_id = @p AND id = @id", tx,
                ("@p", profileId), ("@id", current)) as string;
        }
        return false;
    }

    /// <summary>
    /// Klucz dla przywracanego wpisu: zostaje dawny, jesli nikt go nie zajal;
    /// jesli zajety — tuz za wpisem, ktory go zajal. Klucze aktywnego rodzenstwa
    /// musza byc unikalne, inaczej nie da sie wstawic nic pomiedzy.
    /// </summary>
    private static string RestorePlace(SqliteConnection c, SqliteTransaction tx, string profileId, string parentId, string id, string oldKey)
    {
        var keys = new List<string>();
        using (var cmd = Database.Command(c, """
            SELECT order_key FROM nodes
            WHERE profile_id = @p AND parent_id = @parent AND deleted = 0 AND id <> @id
            ORDER BY order_key
            """, tx, ("@p", profileId), ("@parent", parentId), ("@id", id)))
        using (var r = cmd.ExecuteReader())
            while (r.Read()) keys.Add(r.GetString(0));

        var index = keys.FindIndex(k => string.CompareOrdinal(k, oldKey) >= 0);
        if (index < 0 || keys[index] != oldKey) return oldKey;
        return OrderKey.Between(keys[index], index + 1 < keys.Count ? keys[index + 1] : null);
    }

    // ============================================================
    // Walidacja
    // ============================================================

    private static void ValidateNewId(string id)
    {
        if (!GuidPattern().IsMatch(id ?? "")) throw new OpRejected("Identyfikator wezla musi byc GUID-em");
    }

    private static string ValidateTitle(string title) =>
        title.Length <= MaxTitle ? title : throw new OpRejected($"Tytul dluzszy niz {MaxTitle} znakow");

    private static string ValidateUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) throw new OpRejected("Zakladka musi miec adres");
        if (url.Length > MaxUrl) throw new OpRejected($"Adres dluzszy niz {MaxUrl} znakow");
        return url;
    }

    private static string ValidateMeta(JsonElement? meta)
    {
        if (meta is null) return "{}";
        if (meta.Value.ValueKind != JsonValueKind.Object) throw new OpRejected("meta musi byc obiektem");
        var raw = meta.Value.GetRawText();
        return raw.Length <= MaxMetaBytes ? raw : throw new OpRejected("meta za duze");
    }

    // ============================================================
    // Odczyt wezla
    // ============================================================

    private const string SelectNode =
        "SELECT id, parent_id, kind, title, url, order_key, meta, deleted, version, seq, delete_approved FROM nodes";

    private static NodeDto ReadNode(SqliteDataReader r) => new()
    {
        Id = r.GetString(0),
        ParentId = r.IsDBNull(1) ? null : r.GetString(1),
        Kind = r.GetString(2),
        Title = r.GetString(3),
        Url = r.IsDBNull(4) ? null : r.GetString(4),
        Order = r.GetString(5),
        Meta = ParseMeta(r.GetString(6)),
        Deleted = r.GetInt64(7) != 0,
        Version = r.GetInt64(8),
        Seq = r.GetInt64(9),
        Approved = r.GetInt64(7) != 0 && r.GetInt64(10) != 0,
    };

    private static JsonElement ParseMeta(string raw)
    {
        try { return JsonDocument.Parse(raw).RootElement.Clone(); }
        catch { return EmptyMeta; }
    }

    private static NodeDto? Load(SqliteConnection c, SqliteTransaction tx, string profileId, string id)
    {
        using var cmd = Database.Command(c, $"{SelectNode} WHERE profile_id = @p AND id = @id", tx, ("@p", profileId), ("@id", id));
        using var r = cmd.ExecuteReader();
        return r.Read() ? ReadNode(r) : null;
    }

    private readonly record struct FieldVersions(long TitleV, long UrlV, long PlaceV, long MetaV, long LifeV);

    private static FieldVersions LoadVersions(SqliteConnection c, SqliteTransaction tx, string profileId, string id)
    {
        using var cmd = Database.Command(c, "SELECT title_v, url_v, place_v, meta_v, life_v FROM nodes WHERE profile_id = @p AND id = @id", tx,
            ("@p", profileId), ("@id", id));
        using var r = cmd.ExecuteReader();
        r.Read();
        return new FieldVersions(r.GetInt64(0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4));
    }

    // ============================================================

    private static OpResult Applied(SyncOp op, NodeDto node) =>
        new() { ClientOpId = op.ClientOpId, Status = "applied", Node = node };

    private static OpResult Conflict(SyncOp op, string reason, NodeDto? current) =>
        new() { ClientOpId = op.ClientOpId, Status = "conflict", Reason = reason, Node = current };

    private static void Remember(SqliteConnection c, SqliteTransaction tx, string profileId, string deviceId,
        string clientOpId, string payloadHash, OpResult result)
    {
        Database.Exec(c, """
            INSERT INTO ops(device_id, client_op_id, profile_id, payload_hash, result, created_at)
            VALUES (@d, @o, @p, @h, @r, @now)
            """, tx,
            ("@d", deviceId), ("@o", clientOpId), ("@p", profileId), ("@h", payloadHash),
            ("@r", JsonSerializer.Serialize(result)), ("@now", Database.NowMs()));
    }

    private static void TryRemember(SqliteConnection c, SqliteTransaction tx, string profileId, string deviceId, SyncOp op, OpResult result)
    {
        if (string.IsNullOrWhiteSpace(op.ClientOpId) || op.ClientOpId.Length > 100) return;
        try { Remember(c, tx, profileId, deviceId, op.ClientOpId, PayloadHash(op), result); } catch { /* np. ponowne uzycie ID — bez znaczenia */ }
    }

    /// <summary>Wpisy idempotencji starsze niz 90 dni — wtyczka nie ponawia operacji tak dlugo.</summary>
    public Task PruneOpsAsync() => db.WriteAsync((c, tx) =>
        Database.Exec(c, "DELETE FROM ops WHERE created_at < @cut", tx, ("@cut", Database.NowMs() - 90L * 86_400_000)));
}

public sealed class OpRejected(string message) : Exception(message);
