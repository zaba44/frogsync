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

public sealed record StartPageDocument(
    int Version,
    List<StartPageSection> Sections,
    List<StartPageEngine> Engines);

public sealed record StartPageSave(
    long SettingsVersion,
    string Generation,
    StartPageDocument Configuration);

public sealed record StartPageSectionView(
    string Id,
    string FolderId,
    string? Title,
    bool Available,
    string? FolderTitle);

public sealed record StartPageView(
    int Version,
    List<StartPageSectionView> Sections,
    List<StartPageEngine> Engines);

public sealed record StartPageSnapshot(
    string ProfileId,
    string Generation,
    long SettingsVersion,
    long LogoVersion,
    StartPageView Configuration);

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

public sealed record StartPageLogo(
    string ProfileId,
    string Generation,
    long LogoVersion,
    byte[]? Bytes,
    string? ContentType);

public sealed class StartPageConflict(StartPageSnapshot current)
    : Exception("Konfiguracja strony startowej zmienila sie.")
{
    public StartPageSnapshot Current { get; } = current;
}
