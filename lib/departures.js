"use strict";

const { indexTripUpdates } = require("./gtfs-rt");
const { isServiceActive } = require("./gtfs-static");
const { formatClock, serviceDate, serviceDayStart, shiftDate, weekday } = require("./time");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// A vehicle that left less than this long ago is not shown any more.
const DEPARTED_GRACE_MS = 30_000;

function delayOf(event) {
  return event && event.delay !== null ? event.delay : null;
}

/**
 * Applies real-time data to one scheduled call.
 *
 * @returns {{ predictedMs: number, realtime: boolean } | null} null when the call is cancelled or skipped
 */
function applyRealtime(updates, stopTime, date, scheduledMs, nowMs) {
  // trip_id repeats on every service day; start_date says which run an update is about.
  const update =
    updates.find((candidate) => candidate.startDate === date) ||
    (Math.abs(scheduledMs - nowMs) < 12 * HOUR_MS ? updates.find((candidate) => !candidate.startDate) : undefined);

  if (!update) {
    return { predictedMs: scheduledMs, realtime: false };
  }
  if (update.canceled) {
    return null;
  }

  // The Kraków feed identifies a call by its stop_sequence, a stop_id is not always present.
  const exact =
    update.stopTimeUpdates.find((candidate) => candidate.stopSequence === stopTime.sequence) ||
    update.stopTimeUpdates.find((candidate) => candidate.stopSequence === null && candidate.stopId === stopTime.stopId);

  if (exact) {
    if (exact.skipped) {
      return null;
    }
    const event = exact.departure || exact.arrival;
    if (event && event.time !== null) {
      return { predictedMs: event.time * 1000, realtime: true };
    }
    const delay = delayOf(exact.departure) ?? delayOf(exact.arrival);
    if (delay !== null) {
      return { predictedMs: scheduledMs + delay * 1000, realtime: true };
    }
  }

  // A delay reported for an earlier stop carries on to the following ones.
  let previous = null;
  for (const candidate of update.stopTimeUpdates) {
    const delay = delayOf(candidate.departure) ?? delayOf(candidate.arrival);
    if (!candidate.skipped && candidate.stopSequence !== null && candidate.stopSequence < stopTime.sequence && delay !== null) {
      if (previous === null || candidate.stopSequence > previous.sequence) {
        previous = { sequence: candidate.stopSequence, delay };
      }
    }
  }
  if (previous) {
    return { predictedMs: scheduledMs + previous.delay * 1000, realtime: true };
  }

  if (update.delay !== null) {
    return { predictedMs: scheduledMs + update.delay * 1000, realtime: true };
  }
  return { predictedMs: scheduledMs, realtime: false };
}

/**
 * Departures from the stop in the next `lookaheadMinutes`, soonest first.
 *
 * @param {object[]} sources `{ type, schedule, tripUpdates }` per feed;
 *   `tripUpdates` is a list from decodeTripUpdates() or null when there is no real-time data
 * @param {number} nowMs
 */
function computeDepartures(sources, nowMs, lookaheadMinutes) {
  const horizonMs = nowMs + lookaheadMinutes * MINUTE_MS;
  const today = serviceDate(nowMs);
  const departures = [];

  for (const { type, schedule, tripUpdates } of sources) {
    const updatesByTrip = tripUpdates ? indexTripUpdates(tripUpdates) : new Map();

    // Yesterday's service day matters for trips running past midnight (times like 25:10:00).
    for (const date of [shiftDate(today, -1), today, shiftDate(today, 1)]) {
      const dayStart = serviceDayStart(date);
      const day = weekday(date);

      for (const stopTime of schedule.stopTimes) {
        if (stopTime.isLast) {
          continue; // a vehicle ending its run here does not take passengers on
        }
        const trip = schedule.trips.get(stopTime.tripId);
        if (!trip || !isServiceActive(schedule, trip.serviceId, date, day)) {
          continue;
        }

        const scheduledMs = dayStart + stopTime.seconds * 1000;
        // Cheap pre-check, with room for delays and early departures.
        if (scheduledMs < nowMs - 3 * HOUR_MS || scheduledMs > horizonMs + 3 * HOUR_MS) {
          continue;
        }

        const applied = applyRealtime(updatesByTrip.get(stopTime.tripId) || [], stopTime, date, scheduledMs, nowMs);
        if (!applied || applied.predictedMs < nowMs - DEPARTED_GRACE_MS || applied.predictedMs > horizonMs) {
          continue;
        }

        const route = schedule.routes.get(trip.routeId);
        const minutes = Math.max(0, Math.floor((applied.predictedMs - nowMs) / MINUTE_MS));

        departures.push({
          predictedMs: applied.predictedMs,
          type,
          line: (route && (route.shortName || route.longName)) || trip.routeId,
          direction: trip.headsign || (route && route.longName) || "",
          minutes,
          realtime: applied.realtime,
          delaySeconds: applied.realtime ? Math.round((applied.predictedMs - scheduledMs) / 1000) : null,
          scheduledAt: formatClock(scheduledMs),
          expectedAt: formatClock(applied.predictedMs)
        });
      }
    }
  }

  departures.sort((a, b) => a.predictedMs - b.predictedMs);
  return departures.map(({ predictedMs, ...departure }) => departure);
}

module.exports = { computeDepartures, applyRealtime };
