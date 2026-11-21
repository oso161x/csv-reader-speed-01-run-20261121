// A fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV
// reader). run(input) returns exactly csv-reader's {columns, rows, errors}
// for every {text, header} input, but reads with native indexOf/slice scans
// instead of one character at a time, so the common case — plain unquoted
// fields and quoted fields without embedded line breaks — never touches a
// character loop. Broken rows (stray CRs, unterminated quotes, quote junk,
// quoted line breaks) fall back to small character loops that mirror the
// reference's policy exactly, character for character.
//
// The reference policy, as implemented here:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, each CRLF or lone CR inside it read as LF; what
//     follows the closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends, only if at least one
//     character was appended); a quote that never closes is a literal character
//     and the text after it is re-read as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded (short_row) or cut (long_row) to the first
//     record's width; the header itself is never padded or cut;
//   - each error is {code, line, row} in the order met; line is the 1-based line
//     its record starts on, row its record's index in rows (null for the header);
//   - a record that is a single empty unquoted field is no record.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // How the field just read ended, and how many characters it kept. Shared
  // by the readers below so no result object is allocated per field.
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break.
  // Fast path: the next comma and the next LF are found with indexOf, the
  // field is sliced out whole, and a stray CR is caught by scanning just the
  // slice (a CR is only ever a CRLF at the slice's end, handled below, or a
  // stray one, which falls back to the character loop).
  function readUnquoted(value) {
    let ci = text.indexOf(',', pos);
    let ni = text.indexOf('\n', pos);
    let end;
    let ended;
    if (ci === -1) {
      if (ni === -1) {
        end = n;
        ended = END;
      } else {
        end = ni;
        ended = LINE_BREAK;
      }
    } else if (ni === -1) {
      end = ci;
      ended = COMMA;
    } else if (ci < ni) {
      end = ci;
      ended = COMMA;
    } else {
      end = ni;
      ended = LINE_BREAK;
    }
    let field;
    if (ended === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) {
      field = text.slice(pos, end - 1); // CRLF: the CR is the line break, not the field
    } else {
      field = text.slice(pos, end);
    }
    if (field.indexOf('\r') === -1) {
      pos = ended === END ? n : end + 1;
      if (ended === LINE_BREAK) line += 1;
      fEnded = ended;
      fAdded = field.length;
      return value + field;
    }
    return readUnquotedSlow(value);
  }

  // The character loop for an unquoted field, used only when the field holds
  // a stray CR. Mirrors the reference exactly: a CR not followed by LF is
  // dropped (stray_cr) and the field goes on.
  function readUnquotedSlow(value) {
    let added = 0;
    while (pos < n) {
      const c = text[pos];
      if (c === ',') {
        pos += 1;
        fEnded = COMMA;
        fAdded = added;
        return value;
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        fEnded = LINE_BREAK;
        fAdded = added;
        return value;
      }
      if (c === '\r') {
        if (text[pos + 1] === '\n') {
          pos += 2;
          line += 1;
          fEnded = LINE_BREAK;
          fAdded = added;
          return value;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        continue;
      }
      value += c;
      added += 1;
      pos += 1;
    }
    fEnded = END;
    fAdded = added;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos. Fast path: the
  // closing quote is found with indexOf (doubled quotes skipped), the raw
  // content is sliced out whole, and doubled quotes are collapsed with one
  // split/join. A line break inside the quotes, or a quote that never
  // closes, falls back to the character loop below.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let doubled = false;
    let q = -1;
    for (;;) {
      q = text.indexOf('"', i);
      if (q === -1) break;
      if (text[q + 1] === '"') {
        doubled = true;
        i = q + 2;
        continue;
      }
      break;
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const raw = text.slice(open + 1, q);
    if (raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) {
      return readQuotedSlow(open, openLine);
    }
    const value = doubled ? raw.split('""').join('"') : raw;
    const a = q + 1;
    if (a >= n) {
      pos = n;
      fEnded = END;
      fAdded = 0;
      return value;
    }
    const c = text[a];
    if (c === ',') {
      pos = a + 1;
      fEnded = COMMA;
      fAdded = 0;
      return value;
    }
    if (c === '\n') {
      pos = a + 1;
      line += 1;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return value;
    }
    if (c === '\r' && text[a + 1] === '\n') {
      pos = a + 2;
      line += 1;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    pos = a;
    const out = readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return out;
  }

  // The character loop for a quoted field, used only when it holds a line
  // break inside the quotes. Mirrors the reference exactly: "" inside is one
  // quote, each CRLF or lone CR inside is read as LF, and a quote that never
  // closes is a literal character with the text after it re-read as unquoted.
  function readQuotedSlow(open, openLine) {
    let value = '';
    pos = open + 1;
    let closed = false;
    while (pos < n) {
      const c = text[pos];
      if (c === '"') {
        if (text[pos + 1] === '"') {
          value += '"';
          pos += 2;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === '\r') {
        value += '\n';
        line += 1;
        pos += text[pos + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (c === '\n') line += 1;
      value += c;
      pos += 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= n) {
      fEnded = END;
      fAdded = 0;
      return value;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      fEnded = COMMA;
      fAdded = 0;
      return value;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return value;
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return value;
    }
    const out = readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return out;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text[pos] === '"';
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
