// In-memory repository for fractal locations (session only).
//
// S4 "input truth": every record that enters this store is checked against a
// schema before it is accepted. Imported JSON is attacker-controlled data, and
// before S4 the only check was `Array.isArray` on the whole payload — so a
// record could carry `name: {...}` (which made `getAll('name')` throw from
// `localeCompare`), `scale: -1`, `maxIter: "lots"` or `renderer: "<img …>"`,
// and the UI rendered some of those strings into `innerHTML`.
//
// The schema is defined ONCE, here, and reuses the kernel's tables
// (`FractalKernel.FRACTAL_TYPES`) rather than restating the list of types.
// `globalThis` is read lazily so this module has no import-time dependency on
// being loaded after the kernel (the app loads both; a test can too).

// --- the limits ------------------------------------------------------------
// Every one of these is a declared bound, not an incidental one:
//   * MAX_RECORDS — how many records ONE imported file may contribute. A file
//     larger than this is rejected whole (see `validateRecords`): if the input
//     is hostile, there is no "valid part" to trust.
//   * MAX_NAME_LENGTH / MAX_ID_LENGTH — how much display/storage text a single
//     record may carry.
//   * MAX_FILE_BYTES — the raw text size, checked before JSON.parse, so a huge
//     file is refused without being parsed at all.
//   * MAX_ITER_MIN = the slider's own `min` attribute (index.html:27). An
//     imported record the UI cannot represent is not accepted silently.
export const LOCATION_LIMITS = Object.freeze({
  MAX_RECORDS: 200,
  MAX_NAME_LENGTH: 200,
  MAX_ID_LENGTH: 128,
  MAX_FILE_BYTES: 1024 * 1024,
  MAX_ITER_MIN: 50
});

// The two renderer names the app actually has (app.js writes 'GPU'/'CPU' and
// reads a record back as `loc.renderer === 'GPU'`, so anything else is a
// renderer the app cannot select).
const RENDERERS = Object.freeze(['GPU', 'CPU']);

function fractalKernel() {
  return (typeof globalThis !== 'undefined' && globalThis.FractalKernel) || null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value);
}

// A sort key that is always a string, so `localeCompare` can never throw on a
// record a caller put in by hand (the pre-S4 hazard: `a.name.localeCompare` on
// a non-string threw out of `getAll()`).
function nameKey(record) {
  return typeof record.name === 'string' ? record.name : '';
}

// A sort key that is always a number, so the timestamp sort is a total order
// and never yields NaN (NaN comparisons are all false, which leaves the sort
// order undefined rather than merely wrong).
function timeKey(record) {
  const t = record.timestamp;
  return isFiniteNumber(t) ? t : 0;
}

const collator = typeof Intl !== 'undefined' && Intl.Collator
  ? new Intl.Collator(undefined, { sensitivity: 'variant' })
  : null;

function compareNames(a, b) {
  const an = nameKey(a);
  const bn = nameKey(b);
  if (collator) return collator.compare(an, bn);
  return an < bn ? -1 : an > bn ? 1 : 0;
}

// --- validation ------------------------------------------------------------
// Returns the list of problems with ONE record; an empty list means accepted.
// Every message names the field and the reason, because these strings are what
// the user is shown when a file is rejected.
export function validateLocation(record) {
  if (!isPlainObject(record)) return ['record is not an object'];
  const problems = [];
  if (!isBoundedString(record.id, LOCATION_LIMITS.MAX_ID_LENGTH)) {
    problems.push(`id must be a non-empty string of at most ${LOCATION_LIMITS.MAX_ID_LENGTH} characters`);
  }
  if (!isBoundedString(record.name, LOCATION_LIMITS.MAX_NAME_LENGTH)) {
    problems.push(`name must be a non-empty string of at most ${LOCATION_LIMITS.MAX_NAME_LENGTH} characters`);
  }
  if (!(isFiniteNumber(record.scale) && record.scale > 0)) {
    problems.push('scale must be a finite number greater than 0');
  }
  if (!isFiniteNumber(record.centerX)) problems.push('centerX must be a finite number');
  if (!isFiniteNumber(record.centerY)) problems.push('centerY must be a finite number');
  const kernel = fractalKernel();
  const types = kernel ? kernel.FRACTAL_TYPES.map(t => t.value) : [];
  if (types.indexOf(record.fractalType) === -1) {
    problems.push(`fractalType must be one of: ${types.join(', ')}`);
  }
  if (!Number.isInteger(record.maxIter)
      || record.maxIter < LOCATION_LIMITS.MAX_ITER_MIN
      || (kernel && record.maxIter > kernel.MAX_ITER)
      || (!kernel && record.maxIter > Number.MAX_SAFE_INTEGER)) {
    const cap = kernel ? kernel.MAX_ITER : 'the iteration cap';
    problems.push(`maxIter must be an integer between ${LOCATION_LIMITS.MAX_ITER_MIN} and ${cap}`);
  }
  if (RENDERERS.indexOf(record.renderer) === -1) {
    problems.push(`renderer must be one of: ${RENDERERS.join(', ')}`);
  }
  if (!isFiniteNumber(record.timestamp)) {
    problems.push('timestamp must be a finite number');
  }
  return problems;
}

// Validate an ARRAY of imported records.
//
// JUDGEMENT (docs/DECISIONS.md row 18): a file with a hostile record count is
// rejected WHOLE — no partial acceptance — because "too many records" is not a
// defect in one record, it is a property of the file, and accepting the first
// part of a file we have just decided not to trust would be the worst of both.
// A file with individual bad records, by contrast, keeps its valid part: a
// rejection is reported per record and the valid ones still load, so one
// truncated line cannot cost the user every location they saved.
//
// Returns `{ accepted, rejected, fatal }`:
//   * fatal    — a whole-file problem; `accepted`/`rejected` are empty.
//   * accepted — normalized copies, safe to store and render.
//   * rejected — { index, reasons } for every record the schema refused.
export function validateRecords(payload) {
  if (Array.isArray(payload) && payload.length > LOCATION_LIMITS.MAX_RECORDS) {
    return {
      fatal: `file contains ${payload.length} records; the maximum is ${LOCATION_LIMITS.MAX_RECORDS}`,
      accepted: [],
      rejected: []
    };
  }
  if (!Array.isArray(payload)) {
    return { fatal: 'the file must contain a JSON array of locations', accepted: [], rejected: [] };
  }
  const accepted = [];
  const rejected = [];
  payload.forEach((record, index) => {
    const problems = validateLocation(record);
    if (problems.length) rejected.push({ index, reasons: problems });
    else accepted.push(normalizeLocation(record));
  });
  return { fatal: null, accepted, rejected };
}

// Bring an ACCEPTED record to the exact shape the rest of the app expects.
// Only fields the schema has already approved are touched; nothing here can
// turn a rejected record into a stored one.
function normalizeLocation(record) {
  return {
    id: record.id,
    name: record.name,
    scale: record.scale,
    centerX: record.centerX,
    centerY: record.centerY,
    fractalType: record.fractalType,
    maxIter: record.maxIter,
    renderer: record.renderer,
    timestamp: record.timestamp
  };
}

export class FractalMemoryRepository {
  constructor() {
    this.locations = [];
    this.counter = 1;
  }

  // Store a record. Fields are normalized DEFENSIVELY here as well as validated
  // at the import boundary, so the ordering in `getAll()` is total even for a
  // caller that does not go through `validateLocation` (the app's own Save path,
  // or a future one). Nothing is mutated on the caller's object.
  save(location) {
    const stored = normalizeLocation(location);
    if (typeof stored.name !== 'string' || stored.name.length === 0) {
      stored.name = `Location ${this.counter++}`;
    }
    if (!isFiniteNumber(stored.timestamp)) stored.timestamp = Date.now();
    this.locations.push(stored);
    return stored;
  }

  // Replace the stored record with the same id, or append. Used by import so a
  // re-imported file updates rather than duplicates.
  upsert(location) {
    const stored = normalizeLocation(location);
    const existing = this.locations.findIndex(loc => loc.id === stored.id);
    if (existing !== -1) {
      // Keep a generated name only when the incoming one is unusable; the
      // schema has already forbidden that for imports.
      if (typeof stored.name !== 'string' || stored.name.length === 0) {
        stored.name = this.locations[existing].name || `Location ${this.counter++}`;
      }
      if (!isFiniteNumber(stored.timestamp)) stored.timestamp = this.locations[existing].timestamp;
      this.locations[existing] = stored;
    } else {
      this.save(stored);
    }
    return stored;
  }

  getAll(sortBy = 'timestamp') {
    const sorted = [...this.locations];
    if (sortBy === 'name') {
      // Total and non-throwing for ANY record: the key is coerced, so a
      // non-string name can no longer throw out of localeCompare (S4).
      sorted.sort(compareNames);
    } else {
      // Total too: a non-numeric timestamp contributes 0 instead of NaN, which
      // would otherwise make the comparator inconsistent.
      sorted.sort((a, b) => timeKey(b) - timeKey(a));
    }
    return sorted;
  }

  get(id) {
    return this.locations.find(loc => loc.id === id);
  }

  remove(id) {
    this.locations = this.locations.filter(loc => loc.id !== id);
  }

  clear() {
    this.locations = [];
    this.counter = 1;
  }
}
