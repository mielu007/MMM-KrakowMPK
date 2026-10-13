"use strict";

class GtfsError extends Error {
  /**
   * @param {"CONNECTION"|"BAD_RESPONSE"|"STOP_NOT_FOUND"|"STOP_AMBIGUOUS"|"SCHEDULE_UNAVAILABLE"|"CONFIG"} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = "GtfsError";
    this.code = code;
  }
}

module.exports = { GtfsError };
