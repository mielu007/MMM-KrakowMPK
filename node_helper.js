"use strict";

const path = require("node:path");

const NodeHelper = require("node_helper");
const Log = require("logger");

const { StopBoard } = require("./lib/stop-board");

const BASE_URL = "https://gtfs.ztp.krakow.pl/";
const DEFAULT_STOP = { id: "8616", name: "Beskidzka 02" };
// The realtime feed is 'stale' when its own timestamp is older than this.
const STALE_REALTIME_SECONDS = 5 * 60;

const pl = new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Text for the screen when there is no list of departures to show. */
function errorStatus(error, stop) {
  switch (error.code) {
    case "STOP_NOT_FOUND":
      return `Nie znaleziono przystanku "${stop.id}" (stop_id lub stop_code) w rozkładach ZTP.`;
    case "STOP_AMBIGUOUS":
      return `Identyfikator "${stop.id}" pasuje do kilku przystanków, sprawdź log.`;
    case "CONNECTION":
    case "SCHEDULE_UNAVAILABLE":
    case "BAD_RESPONSE":
      return "Nie udało się pobrać rozkładu ZTP. Sprawdź połączenie z internetem.";
    default:
      return `Błąd: ${error.message}`;
  }
}

/** The note shown under the heading about the state of the live data. */
function departuresStatus({ departures, realtime }, lookaheadMinutes) {
  if (departures.length === 0) {
    return `Brak odjazdów w najbliższych ${lookaheadMinutes} min.`;
  }
  if (!realtime.available) {
    return "Brak danych na żywo ZTP — wyświetlam rozkład.";
  }
  if (departures.every((departure) => !departure.realtime)) {
    return "Brak prognoz na żywo dla tych kursów — wyświetlam rozkład.";
  }
  if (realtime.ageSeconds !== null && realtime.ageSeconds > STALE_REALTIME_SECONDS) {
    return `Dane na żywo sprzed ${Math.round(realtime.ageSeconds / 60)} min.`;
  }
  return "";
}

module.exports = NodeHelper.create({
  start() {
    Log.info(`Starting node helper for: ${this.name}`);
    // Downloaded timetables and the processed data of the stop are kept here between restarts.
    this.cacheDir = path.join(__dirname, ".cache");
    // identifier of a module instance -> { board, config, stop }
    this.instances = new Map();
    // instances with a request currently running
    this.busy = new Set();
  },

  socketNotificationReceived(notification, payload) {
    if (!payload || !payload.identifier) {
      return;
    }
    if (notification === "KRAKOWMPK_CONFIG") {
      this.configure(payload.identifier, payload.config || {});
      this.refresh(payload.identifier);
    } else if (notification === "KRAKOWMPK_REFRESH") {
      this.refresh(payload.identifier);
    }
  },

  configure(identifier, config) {
    const stop = (config.stops && config.stops[0]) || DEFAULT_STOP;

    this.instances.set(identifier, {
      config,
      stop,
      board: new StopBoard({
        baseUrl: BASE_URL,
        cacheDir: this.cacheDir,
        groups: Array.isArray(config.feeds) && config.feeds.length > 0 ? config.feeds : undefined,
        stopIds: [String(stop.id)],
        lookaheadMinutes: config.lookaheadMinutes || undefined,
        onProgress: (status) => this.send(identifier, { departures: [], status })
      })
    });
  },

  send(identifier, payload) {
    this.sendSocketNotification("KRAKOWMPK_DATA", { identifier, lastUpdated: null, ...payload });
  },

  async refresh(identifier) {
    const instance = this.instances.get(identifier);
    if (!instance || this.busy.has(identifier)) {
      return; // unknown instance, or the previous request (e.g. the first load) is still running
    }
    this.busy.add(identifier);

    const { board, config, stop } = instance;
    try {
      const result = await board.update();
      for (const warning of result.warnings) {
        Log.warn(`${this.name}: ${warning}`);
      }

      const departures = result.departures.slice(0, config.maxDepartures || 8).map((departure) => ({
        route: departure.line,
        destination: departure.direction,
        scheduled: departure.scheduledAt,
        minutes: departure.minutes,
        minutesText: departure.minutes <= 0 ? "teraz" : `za ${departure.minutes} min`,
        delayMinutes: departure.realtime ? Math.round(departure.delaySeconds / 60) : null,
        realtime: departure.realtime
      }));

      this.send(identifier, {
        departures,
        status: departuresStatus(result, board.lookaheadMinutes),
        lastUpdated: pl.format(new Date()),
        realtimeAgeSeconds: result.realtime.ageSeconds
      });
    } catch (error) {
      Log.error(`${this.name}: ${error.message}`);
      this.send(identifier, { departures: [], status: errorStatus(error, stop) });
    } finally {
      this.busy.delete(identifier);
    }
  }
});
