import { createHash } from 'node:crypto';

export function parseCSV(source) {
  const text = source.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error('Unexpected quote in CSV. Quote the entire cell.');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field.trim()); field = ''; closed = false;
      if (c !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      if (closed && !/\s/.test(c)) throw new Error('Unexpected text after a quoted CSV cell.');
      if (!closed) field += c;
    }
  }
  if (quoted) throw new Error('A quoted CSV cell was not closed.');
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function publicURL(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}: enter a complete https:// URL.`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || host.includes(':') ||
      /^\d+(\.\d+){3}$/.test(host) || !host.includes('.') ||
      /(^|\.)(localhost|local|internal|test|example|invalid)$/.test(host) || host.includes('replace_me')) {
    throw new Error(`${label}: use a public HTTPS website, without credentials or a custom port.`);
  }
  return url.href;
}

export function slug(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65) || 'brand';
}

export function validateBrands(csv, config) {
  const rows = parseCSV(csv);
  if (rows.length < 2) throw new Error('Add at least one brand below the CSV header.');
  const headers = rows.shift().map(h => h.toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique.');
  for (const key of ['brand_name', 'instagram_url', 'website_url']) if (!headers.includes(key)) throw new Error(`Missing CSV column: ${key}`);
  const allowed = ['brand_name', 'instagram_url', 'website_url', 'shoot_type', 'product_count', 'style', 'character_id', 'notes'];
  for (const h of headers) if (!allowed.includes(h)) throw new Error(`Unknown CSV column: ${h}`);
  const seen = new Set();
  return rows.map((cells, i) => {
    if (cells.length !== headers.length) throw new Error(`Row ${i + 2}: expected ${headers.length} cells; found ${cells.length}.`);
    const r = Object.fromEntries(headers.map((h, j) => [h, cells[j]]));
    if (!r.brand_name || /YOUR (SECOND|THIRD) BRAND/i.test(r.brand_name)) throw new Error(`Row ${i + 2}: replace the sample brand name.`);
    if (r.brand_name.length > 120 || (r.notes || '').length > 2000) throw new Error(`Row ${i + 2}: brand name or notes are too long.`);
    const nameKey = r.brand_name.toLowerCase();
    if (seen.has(nameKey)) throw new Error(`Duplicate brand: ${r.brand_name}`); seen.add(nameKey);
    r.instagram_url = publicURL(r.instagram_url, `${r.brand_name} Instagram`);
    if (!/(^|\.)instagram\.com$/.test(new URL(r.instagram_url).hostname)) throw new Error(`${r.brand_name}: Instagram link must be on instagram.com.`);
    r.website_url = publicURL(r.website_url, `${r.brand_name} website`);
    r.shoot_type ||= config.defaultShootType;
    if (!['still_life', 'fashion', 'both', 'auto'].includes(r.shoot_type)) throw new Error(`${r.brand_name}: shoot_type must be still_life, fashion, both, or auto.`);
    r.product_count = Number(r.product_count || config.defaultProducts);
    if (!Number.isInteger(r.product_count) || r.product_count < 1 || r.product_count > 3) throw new Error(`${r.brand_name}: product_count must be 1–3.`);
    r.style ||= config.defaultStyle; r.character_id ||= ''; r.notes ||= '';
    r.id = `${slug(r.brand_name)}-${createHash('sha256').update(r.website_url + nameKey).digest('hex').slice(0, 6)}`;
    return r;
  });
}
