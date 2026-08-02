/**
 * i18n (spec §Bilingual Support).
 *
 * Every UI string is a key. No hardcoded display text anywhere in screens —
 * `npm run test` enforces that en.json and zh.json have identical key sets,
 * so a missing translation fails CI instead of silently shipping English
 * text to Chinese users.
 */

import en from '../i18n/en.json' with { type: 'json' };
import zh from '../i18n/zh.json' with { type: 'json' };

export const LOCALES = Object.freeze({ en, zh });
export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = Object.keys(LOCALES);

/** Replace {{placeholders}} with values from `vars`. */
export function interpolate(template, vars = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/**
 * Translate a key. Falls back to the default locale, then to the key itself,
 * so a missing string degrades to something debuggable rather than "undefined".
 */
export function translate(locale, key, vars) {
  const table = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  const value =
    table[key] !== undefined ? table[key] : LOCALES[DEFAULT_LOCALE][key];
  if (value === undefined) return key;
  return vars ? interpolate(value, vars) : value;
}

/** Bind a locale once: `const t = createTranslator('zh'); t('nav.home')`. */
export function createTranslator(locale) {
  return (key, vars) => translate(locale, key, vars);
}

/** Pick the best supported locale from a device locale like "zh-Hans-CN". */
export function resolveLocale(deviceLocale) {
  if (typeof deviceLocale !== 'string') return DEFAULT_LOCALE;
  const lower = deviceLocale.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}
