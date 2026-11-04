using FrogSync.Server;
using FrogSync.Server.Admin;
using FrogSync.Server.Infrastructure;

var config = AppConfig.FromEnvironment();

// Awaryjne odzyskanie dostepu do panelu (np. zgubiony telefon z 2FA).
// Wymaga dostepu do kontenera, wiec nie da sie go wywolac przez siec.
if (args.Contains("--reset-admin"))
{
    var db = new Database(config);
    db.Migrate();
    AdminService.ResetAdmin(db);
    Console.WriteLine("Administrator usuniety. Uruchom serwer ponownie — w logu pojawi sie nowy kod konfiguracji.");
    Console.WriteLine("Zakladki, profile i urzadzenia zostaly nietkniete.");
    return;
}

ServerHost.Build(config).Run();
