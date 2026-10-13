# MMM-KrakowMPK

Moduł MagicMirror² pokazujący odjazdy z przystanku na podstawie GTFS ZTP Kraków oraz opóźnienia z GTFS-Realtime.

## Status

Pierwsza wersja testowa. Moduł pobiera trzy paczki GTFS (`A`, `M`, `T`) i trzy strumienie `TripUpdates`. Identyfikator przystanku jest dopasowywany do `stop_id` lub `stop_code`. Dane RT mogą nie zawierać prognozy dla każdego kursu; w takim przypadku moduł jawnie pokazuje rozkład, a nie fikcyjne opóźnienie.

## Instalacja

W katalogu instalacji MagicMirror²:

```bash
cd ~/MagicMirror/modules
git clone <URL_TWOJEGO_REPOZYTORIUM> MMM-KrakowMPK
cd MMM-KrakowMPK
npm install --omit=dev
```

Jeżeli kopiujesz katalog ręcznie, pomiń `git clone`.

Następnie dodaj do `config/config.js`:

```js
{
  module: "MMM-KrakowMPK",
  position: "top_right",
  config: {
    stops: [{ id: "8616", name: "Beskidzka 02" }],
    maxDepartures: 8,
    updateInterval: 30000,
    showDelay: true,
    showDestination: true
  }
},
```

Uruchom ponownie MagicMirror².

## Wymagania

- Aktualne MagicMirror² i wersja Node.js zgodna z używaną instalacją MM.
- Dostęp wychodzący HTTPS do `gtfs.ztp.krakow.pl`.
- Pakiety z `package.json` instalowane przez `npm install`.

## Jak działa

- Pliki statyczne `GTFS_KRK_A.zip`, `GTFS_KRK_M.zip`, `GTFS_KRK_T.zip` są buforowane przez 6 godzin.
- Pliki `TripUpdates_A.pb`, `TripUpdates_M.pb`, `TripUpdates_T.pb` są buforowane do 25 sekund.
- Czas rozkładowy jest interpretowany w strefie `Europe/Warsaw`.
- Opóźnienie jest pokazywane tylko wtedy, gdy istnieje pasująca aktualizacja dla konkretnego kursu i przystanku.
- Brak aktualizacji RT nie oznacza, że pojazd jedzie punktualnie.

## Diagnostyka

Uruchom MagicMirror z terminala i sprawdź logi `[MMM-KrakowMPK]`. Jeśli nie pojawiają się odjazdy, sprawdź czy `8616` występuje jako `stop_id` lub `stop_code` w aktualnej paczce GTFS. W zależności od publikacji ZTP identyfikator z tabliczki może nie być identyfikatorem platformy w GTFS-Realtime.

## Uwaga do wersji testowej

Format i dostępność źródeł ZTP mogą się zmieniać. Przed uznaniem modułu za gotowy do codziennego użytku trzeba przetestować go na aktualnych plikach ZTP i potwierdzić mapowanie ID przystanku oraz kursów RT.
