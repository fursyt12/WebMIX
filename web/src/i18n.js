/*
 * WebMIX - the interface language.
 *
 * The page says what the desktop window says, in the language OBS is running
 * in, by using OBS's own locale files: the host serves them (`/api/locale`)
 * and nothing is translated a second time here.
 *
 * Two ways in:
 *
 *  - `t('Basic.Main.StartStreaming')` looks a string up by OBS's key, and fills
 *    `%1`, `%2`, ... from the extra arguments. This is the precise one.
 *  - `tr('Start Streaming')` looks it up by its English text. The interface was
 *    written in English, almost always with OBS's exact wording, so the DOM
 *    helpers pass every label through this and the whole page follows the
 *    language without each call site naming a key. Text that is not an OBS
 *    string comes back unchanged.
 *
 * Names the user chose (scenes, sources, profiles...) must not go through
 * `tr`: a scene called "Scene" is not "Сцена". Those call sites say `raw`.
 */

let locale = 'en-US';
let english = {};
let strings = {};
let byEnglish = new Map();

/*! Drop Qt's keyboard accelerators: "&File" and "Файл (&F)" are both a word. */
export function plain(text) {
  return String(text ?? '')
    .replace(/\s*\(&\w\)/g, '')
    .replace(/&(.)/g, '$1');
}

/** Install a locale: `{ locale, english: {key: text}, strings: {key: text} }`. */
export function setLocale(data) {
  locale = data?.locale || 'en-US';
  english = data?.english ?? {};
  strings = data?.strings ?? {};
  byEnglish = new Map();
  for (const [key, text] of Object.entries(english)) {
    const source = plain(text);
    /* Several keys share an English text ("None", "Default"); the first one
     * in the file is the general one, the later ones are special cases. */
    if (!source || byEnglish.has(source)) continue;
    const translated = plain(strings[key] ?? text);
    if (translated !== source) byEnglish.set(source, translated);
  }
}

/** Fetch the host's locale. Resolves false when there is none to fetch. */
export async function loadLocale(base = '') {
  try {
    const response = await fetch(`${base}api/locale`, { cache: 'no-store' });
    if (!response.ok) return false;
    const data = await response.json();
    if (!data?.strings) return false;
    setLocale(data);
    return true;
  } catch {
    return false;
  }
}

export function currentLocale() {
  return locale;
}

/** Whether OBS has a string under this key. */
export function hasKey(key) {
  return key in strings || key in english;
}

/**
 * A string by OBS's locale key, with `%1`... replaced by the arguments.
 * An unknown key comes back as the fallback (or the key itself).
 */
export function t(key, ...args) {
  let fallback;
  if (args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) {
    fallback = args.pop().fallback;
  }
  let text = strings[key] ?? english[key];
  if (text === undefined) text = fallback ?? key;
  text = plain(text);
  args.forEach((value, index) => {
    text = text.replaceAll(`%${index + 1}`, String(value));
  });
  return text;
}

/** A string by its English text; unchanged when OBS has no such string. */
export function tr(text) {
  if (typeof text !== 'string' || !byEnglish.size) return text;
  return byEnglish.get(text) ?? text;
}
