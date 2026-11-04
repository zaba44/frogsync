using System.Text.Json;
using System.Text.Json.Serialization;

namespace FrogSync.Server.Sync;

/// <summary>Stan wezla wysylany do wtyczki. Usuniety wezel tez trafia do dziennika - z Deleted = true.</summary>
public sealed class NodeDto
{
    [JsonPropertyName("id")]       public string  Id       { get; init; } = "";
    [JsonPropertyName("parentId")] public string? ParentId { get; init; }
    [JsonPropertyName("kind")]     public string  Kind     { get; init; } = "";
    [JsonPropertyName("title")]    public string  Title    { get; init; } = "";
    [JsonPropertyName("url")]      public string? Url      { get; init; }
    /// <summary>Klucz kolejnosci w folderze; porownywany ordinalnie. Nadaje go wylacznie serwer.</summary>
    [JsonPropertyName("order")]    public string  Order    { get; init; } = "";
    [JsonPropertyName("meta")]     public JsonElement Meta { get; init; }
    [JsonPropertyName("deleted")]  public bool    Deleted  { get; init; }
    /// <summary>Zgoda na zastosowanie tego usuniecia bez zdalnego hamulca.</summary>
    [JsonPropertyName("approved")] public bool    Approved { get; init; }
    [JsonPropertyName("version")]  public long    Version  { get; init; }
    [JsonPropertyName("seq")]      public long    Seq      { get; init; }
}

/// <summary>
/// Operacja od wtyczki. Wtyczka wysyla ZAMIAR ("przenies za X"), nie gotowy
/// indeks - indeksy w przegladarce przesuwaja sie przy kazdym ruchu sasiada,
/// wiec przesylanie ich prowadziloby do rozjazdow.
/// </summary>
public sealed class SyncOp
{
    [JsonPropertyName("clientOpId")]  public string  ClientOpId  { get; init; } = "";
    /// <summary>create | update | move | delete</summary>
    [JsonPropertyName("type")]        public string  Type        { get; init; } = "";
    [JsonPropertyName("nodeId")]      public string  NodeId      { get; init; } = "";
    [JsonPropertyName("kind")]        public string? Kind        { get; init; }
    [JsonPropertyName("parentId")]    public string? ParentId    { get; init; }
    [JsonPropertyName("title")]       public string? Title       { get; init; }
    [JsonPropertyName("url")]         public string? Url         { get; init; }
    [JsonPropertyName("meta")]        public JsonElement? Meta   { get; init; }
    /// <summary>Poprzedni sasiad w folderze docelowym; null = na poczatek.</summary>
    [JsonPropertyName("afterId")]     public string? AfterId     { get; init; }
    /// <summary>Nastepny sasiad - kotwica zapasowa, gdy poprzedniego juz nie ma.</summary>
    [JsonPropertyName("beforeId")]    public string? BeforeId    { get; init; }
    /// <summary>Wersja wezla, ktora widziala wtyczka przed zmiana.</summary>
    [JsonPropertyName("baseVersion")] public long?   BaseVersion { get; init; }
    /// <summary>Kursor wtyczki w chwili decyzji. Wymagany przy usuwaniu folderu - wykrywa cudze zmiany w jego zawartosci.</summary>
    [JsonPropertyName("baseSeq")]     public long?   BaseSeq     { get; init; }
    /// <summary>Swiadome nadpisanie po rozstrzygnieciu konfliktu przez uzytkownika.</summary>
    [JsonPropertyName("force")]       public bool    Force       { get; init; }
    /// <summary>Zgoda na zdalne usuniecie wezla i usuwanego poddrzewa. Nie rozstrzyga konfliktow.</summary>
    // Brak pola i false maja ten sam hash jak przed dodaniem znacznika.
    [JsonPropertyName("approved")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Approved { get; init; }
}

public sealed class OpsRequest
{
    [JsonPropertyName("generation")] public string? Generation { get; init; }
    [JsonPropertyName("protocol")] public int? Protocol { get; init; }
    [JsonPropertyName("ops")] public List<SyncOp> Ops { get; init; } = [];
}

public sealed class OpResult
{
    [JsonPropertyName("clientOpId")] public string  ClientOpId { get; init; } = "";
    /// <summary>applied | conflict | rejected</summary>
    [JsonPropertyName("status")]     public string  Status     { get; init; } = "";
    [JsonPropertyName("reason")]     public string? Reason     { get; init; }
    /// <summary>Stan wezla po operacji (applied) albo aktualny stan na serwerze (conflict).</summary>
    [JsonPropertyName("node")]       public NodeDto? Node      { get; init; }
    /// <summary>true = ta sama operacja przyszla ponownie; zwracamy wynik zapisany za pierwszym razem.</summary>
    [JsonPropertyName("duplicate")]  public bool    Duplicate  { get; set; }
}

public sealed class OpsResponse
{
    [JsonPropertyName("results")] public List<OpResult> Results { get; init; } = [];
    [JsonPropertyName("head")]    public long Head { get; init; }
}

public sealed class ChangesResponse
{
    [JsonPropertyName("nodes")] public List<NodeDto> Nodes { get; init; } = [];
    /// <summary>Kursor do nastepnego zapytania. Wtyczka zapisuje go DOPIERO po zastosowaniu calej strony.</summary>
    [JsonPropertyName("next")]  public long Next { get; init; }
    [JsonPropertyName("more")]  public bool More { get; init; }
    [JsonPropertyName("head")]  public long Head { get; init; }
    /// <summary>Generacja bazy. Inna niz zapamietana przez wtyczke = baza odtworzona z kopii, trzeba uzgodnic stan od nowa.</summary>
    [JsonPropertyName("generation")] public string Generation { get; init; } = "";
}

public static class NodeKinds
{
    public const string Root = "root", Folder = "folder", Bookmark = "bookmark", Separator = "separator";

    /// <summary>Stale korzenie kazdego profilu - wtyczka mapuje na nie foldery specjalne przegladarek.</summary>
    public static readonly string[] RootIds = ["root:toolbar", "root:menu", "root:unsorted", "root:mobile"];

    public static bool IsContainer(string kind) => kind is Root or Folder;
}
