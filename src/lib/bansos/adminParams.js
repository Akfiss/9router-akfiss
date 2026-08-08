// Bansos Gateway admin API — shared request-parameter helpers for the
// admin/observability routes under src/app/api/bansos/ (Task 12 fix round).
//
// Extracted here because parseIntParam was duplicated verbatim across
// users/route.js, users/[id]/keys/route.js, and requests/route.js, while
// validatePositiveInt was duplicated between users/route.js and
// users/[id]/route.js — and settings/route.js reimplemented the same >=1
// integer check a third way inline. One copy, imported everywhere.

// Parses a query-string value into an integer, or undefined if it's absent
// or not a finite number — lets callers distinguish "not supplied" (fall
// back to the repo's own default) from an explicit "0".
export function parseIntParam(value) {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// >= 1 integer, or an explanatory error string to return as a 400.
export function validatePositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return `${label} must be an integer >= 1`;
  }
  return null;
}
