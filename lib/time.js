"use strict";

/**
 * Time helpers for GTFS. All service days are in the agency's time zone
 * (Europe/Warsaw), whatever time zone the mirror's device is set to.
 */

const TIME_ZONE = "Europe/Warsaw";
const DAY_MS = 24 * 60 * 60 * 1000;

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function zonedParts(ms) {
  const values = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    values[part.type] = Number(part.value);
  }
  return values;
}

/** Offset of the time zone from UTC at a given moment, in milliseconds. */
function zoneOffsetMs(ms) {
  const p = zonedParts(ms);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockAsUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n) => String(n).padStart(2, "0");

/** "YYYYMMDD" of the given moment in Kraków. */
function serviceDate(ms) {
  const p = zonedParts(ms);
  return `${p.year}${pad(p.month)}${pad(p.day)}`;
}

/** "YYYYMMDD" shifted by a number of days. */
function shiftDate(date, days) {
  const base = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
  const shifted = new Date(base + days * DAY_MS);
  return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
}

/** 0 = Sunday ... 6 = Saturday, like Date#getUTCDay. */
function weekday(date) {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)))).getUTCDay();
}

/**
 * The moment a service day starts, as GTFS defines it: "noon minus 12 hours",
 * which stays correct on the days the clocks change.
 */
function serviceDayStart(date) {
  const noonUtc = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), 12);
  return noonUtc - zoneOffsetMs(noonUtc) - 12 * 60 * 60 * 1000;
}

/** "14:20:00" or "25:10:00" -> seconds since the start of the service day, or null. */
function parseGtfsTime(text) {
  const match = /^\s*(\d{1,3}):(\d{2}):(\d{2})\s*$/.exec(text || "");
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

/** "HH:MM" in Kraków. */
function formatClock(ms) {
  const p = zonedParts(ms);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

module.exports = { TIME_ZONE, serviceDate, shiftDate, weekday, serviceDayStart, parseGtfsTime, formatClock };
