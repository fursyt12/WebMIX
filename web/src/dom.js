/*
 * WebMIX - tiny DOM helpers.
 *
 * The UI is dependency-free (no framework, no bundler) so the web app can be
 * served straight from the OBS install or from disk without a build step.
 * These helpers cover element creation, keyed list reconciliation and
 * event wiring.
 */

/**
 * Create an element.
 * @param {string} tag  tag name, optionally with `.class` and `#id` suffixes
 *                      e.g. 'div.obs-btn.primary#start'
 * @param {object|null} [props] attributes/properties; `class`, `style`,
 *                      `dataset`, `on` (event map) and `text` are special
 * @param {...(Node|string|null|undefined|Array)} children
 */
export function h(tag, props = null, ...children) {
  const [, name, rest] = /^([a-zA-Z0-9-]+)(.*)$/.exec(tag) ?? [null, 'div', ''];
  const el = document.createElement(name || 'div');

  for (const m of rest.matchAll(/([.#])([^.#]+)/g)) {
    if (m[1] === '.') el.classList.add(m[2]);
    else el.id = m[2];
  }

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') {
        for (const c of String(value).split(/\s+/).filter(Boolean)) el.classList.add(c);
      } else if (key === 'text') {
        el.textContent = String(value);
      } else if (key === 'html') {
        el.innerHTML = value;
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'on' && typeof value === 'object') {
        for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
      } else if (key === 'value') {
        el.value = value;
      } else if (key === 'checked' || key === 'disabled' || key === 'selected') {
        el[key] = !!value;
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }

  append(el, children);
  return el;
}

/** Append children, flattening arrays and skipping null/undefined/false. */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Remove every child of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Set text content only when it changed (avoids needless layout work). */
export function setText(node, text) {
  const next = text === null || text === undefined ? '' : String(text);
  if (node.textContent !== next) node.textContent = next;
  return node;
}

/** Toggle a class only when needed. */
export function setClass(node, name, on) {
  node.classList.toggle(name, !!on);
  return node;
}

/** Toggle a boolean/attribute property only when needed. */
export function setProp(node, prop, value) {
  if (node[prop] !== value) node[prop] = value;
  return node;
}

/**
 * Keyed list reconciliation: creates, moves, updates and removes DOM nodes so
 * that live-updating panels keep focus, drag state and scroll position.
 *
 * @param {Element} container
 * @param {Array} items
 * @param {(item: any, index: number) => string} keyOf
 * @param {(item: any, index: number) => Element} create   called once per key
 * @param {(node: Element, item: any, index: number) => void} [update]
 */
export function reconcile(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const node of Array.from(container.children)) {
    if (node.dataset.key !== undefined) existing.set(node.dataset.key, node);
  }

  const seen = new Set();
  let previous = null;

  items.forEach((item, index) => {
    const key = String(keyOf(item, index));
    seen.add(key);
    let node = existing.get(key);
    if (!node) {
      node = create(item, index);
      node.dataset.key = key;
    } else if (!node.isConnected) {
      // Re-attach a node that was moved out of the container.
    }
    if (update) update(node, item, index);

    const expected = previous ? previous.nextSibling : container.firstChild;
    if (node !== expected) container.insertBefore(node, expected);
    previous = node;
  });

  for (const [key, node] of existing) {
    if (!seen.has(key)) node.remove();
  }
  // Any leftover nodes not tracked by a key (e.g. headers) are left alone.
  return container;
}

/** Debounce a function by `ms`. */
export function debounce(fn, ms = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Trap Tab focus inside a modal element. */
export function trapFocus(root) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKey = (event) => {
    if (event.key !== 'Tab') return;
    const items = qsa(selector, root).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}

/** Human-readable duration from milliseconds: HH:MM:SS. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Parse an OBS timecode ('HH:MM:SS.mmm') into milliseconds.
 */
export function parseTimecode(timecode) {
  if (!timecode || typeof timecode !== 'string') return 0;
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(timecode.trim());
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return Number(hh) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + Number((ms ?? '0').padEnd(3, '0'));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Convert an OBS volume multiplier to decibels (OBS convention). */
export function mulToDb(mul) {
  return mul <= 0.000001 ? -100 : 20 * Math.log10(mul);
}

/** Convert decibels to an OBS volume multiplier. */
export function dbToMul(db) {
  return db <= -100 ? 0 : 10 ** (db / 20);
}
