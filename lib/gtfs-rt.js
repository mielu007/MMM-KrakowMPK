"use strict";

/**
 * Decoder for the part of GTFS-Realtime (protobuf) this module needs: TripUpdates.
 * Field numbers follow https://gtfs.org/realtime/gtfs-realtime.proto
 * Unknown fields are skipped, so newer versions of the feed still decode.
 */

const { GtfsError } = require("./errors");

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const SCHEDULE_RELATIONSHIP_CANCELED = 3;
const SCHEDULE_RELATIONSHIP_DELETED = 6;
const STOP_RELATIONSHIP_SKIPPED = 1;

/** Reads a varint as a BigInt starting at `position`. */
function readVarint(buffer, position, end) {
  let result = 0n;
  let shift = 0n;
  let index = position;

  for (;;) {
    if (index >= end) {
      throw new Error("truncated varint");
    }
    const byte = buffer[index++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: index };
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error("varint is too long");
    }
  }
}

/** Splits a message into its fields. */
function readFields(buffer, start, end) {
  const fields = [];
  let position = start;

  while (position < end) {
    const tag = readVarint(buffer, position, end);
    position = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);

    if (wire === WIRE_VARINT) {
      const varint = readVarint(buffer, position, end);
      position = varint.next;
      fields.push({ field, wire, value: varint.value });
    } else if (wire === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(buffer, position, end);
      position = length.next;
      const stop = position + Number(length.value);
      if (stop > end) {
        throw new Error("length-delimited field runs past the end of the message");
      }
      fields.push({ field, wire, start: position, end: stop });
      position = stop;
    } else if (wire === WIRE_FIXED64) {
      position += 8;
    } else if (wire === WIRE_FIXED32) {
      position += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }

  if (position > end) {
    throw new Error("fixed-size field runs past the end of the message");
  }
  return fields;
}

const asString = (buffer, f) => buffer.toString("utf8", f.start, f.end);
// int32 / int64 are sign-extended to 64 bits on the wire.
const asInt = (f) => Number(BigInt.asIntN(64, f.value));
const asUint = (f) => Number(f.value);

function decodeStopTimeEvent(buffer, f) {
  const event = { delay: null, time: null };
  for (const part of readFields(buffer, f.start, f.end)) {
    if (part.field === 1 && part.wire === WIRE_VARINT) {
      event.delay = asInt(part);
    } else if (part.field === 2 && part.wire === WIRE_VARINT) {
      event.time = asInt(part);
    }
  }
  return event;
}

function decodeStopTimeUpdate(buffer, f) {
  const update = { stopSequence: null, stopId: null, arrival: null, departure: null, skipped: false };
  for (const part of readFields(buffer, f.start, f.end)) {
    if (part.field === 1 && part.wire === WIRE_VARINT) {
      update.stopSequence = asUint(part);
    } else if (part.field === 2 && part.wire === WIRE_LENGTH_DELIMITED) {
      update.arrival = decodeStopTimeEvent(buffer, part);
    } else if (part.field === 3 && part.wire === WIRE_LENGTH_DELIMITED) {
      update.departure = decodeStopTimeEvent(buffer, part);
    } else if (part.field === 4 && part.wire === WIRE_LENGTH_DELIMITED) {
      update.stopId = asString(buffer, part);
    } else if (part.field === 5 && part.wire === WIRE_VARINT) {
      update.skipped = asUint(part) === STOP_RELATIONSHIP_SKIPPED;
    }
  }
  return update;
}

function decodeTripUpdate(buffer, f) {
  const update = { tripId: null, routeId: null, startDate: null, canceled: false, delay: null, stopTimeUpdates: [] };

  for (const part of readFields(buffer, f.start, f.end)) {
    if (part.field === 1 && part.wire === WIRE_LENGTH_DELIMITED) {
      for (const trip of readFields(buffer, part.start, part.end)) {
        if (trip.field === 1 && trip.wire === WIRE_LENGTH_DELIMITED) {
          update.tripId = asString(buffer, trip);
        } else if (trip.field === 3 && trip.wire === WIRE_LENGTH_DELIMITED) {
          update.startDate = asString(buffer, trip);
        } else if (trip.field === 4 && trip.wire === WIRE_VARINT) {
          const relationship = asUint(trip);
          update.canceled = relationship === SCHEDULE_RELATIONSHIP_CANCELED || relationship === SCHEDULE_RELATIONSHIP_DELETED;
        } else if (trip.field === 5 && trip.wire === WIRE_LENGTH_DELIMITED) {
          update.routeId = asString(buffer, trip);
        }
      }
    } else if (part.field === 2 && part.wire === WIRE_LENGTH_DELIMITED) {
      update.stopTimeUpdates.push(decodeStopTimeUpdate(buffer, part));
    } else if (part.field === 5 && part.wire === WIRE_VARINT) {
      update.delay = asInt(part);
    }
  }
  return update;
}

/**
 * @param {Buffer} buffer a FeedMessage
 * @returns {{timestamp: number|null, entityCount: number, tripUpdates: object[]}}
 */
function decodeTripUpdates(buffer) {
  const feed = { timestamp: null, entityCount: 0, tripUpdates: [] };

  try {
    for (const f of readFields(buffer, 0, buffer.length)) {
      if (f.field === 1 && f.wire === WIRE_LENGTH_DELIMITED) {
        for (const header of readFields(buffer, f.start, f.end)) {
          if (header.field === 3 && header.wire === WIRE_VARINT) {
            feed.timestamp = asUint(header);
          }
        }
      } else if (f.field === 2 && f.wire === WIRE_LENGTH_DELIMITED) {
        feed.entityCount += 1;
        let deleted = false;
        let tripUpdate = null;
        for (const part of readFields(buffer, f.start, f.end)) {
          if (part.field === 2 && part.wire === WIRE_VARINT) {
            deleted = part.value !== 0n;
          } else if (part.field === 3 && part.wire === WIRE_LENGTH_DELIMITED) {
            tripUpdate = decodeTripUpdate(buffer, part);
          }
        }
        if (tripUpdate && tripUpdate.tripId && !deleted) {
          feed.tripUpdates.push(tripUpdate);
        }
      }
    }
  } catch (error) {
    throw new GtfsError("BAD_RESPONSE", `Cannot decode GTFS-Realtime data: ${error.message}`, { cause: error });
  }

  return feed;
}

/** Groups trip updates by trip_id (one trip_id can have an update for several service days). */
function indexTripUpdates(tripUpdates) {
  const index = new Map();
  for (const update of tripUpdates) {
    if (!index.has(update.tripId)) {
      index.set(update.tripId, []);
    }
    index.get(update.tripId).push(update);
  }
  return index;
}

module.exports = { decodeTripUpdates, indexTripUpdates, STOP_RELATIONSHIP_SKIPPED };
