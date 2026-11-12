/** RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF / LF. Skips blank rows. */
export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; if (row.some(x => x.trim())) rows.push(row); row = [];
    } else field += c;
  }
  row.push(field); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

/** One CSV cell. Values starting with = + - @ are prefixed so spreadsheets don't run them as formulas. */
export function csvCell(x) {
  let s = x == null ? '' : x instanceof Date ? x.toISOString() : String(x);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
