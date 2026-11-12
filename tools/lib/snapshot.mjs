// snapshot.mjs: where the dataset snapshot is, and how to read its manifest.csv.
// Shared by build-assets.mjs and check-speech.mjs.
//
// A "snapshot" is a folder exported by dataset-tools/curate.py. It contains
// images/, sounds/ and a manifest.csv describing every file (author, license, label…).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The project folder is two levels above this file (tools/lib/ → project root).
export const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Default snapshot: the screened candidate pack from 2026-11-11.
// When the human review is finished, point this at the "ready" export instead.
export const DEFAULT_SNAPSHOT = path.resolve(
  PROJECT,
  "../Audio Embedding Test_demo/dataset-tools/work/candidates/screened-20261111-010209",
);

export const EXCLUDED_FILE = path.join(PROJECT, "config/excluded.json");

// The snapshot folder given on the command line, or the default one.
export function snapshotFolder() {
  return path.resolve(process.argv[2] ?? DEFAULT_SNAPSHOT);
}
// ---- Read a CSV file into a list of objects ----
// CSV is a spreadsheet saved as text: one row per line, cells separated by commas.
// A cell that itself contains commas or line breaks is wrapped in "double quotes".
export function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, ""); // drop the invisible BOM mark Excel adds
  const table = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'; // "" inside quotes means one literal quote
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      table.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    table.push(row);
  }

  // The first row holds the column names; use them as keys for every other row.
  const [header, ...body] = table;
  return body
    .filter((cells) => cells.length > 1)
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, unguard(cells[index] ?? "")])));
}

// curate.py puts a ' in front of cells starting with = + - @ so Excel will not
// run them as formulas. Undo that here.
function unguard(value) {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}
