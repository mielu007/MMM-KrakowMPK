#!/usr/bin/env python3
"""
Pośrednik: GTFS-Realtime ZTP Kraków -> mały JSON dla ESP32.

Instalacja:   pip install gtfs-realtime-bindings
Test:         python3 ttss_proxy.py once      (wypisuje JSON i kończy)
Serwer:       python3 ttss_proxy.py           (http://0.0.0.0:8099/departures)
"""
import csv, io, json, os, sys, tempfile, threading, time, urllib.request, zipfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from zoneinfo import ZoneInfo

from google.transit import gtfs_realtime_pb2

# ---------------- KONFIGURACJA ----------------
STOP_ID   = "8616"           # stop_id z GTFS (Beskidzka 02, stop_code 832-02)
LINES     = {"174", "179"}
BASE      = "https://gtfs.ztp.krakow.pl/"
STATIC_URL = BASE + "GTFS_KRK_A.zip"
RT_URL     = BASE + "TripUpdates_A.pb"
PORT       = 8099
RT_EVERY   = 20               # s
STATIC_EVERY = 12 * 3600      # s
HORIZON    = 60 * 60          # pokazuj odjazdy do 60 min naprzód
MAX_ITEMS  = 8
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gtfs_cache.json")
TZ = ZoneInfo("Europe/Warsaw")
UA = {"User-Agent": "ttss-eink-proxy/1.0"}
# -----------------------------------------------

state = {"payload": json.dumps({"updated": 0, "error": "start", "departures": []}).encode()}
static = None


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_secs(s):
    h, m, sec = s.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


def read_csv(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def load_static_from_zip(path):
    with zipfile.ZipFile(path) as z:
        ids = set()
        for r in read_csv(z, "stops.txt"):
            if r.get("stop_id") == STOP_ID or (r.get("stop_code") or "") == STOP_ID:
                ids.add(r["stop_id"])
        if not ids:
            raise RuntimeError(f"Nie znaleziono stop_id/stop_code '{STOP_ID}' w stops.txt")

        short = {r["route_id"]: r["route_short_name"] for r in read_csv(z, "routes.txt")}
        trips = {}
        for r in read_csv(z, "trips.txt"):
            line = short.get(r["route_id"], "")
            if line in LINES:
                trips[r["trip_id"]] = (line, r.get("trip_headsign", ""))

        sched = {}
        for r in read_csv(z, "stop_times.txt"):
            if r["stop_id"] in ids and r["trip_id"] in trips:
                t = r.get("departure_time") or r.get("arrival_time")
                if t:
                    sched[r["trip_id"]] = (int(r["stop_sequence"]), parse_secs(t))
    return {"ids": sorted(ids), "trips": trips, "sched": sched, "loaded": time.time()}


def get_static(force=False):
    global static
    if not force and static and time.time() - static["loaded"] < STATIC_EVERY:
        return static
    if not force and os.path.exists(CACHE_FILE) and (
            time.time() - os.path.getmtime(CACHE_FILE) < STATIC_EVERY):
        with open(CACHE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        d["sched"] = {k: tuple(v) for k, v in d["sched"].items()}
        d["trips"] = {k: tuple(v) for k, v in d["trips"].items()}
        static = d
        return static
    print("Pobieram statyczny GTFS...", file=sys.stderr)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    try:
        tmp.write(http_get(STATIC_URL, timeout=120))
        tmp.close()
        static = load_static_from_zip(tmp.name)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(static, f, ensure_ascii=False)
    print(f"GTFS ok: stop_id={static['ids']}, kursów={len(static['sched'])}", file=sys.stderr)
    return static


def service_start_ts(yyyymmdd):
    d = datetime.strptime(yyyymmdd, "%Y%m%d")
    noon = datetime(d.year, d.month, d.day, 12, tzinfo=TZ)
    return noon.timestamp() - 12 * 3600  # definicja GTFS: południe minus 12 h


def ev_time(u):
    for ev in (u.departure, u.arrival):
        if ev.HasField("time") and ev.time:
            return ev.time
    return None


def ev_delay(u):
    for ev in (u.departure, u.arrival):
        if ev.HasField("delay"):
            return ev.delay
    return None


def build(st, feed, now):
    ids = set(st["ids"])
    out = []
    for ent in feed.entity:
        if not ent.HasField("trip_update"):
            continue
        tu = ent.trip_update
        tid = tu.trip.trip_id
        if tid not in st["sched"]:
            continue
        if tu.trip.schedule_relationship == tu.trip.CANCELED:
            continue
        seq, secs = st["sched"][tid]
        sd = tu.trip.start_date or datetime.fromtimestamp(now, TZ).strftime("%Y%m%d")
        sched_ts = service_start_ts(sd) + secs

        exp_ts, rt, skipped = sched_ts, False, False
        direct, prev = None, None
        for u in tu.stop_time_update:
            if u.stop_id in ids or (u.HasField("stop_sequence") and u.stop_sequence == seq):
                direct = u
            elif u.HasField("stop_sequence") and u.stop_sequence < seq:
                if prev is None or u.stop_sequence > prev.stop_sequence:
                    prev = u
        if direct is not None:
            if direct.schedule_relationship == direct.SKIPPED:
                skipped = True
            else:
                t = ev_time(direct)
                d = ev_delay(direct)
                if t:
                    exp_ts, rt = t, True
                elif d is not None:
                    exp_ts, rt = sched_ts + d, True
        elif prev is not None and prev.schedule_relationship != prev.SKIPPED:
            d = ev_delay(prev)          # opóźnienie przenosi się na kolejne przystanki
            if d is not None:
                exp_ts, rt = sched_ts + d, True
        if skipped:
            continue
        if not (now - 90 <= exp_ts <= now + HORIZON):
            continue
        line, head = st["trips"][tid]
        out.append({
            "line": line,
            "dir": head,
            "time": datetime.fromtimestamp(exp_ts, TZ).strftime("%H:%M"),
            "in_min": max(0, int((exp_ts - now) // 60)),
            "delay_min": round((exp_ts - sched_ts) / 60),
            "rt": rt,
            "_ts": exp_ts,
        })
    out.sort(key=lambda x: x["_ts"])
    for o in out:
        del o["_ts"]
    return out[:MAX_ITEMS]


def refresh():
    st = get_static()
    raw = b""
    for _ in range(3):
        raw = http_get(RT_URL, timeout=15)
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(raw)
        if feed.entity and feed.header.timestamp:
            break
        time.sleep(2)
    else:
        raise RuntimeError(f"Pusty feed realtime (bajtow: {len(raw)})")
    now = time.time()
    common = [e for e in feed.entity
              if e.HasField("trip_update") and e.trip_update.trip.trip_id in st["sched"]]
    print(f"feed: {len(feed.entity)} kursow, na naszym slupku: {len(common)}", file=sys.stderr)
    deps = build(st, feed, now)
    return {"updated": int(now), "feed_ts": int(feed.header.timestamp), "departures": deps}


def worker():
    while True:
        try:
            res = refresh()
            state["payload"] = json.dumps(res, ensure_ascii=False).encode("utf-8")
        except Exception as e:  # noqa
            print("Błąd odświeżania:", e, file=sys.stderr)
            try:
                d = json.loads(state["payload"])
            except Exception:
                d = {"departures": []}
            d["error"] = str(e)
            state["payload"] = json.dumps(d, ensure_ascii=False).encode("utf-8")
        time.sleep(RT_EVERY)


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/departures"):
            body = state["payload"]
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "once":
        print(json.dumps(refresh(), ensure_ascii=False, indent=2))
    else:
        threading.Thread(target=worker, daemon=True).start()
        print(f"Serwer na :{PORT}/departures", file=sys.stderr)
        HTTPServer(("0.0.0.0", PORT), H).serve_forever()
