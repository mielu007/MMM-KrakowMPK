#!/usr/bin/env python3
"""Generates the GTFS / GTFS-Realtime fixtures used by the tests.

Everything here is produced with independent tools (Python's zipfile and the
official protobuf runtime), so the JavaScript readers are tested against data
they did not write themselves.

Run:  python3 test/fixtures/generate.py
Needs: pip install protobuf

The scenario "now" used by the tests is Tuesday 2026-10-13 14:15:00 Europe/Warsaw.
"""
import os
import zipfile
from datetime import datetime
from zoneinfo import ZoneInfo

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

HERE = os.path.dirname(os.path.abspath(__file__))
WARSAW = ZoneInfo("Europe/Warsaw")


def epoch(hour, minute, second=0, day=13):
    return int(datetime(2026, 10, day, hour, minute, second, tzinfo=WARSAW).timestamp())


# ---------------------------------------------------------------------------
# GTFS-Realtime message classes, built from the field numbers of gtfs-realtime.proto
# ---------------------------------------------------------------------------

F = descriptor_pb2.FieldDescriptorProto


def build_classes():
    proto = descriptor_pb2.FileDescriptorProto(name="gtfs-rt-test.proto", package="transit_realtime", syntax="proto2")

    def message(name, fields):
        m = proto.message_type.add(name=name)
        for number, fname, ftype, label, type_name in fields:
            f = m.field.add(name=fname, number=number, type=ftype, label=label)
            if type_name:
                f.type_name = ".transit_realtime." + type_name
        return m

    opt, rep = F.LABEL_OPTIONAL, F.LABEL_REPEATED
    message("FeedHeader", [
        (1, "gtfs_realtime_version", F.TYPE_STRING, opt, None),
        (2, "incrementality", F.TYPE_INT32, opt, None),
        (3, "timestamp", F.TYPE_UINT64, opt, None),
    ])
    message("TripDescriptor", [
        (1, "trip_id", F.TYPE_STRING, opt, None),
        (2, "start_time", F.TYPE_STRING, opt, None),
        (3, "start_date", F.TYPE_STRING, opt, None),
        (4, "schedule_relationship", F.TYPE_INT32, opt, None),
        (5, "route_id", F.TYPE_STRING, opt, None),
        (6, "direction_id", F.TYPE_UINT32, opt, None),
    ])
    message("StopTimeEvent", [
        (1, "delay", F.TYPE_INT32, opt, None),
        (2, "time", F.TYPE_INT64, opt, None),
        (3, "uncertainty", F.TYPE_INT32, opt, None),
    ])
    message("StopTimeUpdate", [
        (1, "stop_sequence", F.TYPE_UINT32, opt, None),
        (2, "arrival", F.TYPE_MESSAGE, opt, "StopTimeEvent"),
        (3, "departure", F.TYPE_MESSAGE, opt, "StopTimeEvent"),
        (4, "stop_id", F.TYPE_STRING, opt, None),
        (5, "schedule_relationship", F.TYPE_INT32, opt, None),
    ])
    message("VehicleDescriptor", [
        (1, "id", F.TYPE_STRING, opt, None),
        (2, "label", F.TYPE_STRING, opt, None),
    ])
    message("TripUpdate", [
        (1, "trip", F.TYPE_MESSAGE, opt, "TripDescriptor"),
        (2, "stop_time_update", F.TYPE_MESSAGE, rep, "StopTimeUpdate"),
        (3, "vehicle", F.TYPE_MESSAGE, opt, "VehicleDescriptor"),
        (4, "timestamp", F.TYPE_UINT64, opt, None),
        (5, "delay", F.TYPE_INT32, opt, None),
    ])
    # Fields the decoder must skip: a vehicle position stub and an alert stub.
    message("VehiclePosition", [(5, "current_stop_sequence", F.TYPE_UINT32, opt, None)])
    message("FeedEntity", [
        (1, "id", F.TYPE_STRING, opt, None),
        (2, "is_deleted", F.TYPE_BOOL, opt, None),
        (3, "trip_update", F.TYPE_MESSAGE, opt, "TripUpdate"),
        (4, "vehicle", F.TYPE_MESSAGE, opt, "VehiclePosition"),
    ])
    message("FeedMessage", [
        (1, "header", F.TYPE_MESSAGE, opt, "FeedHeader"),
        (2, "entity", F.TYPE_MESSAGE, rep, "FeedEntity"),
    ])

    pool = descriptor_pool.DescriptorPool()
    pool.Add(proto)
    return {
        name: message_factory.GetMessageClass(pool.FindMessageTypeByName("transit_realtime." + name))
        for name in ["FeedMessage", "FeedEntity"]
    }


CLASSES = build_classes()


def feed(entities):
    msg = CLASSES["FeedMessage"]()
    msg.header.gtfs_realtime_version = "2.0"
    msg.header.incrementality = 0
    msg.header.timestamp = epoch(14, 14, 30)
    for i, build in enumerate(entities):
        entity = msg.entity.add(id=str(i))
        build(entity)
    return msg.SerializeToString()


def trip_update(trip_id, start_date="20261013", relationship=None, delay=None, updates=()):
    def build(entity):
        tu = entity.trip_update
        tu.trip.trip_id = trip_id
        if start_date:
            tu.trip.start_date = start_date
        if relationship is not None:
            tu.trip.schedule_relationship = relationship
        if delay is not None:
            tu.delay = delay
        for update in updates:
            u = tu.stop_time_update.add()
            if "seq" in update:
                u.stop_sequence = update["seq"]
            if "stop_id" in update:
                u.stop_id = update["stop_id"]
            if "arr_delay" in update:
                u.arrival.delay = update["arr_delay"]
            if "dep_delay" in update:
                u.departure.delay = update["dep_delay"]
            if "dep_time" in update:
                u.departure.time = update["dep_time"]
            if "relationship" in update:
                u.schedule_relationship = update["relationship"]
    return build


def vehicle_only(entity):
    entity.vehicle.current_stop_sequence = 3  # must be ignored by the decoder


# ---------------------------------------------------------------------------
# Tram feed (T)
# ---------------------------------------------------------------------------

T_STOPS = (
    "\ufeffstop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
    "1001,BAG01,Teatr Bagatela,50.0620,19.9340,0,\n"
    "1002,BAG02,Teatr Bagatela,50.0621,19.9341,0,\n"
    "1003,BAG03,Teatr Bagatela Wschód,50.0625,19.9350,0,\n"
    "2001,DWG01,Dworzec Główny,50.0680,19.9450,0,\n"
    "3001,LOB01,Łobzów,50.0700,19.9200,0,\n"
    '4001,PLI01,"Plac Inwalidów, perony",50.0700,19.9220,0,\n'
    "5000,,Rondo Mogilskie,50.0600,19.9600,1,\n"
    "5001,RMO01,Rondo Mogilskie 01,50.0600,19.9600,0,5000\n"
)

T_ROUTES = (
    "route_id,agency_id,route_short_name,route_long_name,route_type\n"
    'R18,MPK,18,"Czerwone Maki P+R - Bagatela",0\n'
    'R52,MPK,52,"Salwator - Dworzec\nGłówny",0\n'
)

# CRLF line endings on purpose
T_TRIPS = (
    "route_id,service_id,trip_id,trip_headsign,direction_id\r\n"
    "R18,WK,T1,Czerwone Maki P+R,0\r\n"
    "R52,WK,T2,Salwator,1\r\n"
    "R18,WK,T3,Bagatela,0\r\n"
    "R18,WK,T5,Czerwone Maki P+R,0\r\n"
    "R18,WE,T6,Czerwone Maki P+R,0\r\n"
    "R52,WK,T7,Salwator,1\r\n"
    "R52,WK,T8,Salwator,1\r\n"
    "R18,WK,T9,Rondo Mogilskie,0\r\n"
)

T_STOP_TIMES = (
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    "T1,14:10:00,14:10:00,2001,1\n"
    "T1,14:20:00,14:20:00,1001,2\n"
    "T1,14:30:00,14:30:00,3001,3\n"
    "T2,14:30:00,14:30:00,3001,1\n"
    "T2,14:42:00,14:42:00,1002,2\n"
    "T2,14:50:00,14:50:00,2001,3\n"
    "T3,14:00:00,14:00:00,3001,1\n"
    "T3,14:25:00,14:25:00,1001,2\n"
    "T5,23:50:00,23:50:00,3001,1\n"
    "T5,24:05:00,24:10:00,1001,2\n"
    "T5,24:20:00,24:20:00,2001,3\n"
    "T6,14:10:00,14:10:00,2001,1\n"
    "T6,14:20:00,14:20:00,1001,2\n"
    "T6,14:30:00,14:30:00,3001,3\n"
    "T7,14:25:00,14:25:00,3001,1\n"
    "T7,14:35:00,14:35:00,1002,2\n"
    "T7,14:45:00,14:45:00,2001,3\n"
    "T8,14:35:00,14:35:00,3001,1\n"
    "T8,14:45:00,,1001,2\n"
    "T8,14:55:00,14:55:00,2001,3\n"
    "T9,14:15:00,14:15:00,3001,1\n"
    "T9,14:22:00,14:22:00,5001,2\n"
    "T9,14:30:00,14:30:00,2001,3\n"
)

CALENDAR = (
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
    "WK,1,1,1,1,1,0,0,20260101,20261231\n"
    "WE,0,0,0,0,0,1,1,20260101,20261231\n"
)

CALENDAR_DATES = (
    "service_id,date,exception_type\n"
    "WK,20261111,2\n"
    "WE,20261111,1\n"
)

# ---------------------------------------------------------------------------
# Bus feed (A)
# ---------------------------------------------------------------------------

A_STOPS = (
    "stop_id,stop_name,stop_lat,stop_lon\n"
    "9001,Teatr Bagatela,50.0620,19.9340\n"
    "9002,Inny przystanek,50.0700,19.9400\n"
)

A_ROUTES = (
    "route_id,route_short_name,route_long_name,route_type\n"
    '124,124,"Rondo Grunwaldzkie - Bagatela",3\n'
)

A_TRIPS = (
    "route_id,service_id,trip_id,trip_headsign,direction_id\n"
    "124,WK,B1,Rondo Grunwaldzkie,0\n"
    "124,WK,B2,Rondo Grunwaldzkie,0\n"
    "124,WK,B3,Rondo Grunwaldzkie,0\n"
    "124,WK,B4,Rondo Grunwaldzkie,0\n"
)

A_STOP_TIMES = (
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    "B1,14:10:00,14:10:00,9002,1\n"
    "B1,14:18:00,14:18:00,9001,2\n"
    "B1,14:25:00,14:25:00,9002,3\n"
    "B2,14:22:00,14:22:00,9002,1\n"
    "B2,14:30:00,14:30:00,9001,2\n"
    "B2,14:37:00,14:37:00,9002,3\n"
    "B3,14:32:00,14:32:00,9002,1\n"
    "B3,14:40:00,14:40:00,9001,2\n"
    "B3,14:47:00,14:47:00,9002,3\n"
    "B4,14:42:00,14:42:00,9002,1\n"
    "B4,14:50:00,14:50:00,9001,2\n"
    "B4,14:57:00,14:57:00,9002,3\n"
)


def write_zip(name, files):
    """files: list of (entry name, text, compression)"""
    path = os.path.join(HERE, name)
    with zipfile.ZipFile(path, "w") as z:
        for entry, text, compression in files:
            info = zipfile.ZipInfo(entry, date_time=(2026, 10, 12, 11, 49, 1))
            info.compress_type = compression
            z.writestr(info, text.encode("utf-8"))
    return path


D, S = zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED

write_zip("GTFS_KRK_T.zip", [
    ("stops.txt", T_STOPS, D),
    ("routes.txt", T_ROUTES, D),
    ("trips.txt", T_TRIPS, D),
    ("stop_times.txt", T_STOP_TIMES, D),
    ("calendar.txt", CALENDAR, D),
    ("calendar_dates.txt", CALENDAR_DATES, D),
])

# The bus archive keeps entries uncompressed and in a sub-folder, to cover both zip variants.
write_zip("GTFS_KRK_A.zip", [
    ("gtfs/stops.txt", A_STOPS, S),
    ("gtfs/routes.txt", A_ROUTES, D),
    ("gtfs/trips.txt", A_TRIPS, D),
    ("gtfs/stop_times.txt", A_STOP_TIMES, D),
    ("gtfs/calendar.txt", CALENDAR, S),
])

with open(os.path.join(HERE, "TripUpdates_T.pb"), "wb") as f:
    f.write(feed([
        vehicle_only,
        # T1 runs 2 minutes late at our stop
        trip_update("T1", updates=[{"seq": 2, "stop_id": "1001", "arr_delay": 120, "dep_delay": 120}]),
        # T7 is cancelled
        trip_update("T7", relationship=3),
        # T8 does not call at our stop today
        trip_update("T8", updates=[{"seq": 2, "relationship": 1}]),
    ]))

with open(os.path.join(HERE, "TripUpdates_A.pb"), "wb") as f:
    f.write(feed([
        # B1 yesterday's run, 10 minutes late: must not leak into today's departure
        trip_update("B1", start_date="20261012", updates=[{"seq": 2, "dep_delay": 600}]),
        # B1 today: absolute predicted time 14:19:30
        trip_update("B1", updates=[{"seq": 2, "dep_time": epoch(14, 19, 30)}]),
        # B2: only an earlier stop is known, the 60 s delay carries on to our stop
        trip_update("B2", start_date=None, updates=[{"seq": 1, "dep_delay": 60}]),
        # B3: running 90 s early (negative int32 delay)
        trip_update("B3", updates=[{"seq": 2, "stop_id": "9001", "dep_delay": -90}]),
        # B4: trip-level delay only
        trip_update("B4", delay=300),
    ]))

print("fixtures written to", HERE)
