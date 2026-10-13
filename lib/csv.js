"use strict";

/**
 * Streaming CSV reader for GTFS text files (RFC 4180: quoted fields,
 * doubled quotes, line breaks inside quotes, optional BOM, CRLF or LF).
 */

function parseLine(line) {
  if (!line.includes('"')) {
    return line.split(",");
  }

  const fields = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function countQuotes(text) {
  let count = 0;
  for (let i = text.indexOf('"'); i !== -1; i = text.indexOf('"', i + 1)) {
    count++;
  }
  return count;
}

/**
 * Reads a CSV stream and calls `onRow(row, columns)` for every data row.
 * `row` is an array of strings, `columns` maps a column name to its index.
 *
 * @param {import("node:stream").Readable} readable
 * @param {{name?: string, required?: string[]}} options
 * @param {(row: string[], columns: Record<string, number>) => void} onRow
 */
async function readCsv(readable, { name = "file", required = [] } = {}, onRow) {
  readable.setEncoding("utf8");

  let columns = null;
  let pending = "";
  let buffer = "";

  const handleLine = (line) => {
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    let complete;
    if (pending === "" && line.indexOf('"') === -1) {
      complete = line; // fast path: almost every line of stop_times.txt
    } else {
      // An odd number of quotes means a line break inside a quoted field.
      pending = pending ? `${pending}\n${line}` : line;
      if (countQuotes(pending) % 2 === 1) {
        return;
      }
      complete = pending;
      pending = "";
    }

    if (complete === "") {
      return;
    }

    if (columns === null) {
      const header = parseLine(complete.charCodeAt(0) === 0xfeff ? complete.slice(1) : complete);
      columns = {};
      header.forEach((column, index) => {
        columns[column.trim()] = index;
      });
      const missing = required.filter((column) => !(column in columns));
      if (missing.length > 0) {
        throw new Error(`${name} is missing the column(s): ${missing.join(", ")}`);
      }
      return;
    }

    onRow(parseLine(complete), columns);
  };

  for await (const chunk of readable) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer !== "") {
    handleLine(buffer);
  }
}

module.exports = { readCsv, parseLine };
