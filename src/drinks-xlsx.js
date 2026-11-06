/**
 * Minimal .xlsx reader for the drinks import: no library, nothing loaded from
 * another site. An .xlsx file is a zip of XML; this reads the first sheet and
 * returns rows as objects keyed by the header row, like HS_DRINKS.parseCSV.
 * Needs DecompressionStream (every current browser, Node 18+).
 * Reads values only: formulas show their last saved result, dates stay
 * numbers, macros and the older .xls format are not supported.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HS_XLSX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_BYTES = 5 * 1024 * 1024, MAX_UNPACKED = 20 * 1024 * 1024;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function text(bytes) { return new TextDecoder('utf-8').decode(bytes); }

  function entries(b) {
    var eocd = -1, i;
    for (i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file.');
    var count = u16(b, eocd + 10), off = u32(b, eocd + 16), out = {};
    for (i = 0; i < count; i++) {
      if (u32(b, off) !== 0x02014b50) throw new Error('The Excel file looks damaged.');
      var method = u16(b, off + 10), csize = u32(b, off + 20), usize = u32(b, off + 24);
      var nlen = u16(b, off + 28), xlen = u16(b, off + 30), clen = u16(b, off + 32), lho = u32(b, off + 42);
      out[text(b.subarray(off + 46, off + 46 + nlen))] = { method: method, csize: csize, usize: usize, lho: lho };
      off += 46 + nlen + xlen + clen;
    }
    return out;
  }

  async function read(b, entry) {
    if (entry.usize > MAX_UNPACKED) throw new Error('That Excel file is too big.');
    var o = entry.lho;
    if (u32(b, o) !== 0x04034b50) throw new Error('The Excel file looks damaged.');
    var start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
    var data = b.subarray(start, start + entry.csize);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new Error('This Excel file uses an unsupported format. Save it as CSV instead.');
    var ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }

  function unescapeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, e) {
      var k = e.toLowerCase();
      if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
      if (k === 'quot') return '"'; if (k === 'apos') return "'";
      var n = k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    });
  }
  function texts(xml) {
    var out = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(xml))) out += unescapeXml(m[1]);
    return out;
  }
  function colIndex(ref) {
    var letters = /^[A-Z]+/.exec(ref)[0], n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
    return n - 1;
  }
  function numText(v) { // 9.700000000000001 -> 9.7, but 12.999 stays 12.999 so the price check can refuse it
    var n = Number(v);
    return isFinite(n) ? String(Number(n.toPrecision(12))) : v;
  }

  /** @param {ArrayBuffer|Uint8Array} buffer  @returns {Promise<Array<Object>>} */
  async function readRows(buffer) {
    var b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (b.length > MAX_BYTES) throw new Error('That file is over 5 MB.');
    var files = entries(b);
    var get = async function (name) { return files[name] ? text(await read(b, files[name])) : null; };

    var sheetPath = 'xl/worksheets/sheet1.xml';
    var wb = await get('xl/workbook.xml'), rels = await get('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      var first = null, shre = /<sheet\s[^>]*>/g, shm;
      while ((shm = shre.exec(wb))) {
        if (/\bstate="(hidden|veryHidden)"/.test(shm[0])) continue;
        first = /r:id="([^"]+)"/.exec(shm[0]); if (first) break;
      }
      var rel = first && new RegExp('<Relationship\\s[^>]*Id="' + first[1] + '"[^>]*>').exec(rels);
      var target = rel && /Target="([^"]+)"/.exec(rel[0]);
      if (target) sheetPath = target[1].charAt(0) === '/' ? target[1].slice(1) : 'xl/' + target[1];
    }
    var sheet = await get(sheetPath);
    if (sheet == null) throw new Error('Could not find a sheet in that Excel file.');

    var shared = [], ss = await get('xl/sharedStrings.xml');
    if (ss) {
      var sre = /<si>([\s\S]*?)<\/si>|<si\/>/g, sm;
      while ((sm = sre.exec(ss))) shared.push(sm[1] ? texts(sm[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')) : '');
    }

    var rows = [], rre = /<row\b[^>]*>([\s\S]*?)<\/row>/g, rm;
    while ((rm = rre.exec(sheet))) {
      var cells = [], cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cre.exec(rm[1]))) {
        var attrs = cm[1], body = cm[2] || '';
        var ref = /\br="([A-Z]+\d+)"/.exec(attrs); if (!ref) continue;
        var type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
        var v = /<v>([\s\S]*?)<\/v>/.exec(body), val = '';
        if (type === 'inlineStr') val = texts(body);
        else if (v) {
          if (type === 's') val = shared[Number(v[1])] || '';
          else if (type === 'str' || type === 'e') val = unescapeXml(v[1]);
          else if (type === 'b') val = v[1] === '1' ? 'yes' : 'no';
          else val = numText(v[1]);
        }
        cells[colIndex(ref[1])] = val;
      }
      var rn = /\br="(\d+)"/.exec(rm[0].slice(0, rm[0].indexOf('>') + 1));
      Object.defineProperty(cells, '__row', { value: rn ? Number(rn[1]) : rows.length + 1, enumerable: false });
      rows.push(cells);
      if (rows.length > 2000) throw new Error('That sheet has more than 2000 rows.');
    }
    rows = rows.filter(function (r) { return r.some(function (x) { return x != null && String(x).trim() !== ''; }); });
    if (!rows.length) return [];
    // The header is the first of the top 10 rows that has a "Name"-like cell (a title row above it is fine).
    var hi = 0, names = /^(name|drink|item|drink name)$/i;
    for (var k = 0; k < Math.min(rows.length, 10); k++) {
      if (rows[k].some(function (c) { return names.test(String(c == null ? '' : c).trim()); })) { hi = k; break; }
    }
    var head = [];
    for (var i = 0; i < rows[hi].length; i++) head[i] = rows[hi][i] == null ? '' : String(rows[hi][i]).trim();
    return rows.slice(hi + 1).map(function (r) {
      var o = {};
      head.forEach(function (h, idx) { if (h) o[h] = r[idx] == null ? '' : r[idx]; });
      Object.defineProperty(o, '__row', { value: r.__row, enumerable: false });
      return o;
    });
  }

  return { readRows: readRows };
});
