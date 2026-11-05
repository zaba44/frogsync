using System.Text.Json.Serialization;

namespace FrogSync.Server.StartPage;

public sealed record StartPageSection(
    string Id,
    string FolderId,
    string? Title = null);

public sealed record StartPageEngine(
    string Id,
    string Name,
    string Url,
    string Color,
    string Suggest);

public sealed record StartPageTile(
    string Id,
    string Title,
    string Url,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? Color = null);

public sealed record StartPageBlock
{
    public string Id { get; init; } = "";
    public string Type { get; init; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Title { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FolderId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<StartPageTile>? Tiles { get; init; }

    // Pola wyliczane przy odczycie; nie sa zapisywane w settings.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Available { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FolderTitle { get; init; }
}

public sealed record StartPageDocument
{
    public int Version { get; init; }

    // Obslugiwane na wejsciu v1. Dokument kanoniczny nie zawiera sections.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<StartPageSection>? Sections { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<StartPageBlock>? Blocks { get; init; }

    public List<StartPageEngine>? Engines { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Template { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Configured { get; init; }
}

public sealed record StartPageSave(
    long SettingsVersion,
    string Generation,
    StartPageDocument Configuration);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record StartPageCustomSave(
    long SettingsVersion,
    string Generation,
    List<StartPageBlock> Blocks);

public sealed record StartPageSnapshot(
    string ProfileId,
    string Generation,
    long SettingsVersion,
    long LogoVersion,
    long BackgroundVersion,
    StartPageDocument Configuration);

public sealed record StartPageFolder(
    string Id,
    string? ParentId,
    string Kind,
    string Title,
    string Order);

public sealed record StartPageFolders(
    string ProfileId,
    string Generation,
    List<StartPageFolder> Folders);

public sealed record StartPageAsset(
    string ProfileId,
    string Generation,
    long Version,
    byte[]? Bytes,
    string? ContentType);

public sealed class StartPageConflict(StartPageSnapshot current)
    : Exception("Konfiguracja strony startowej zmienila sie.")
{
    public StartPageSnapshot Current { get; } = current;
}
