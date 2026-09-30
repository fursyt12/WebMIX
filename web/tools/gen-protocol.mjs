#!/usr/bin/env node
/*
 * WebMIX protocol code generator.
 *
 * Reads the vendored obs-websocket protocol definition (web/protocol.json,
 * matching the obs-websocket version this OBS fork builds) and emits
 * web/src/protocol.js: enums, request metadata and event metadata that the
 * browser client and the UI use directly.
 *
 * No dependencies. Run with:  node tools/gen-protocol.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('../protocol.json');
const OUT = here('../src/protocol.js');

const proto = JSON.parse(readFileSync(SRC, 'utf8'));

const esc = (s) => JSON.stringify(s);

/* ------------------------------------------------------------------ enums */

/*
 * Protocol enum values are either literals or small expressions such as
 * `(1 << 0)` or `(General | Config | ...)`.  Resolve them here so the emitted
 * module contains plain values and does not depend on sibling identifiers.
 */
function resolveEnumValues(enumIdentifiers) {
  const scope = Object.create(null);
  const resolved = [];
  for (const id of enumIdentifiers) {
    const raw = String(id.enumValue);
    let value;
    if (/^-?\d+$/.test(raw)) {
      value = parseInt(raw, 10);
    } else if (/^[0-9.]+$/.test(raw)) {
      value = Number(raw);
    } else if (/^["']/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw.slice(1, -1);
      }
    } else {
      const expr = raw.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) =>
        name in scope ? String(scope[name]) : name
      );
      try {
        value = Function(`"use strict";return (${expr});`)();
      } catch {
        value = raw;
      }
    }
    scope[id.enumIdentifier] = value;
    resolved.push({ name: id.enumIdentifier, value, raw, description: id.description || '' });
  }
  return resolved;
}

function renderEnum(e) {
  const seen = new Set();
  const rows = [];
  for (const { name, value, raw, description } of resolveEnumValues(e.enumIdentifiers)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const literal = typeof value === 'string' ? esc(value) : String(value);
    const exprNote = String(raw) !== literal ? ` (= ${raw})` : '';
    const note = description ? ` // ${description.split('\n')[0].slice(0, 90)}${exprNote}` : '';
    rows.push(`  ${name}: ${literal},${note}`);
  }
  return `export const ${e.enumType} = Object.freeze({\n${rows.join('\n')}\n});\n`;
}

/* --------------------------------------------------------------- requests */

function renderFields(fields, key) {
  const out = [];
  for (const f of fields || []) {
    const name = f.valueName;
    if (!name) continue;
    out.push({
      name,
      type: f.valueType,
      optional: f.valueOptional === true,
      description: f.valueDescription || '',
      restrictions: f.valueRestrictions ?? null,
    });
  }
  return out;
}

const requests = {};
const categories = {};
for (const r of proto.requests) {
  if (r.deprecated) continue;
  requests[r.requestType] = {
    category: r.category || 'general',
    complexity: r.complexity ?? 0,
    description: (r.description || '').split('\n')[0],
    fields: renderFields(r.requestFields),
  };
  (categories[r.category || 'general'] ||= []).push(r.requestType);
}
for (const k of Object.keys(categories)) categories[k].sort();

const events = {};
const eventCategories = {};
for (const e of proto.events) {
  if (e.deprecated) continue;
  events[e.eventType] = {
    category: e.category || 'general',
    description: (e.description || '').split('\n')[0],
    fields: renderFields(e.eventFields),
  };
  (eventCategories[e.category || 'general'] ||= []).push(e.eventType);
}
for (const k of Object.keys(eventCategories)) eventCategories[k].sort();

/* ----------------------------------------------------------------- header */

const header = `/*
 * GENERATED FILE - DO NOT EDIT.
 *
 * Source:    web/protocol.json (obs-websocket protocol definition)
 * Generator: web/tools/gen-protocol.mjs
 *
 * Regenerate with:  node tools/gen-protocol.mjs
 */
`;

const body = [
  header,
  '/* Bit flags for the Identify message / EVENT_SUBSCRIPTION. */',
  ...proto.enums.map(renderEnum),
  '',
  '/* Request metadata: category, complexity and field descriptors. */',
  `export const REQUESTS = ${JSON.stringify(requests, null, 2)};`,
  '',
  '/* Event metadata: category and payload field descriptors. */',
  `export const EVENTS = ${JSON.stringify(events, null, 2)};`,
  '',
  '/* Request type names grouped by category. */',
  `export const REQUEST_CATEGORIES = ${JSON.stringify(categories, null, 2)};`,
  '',
  '/* Event type names grouped by category. */',
  `export const EVENT_CATEGORIES = ${JSON.stringify(eventCategories, null, 2)};`,
  '',
  '/** List of every request type in the protocol. */',
  'export const REQUEST_TYPES = Object.freeze(Object.keys(REQUESTS));',
  '',
  '/** List of every event type in the protocol. */',
  'export const EVENT_TYPES = Object.freeze(Object.keys(EVENTS));',
].join('\n');

writeFileSync(OUT, body);

const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
console.log(
  `protocol.js written: ${Object.keys(requests).length} requests, ` +
    `${Object.keys(events).length} events, ${proto.enums.length} enums (${kb} KiB)`
);
