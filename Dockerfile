# Obraz serwera FrogSync.
# Budowany z katalogu glownego repozytorium:  docker build -t frogsync .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY server/FrogSync.Server.csproj server/
COPY extension/package.json extension/package.json
RUN dotnet restore server/FrogSync.Server.csproj
COPY server/ server/
RUN dotnet publish server/FrogSync.Server.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .

# Katalog danych nalezy do uzytkownika "app" (bez uprawnien roota),
# zeby nowy wolumen Dockera od razu mial wlasciwego wlasciciela.
RUN mkdir -p /data && chown app:app /data
USER app

ENV FROGSYNC_DATA=/data \
    FROGSYNC_PORT=8443 \
    DOTNET_gcServer=0
VOLUME /data
EXPOSE 8443

ENTRYPOINT ["dotnet", "FrogSync.Server.dll"]
