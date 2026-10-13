# MMM-KrakowMPK

Moduł MagicMirror² pokazujący odjazdy z przystanku w Krakowie na podstawie otwartych danych ZTP:
rozkład z GTFS oraz opóźnienia na żywo z GTFS-Realtime (`TripUpdates`).

## Instalacja

```bash
cd ~/MagicMirror/modules
git clone <URL_TWOJEGO_REPOZYTORIUM> MMM-KrakowMPK
```

Moduł **nie ma zależności** (nie trzeba `npm install`). Jeśli masz w katalogu stary `node_modules`
z `adm-zip`, `csv-parse` i `gtfs-realtime-bindings`, możesz go usunąć.

Dodaj do `config/config.js` i uruchom MagicMirror² ponownie:

```js
{
  module: "MMM-KrakowMPK",
  position: "top_right",
  config: {
    stops: [{ id: "8616", name: "Beskidzka 02" }],
    feeds: ["A"], // opcjonalnie: tylko ta paczka rozkładu, patrz niżej
    maxDepartures: 8,
    updateInterval: 30000,
    showDelay: true,
    showDestination: true,
  },
},
```

## Aktualizacja

```bash
cd ~/MagicMirror/modules/MMM-KrakowMPK
git pull
```

Potem uruchom MagicMirror² ponownie. Pobrany rozkład w folderze `.cache` jest używany dalej.

## Opcje

| Opcja              | Opis                                                                                                                                                       | Domyślnie               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `stops`            | Lista z jednym przystankiem: `{ id, name }`. `id` to `stop_id` **albo** `stop_code` z GTFS, `name` to tylko etykieta nagłówka. Używany jest pierwszy wpis. | `Beskidzka 02` (`8616`) |
| `feeds`            | Które paczki rozkładu przeszukać: `"A"` autobusy MPK, `"M"` autobusy Mobilis, `"T"` tramwaje. Wpisz tylko tę, w której jest Twój przystanek.              | `["A", "M", "T"]`       |
| `maxDepartures`    | Ile odjazdów pokazać.                                                                                                                                      | `8`                     |
| `lookaheadMinutes` | Jak daleko w przód szukać odjazdów (minuty).                                                                                                               | `180`                   |
| `updateInterval`   | Co ile odświeżać dane na żywo (ms, minimum 15000).                                                                                                         | `30000`                 |
| `showDelay`        | Pokazuj opóźnienie (`+2 min`) zamiast `RT` / `rozkład`.                                                                                                    | `true`                  |
| `showDestination`  | Pokazuj kierunek.                                                                                                                                          | `true`                  |

Opcje `showPlatform`, `timeFormat`, `fade` i `fadePoint` są w kodzie od pierwszej wersji, ale nic jeszcze nie robią.

### Jak znaleźć `id` przystanku

W GTFS każdy słupek ma osobny `stop_id`, a nazwa zawiera jego numer (np. `Beskidzka 02`). Wyszukaj po nazwie:

```bash
cd ~/MagicMirror/modules/MMM-KrakowMPK
npm run find-stop -- Beskidzka
```

Wynik to lista `feed`, `stop_id`, `stop_code`, `name`. Wpisz `stop_id` (lub `stop_code`) jako `id`, a literę z kolumny `feed` do `feeds`.
Pierwsze wywołanie pobiera rozkłady, więc potrwa chwilę.

## Jak to działa

- **Rozkład** (`GTFS_KRK_A/M/T.zip`) jest pobierany raz i trzymany w folderze `.cache`. Co 6 godzin moduł sprawdza,
  czy ZTP opublikował nowszy (zapytanie warunkowe, więc niezmieniony plik nie jest pobierany ponownie). Nowy rozkład jest przetwarzany
  **w tle**, a ekran dalej pokazuje poprzedni.
- Z wielkich plików czytane są tylko dane **Twojego przystanku**, strumieniowo, i zapisywane w małym pliku `.cache/stop-*.json`.
  Dzięki temu po restarcie MagicMirror² odjazdy pojawiają się od razu, bez ponownego przetwarzania rozkładu.
- **Dane na żywo** (`TripUpdates_*.pb`) są pobierane przy każdym odświeżeniu. Serwer ZTP czasem odpowiada pustym plikiem,
  więc moduł pobiera go ponownie (do 3 razy). Kilka modułów korzysta z jednego zapytania.
- Opóźnienie jest dopasowywane do kursu po `stop_sequence` (tak jak robi to `ttss_proxy.py`), a opóźnienie zgłoszone dla wcześniejszego
  przystanku jest przenoszone na dalsze. Uwzględniane są kursy odwołane i pominięte przystanki.
- Kursy kończące bieg na przystanku nie są pokazywane. Brany jest pod uwagę typ dnia (`calendar` i `calendar_dates`),
  także dla kursów po północy (czasy typu `25:10:00`).
- Odjazd bez danych na żywo jest pokazany jako `rozkład`. To nie znaczy, że pojazd jedzie punktualnie.

## Diagnostyka

Logi z prefiksem `MMM-KrakowMPK` są w terminalu, w którym działa MagicMirror² (`pm2 logs`, jeśli używasz pm2).

| Komunikat na ekranie                              | Co zrobić                                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Pobieranie / Przetwarzanie rozkładu…              | Normalne przy pierwszym uruchomieniu (lub po publikacji nowego rozkładu bez zapisanych danych). Poczekaj.                  |
| Nie znaleziono przystanku…                        | Sprawdź `id` przez `npm run find-stop`.                                                                                    |
| Brak danych na żywo ZTP — wyświetlam rozkład.     | Serwer danych na żywo nie odpowiedział lub oddał pusty plik. Rozkład jest pokazany, a opóźnienia wrócą same.               |
| Brak prognoz na żywo dla tych kursów              | Dane na żywo są, ale nie obejmują tych kursów (np. kursy dopiero się zaczynają).                                           |
| Dane na żywo sprzed N min.                        | Strumień ZTP przestał się odświeżać.                                                                                       |

Aby wymusić ponowne pobranie i przetworzenie rozkładu, usuń folder `.cache` i uruchom ponownie.

## Rozwój

```bash
npm install
npm run lint
npm test
```

Testy działają na lokalnej atrapie serwera ZTP i plikach w `test/fixtures` (wygenerowanych skryptem `generate.py` przez
niezależne narzędzia: `zipfile` i oficjalną bibliotekę protobuf), więc nie potrzebują internetu.

`ttss_proxy.py` to niezależny skrypt pomocniczy dla ESP32. Moduł z niego nie korzysta.
