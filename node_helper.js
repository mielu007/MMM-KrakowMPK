const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const BASE = "https://gtfs.ztp.krakow.pl/";
const FEEDS = ["A", "M", "T"];
const STATIC_TTL_MS = 6 * 60 * 60 * 1000;
const REALTIME_TTL_MS = 25 * 1000;

function getBuffer(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "MMM-KrakowMPK/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getBuffer(new URL(res.headers.location, url).toString(), timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} dla ${url}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout: ${url}`)));
    req.on("error", reject);
  });
}

function csvRows(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return [];
  return parse(entry.getData().toString("utf8").replace(/^\uFEFF/, ""), {
    columns: true, skip_empty_lines: true, relax_quotes: true, bom: true
  });
}

function parseGtfsTime(value) {
  if (!value) return null;
  const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function localDateParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return { ymd: `${parts.year}${parts.month}${parts.day}`, dow, seconds: +parts.hour * 3600 + +parts.minute * 60 + +parts.second };
}

function dateToUtcSeconds(dateYmd, gtfsSeconds) {
  // GTFS service-day times may exceed 24:00. Construct service day in Europe/Warsaw
  // by matching the local calendar date/time rather than assuming UTC.
  const [y, m, d] = [dateYmd.slice(0,4), dateYmd.slice(4,6), dateYmd.slice(6,8)].map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const midnight = new Date(base);
  midnight.setUTCHours(0, 0, 0, 0);
  // Find UTC instant corresponding to local midnight using Intl timezone offset.
  const target = `${dateYmd.slice(0,4)}-${dateYmd.slice(4,6)}-${dateYmd.slice(6,8)}T00:00:00`;
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23" }).formatToParts(new Date(guess));
    const p = Object.fromEntries(parts.map(x => [x.type,x.value]));
    const seen = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    const wanted = Date.UTC(y,m-1,d,0,0,0);
    guess += wanted - seen;
  }
  return Math.floor(guess / 1000) + gtfsSeconds;
}

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.staticCache = new Map();
    this.realtimeCache = new Map();
    this.busy = false;
    console.log("[MMM-KrakowMPK] helper uruchomiony");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "KRAKOWMPK_CONFIG") {
      this.config = payload || {};
      this.refresh();
    } else if (notification === "KRAKOWMPK_REFRESH") {
      this.refresh();
    }
  },

  async loadStatic(feed) {
    const cached = this.staticCache.get(feed);
    if (cached && Date.now() - cached.loadedAt < STATIC_TTL_MS) return cached;
    const url = `${BASE}GTFS_KRK_${feed}.zip`;
    const buffer = await getBuffer(url);
    const zip = new AdmZip(buffer);
    const rows = {
      stops: csvRows(zip, "stops.txt"),
      routes: csvRows(zip, "routes.txt"),
      trips: csvRows(zip, "trips.txt"),
      stopTimes: csvRows(zip, "stop_times.txt"),
      calendar: csvRows(zip, "calendar.txt"),
      calendarDates: csvRows(zip, "calendar_dates.txt")
    };
    const result = { ...rows, loadedAt: Date.now(), feed };
    this.staticCache.set(feed, result);
    console.log(`[MMM-KrakowMPK] GTFS ${feed}: ${rows.stops.length} przystanków`);
    return result;
  },

  async loadRealtime(feed) {
    const cached = this.realtimeCache.get(feed);
    if (cached && Date.now() - cached.loadedAt < REALTIME_TTL_MS) return cached;
    const url = `${BASE}TripUpdates_${feed}.pb`;
    const buffer = await getBuffer(url);
    const decoded = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
    const result = { entities: decoded.entity || [], loadedAt: Date.now(), feed };
    this.realtimeCache.set(feed, result);
    return result;
  },

  isServiceActive(data, ymd, dow) {
    const calendar = data.calendar.find(c => c.service_id && c.start_date <= ymd && c.end_date >= ymd &&
      c[["", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][dow]] === "1");
    const exceptions = data.calendarDates.filter(c => c.date === ymd);
    const removed = exceptions.some(c => c.exception_type === "2");
    const added = exceptions.some(c => c.exception_type === "1");
    return added || (!removed && !!calendar);
  },

  async refresh() {
    if (this.busy || !this.config) return;
    this.busy = true;
    try {
      const stopConfig = (this.config.stops && this.config.stops[0]) || { id: "8616", name: "Beskidzka 02" };
      const now = new Date();
      const local = localDateParts(now);
      const stopId = String(stopConfig.id);
      const all = [];

      for (const feed of FEEDS) {
        try {
          const data = await this.loadStatic(feed);
          const stop = data.stops.find(s => String(s.stop_id) === stopId || String(s.stop_code) === stopId);
          if (!stop) {
            console.log(`[MMM-KrakowMPK] przystanek ${stopId} nie znaleziony w GTFS ${feed}`);
            continue;
          }
          const stopIds = new Set([String(stop.stop_id)]);
          // Some feeds use parent station / platform identifiers; keep exact stop first.
          const stopTimes = data.stopTimes.filter(st => stopIds.has(String(st.stop_id)));
          const tripsById = new Map(data.trips.map(t => [String(t.trip_id), t]));
          const routesById = new Map(data.routes.map(r => [String(r.route_id), r]));
          const rt = await this.loadRealtime(feed).catch(err => {
            console.warn(`[MMM-KrakowMPK] RT ${feed}: ${err.message}`);
            return { entities: [], loadedAt: 0 };
          });
          const realtimeByTrip = new Map();
          for (const entity of rt.entities) {
            const tu = entity.tripUpdate;
            if (!tu || !tu.trip) continue;
            const tripId = String(tu.trip.tripId || "");
            if (!tripId) continue;
            const updates = tu.stopTimeUpdate || [];
            const matching = updates.find(u => u.stopId && (String(u.stopId) === String(stop.stop_id) || String(u.stopId) === stopId));
            if (matching) realtimeByTrip.set(tripId, { update: matching, tripUpdate: tu, fetchedAt: rt.loadedAt });
          }

          const tripTimes = new Map();
          for (const st of stopTimes) {
            const sec = parseGtfsTime(st.departure_time || st.arrival_time);
            if (sec === null) continue;
            const trip = tripsById.get(String(st.trip_id));
            if (!trip || !this.isServiceActive(data, local.ymd, local.dow)) continue;
            const departureEpoch = dateToUtcSeconds(local.ymd, sec);
            // Include services extending past midnight; GTFS times > 24:00 are supported.
            if (departureEpoch < Math.floor(now.getTime()/1000) - 60 || departureEpoch > Math.floor(now.getTime()/1000) + 3*3600) continue;
            const route = routesById.get(String(trip.route_id)) || {};
            const rtMatch = realtimeByTrip.get(String(st.trip_id));
            let predictedEpoch = null, delayMinutes = null, realtime = false;
            if (rtMatch) {
              const u = rtMatch.update;
              const event = u.departure || u.arrival;
              if (event && event.time != null) {
                predictedEpoch = Number(event.time);
                delayMinutes = Math.round((predictedEpoch - departureEpoch) / 60);
                realtime = true;
              } else if (event && event.delay != null) {
                delayMinutes = Math.round(Number(event.delay) / 60);
                predictedEpoch = departureEpoch + Number(event.delay);
                realtime = true;
              }
            }
            const shownEpoch = predictedEpoch || departureEpoch;
            const minutes = Math.max(0, Math.round((shownEpoch - now.getTime()/1000)/60));
            const destination = trip.trip_headsign || trip.trip_short_name || "";
            tripTimes.set(`${st.trip_id}_${st.stop_sequence}`, {
              route: route.route_short_name || route.route_id || "?",
              destination,
              scheduled: this.formatEpoch(departureEpoch),
              minutes,
              minutesText: minutes <= 0 ? "teraz" : `za ${minutes} min`,
              delayMinutes: realtime ? delayMinutes : null,
              realtime,
              _epoch: shownEpoch,
              _feed: feed
            });
          }
          all.push(...tripTimes.values());
        } catch (err) {
          console.warn(`[MMM-KrakowMPK] GTFS ${feed}: ${err.message}`);
        }
      }

      all.sort((a,b) => a._epoch - b._epoch);
      const unique = [];
      const seen = new Set();
      for (const d of all) {
        const key = `${d.route}|${d.scheduled}|${d.destination}`;
        if (!seen.has(key)) { seen.add(key); unique.push(d); }
      }
      const departures = unique.slice(0, this.config.maxDepartures || 8).map(({_epoch,_feed,...d}) => d);
      let status = departures.length ? "" : `Brak odjazdów dla ID ${stopId}. Sprawdź stop_id/stop_code i dostępność GTFS.`;
      if (departures.length && !departures.some(d => d.realtime)) status = "Brak prognoz RT dla tych kursów — wyświetlam rozkład.";
      const rtTimes = [...this.realtimeCache.values()].map(x => x.loadedAt).filter(Boolean);
      this.sendSocketNotification("KRAKOWMPK_DATA", {
        departures, status,
        lastUpdated: new Intl.DateTimeFormat("pl-PL", { timeZone:"Europe/Warsaw", hour:"2-digit", minute:"2-digit", second:"2-digit" }).format(new Date()),
        realtimeAgeSeconds: rtTimes.length ? Math.round((Date.now() - Math.max(...rtTimes))/1000) : null
      });
    } catch (err) {
      console.error("[MMM-KrakowMPK]", err);
      this.sendSocketNotification("KRAKOWMPK_DATA", {
        departures: [], status: `Błąd pobierania danych: ${err.message}`, lastUpdated: null
      });
    } finally {
      this.busy = false;
    }
  },

  formatEpoch(epoch) {
    return new Intl.DateTimeFormat("pl-PL", {
      timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(epoch * 1000));
  }
});
