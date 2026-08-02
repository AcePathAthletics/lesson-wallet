import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALES,
  SUPPORTED_LOCALES,
  translate,
  createTranslator,
  interpolate,
  resolveLocale,
  DEFAULT_LOCALE,
} from '../src/core/i18n.js';

test('both locales ship', () => {
  assert.deepEqual(SUPPORTED_LOCALES.sort(), ['en', 'zh']);
});

test('en and zh have identical key sets — a missing translation fails CI', () => {
  const enKeys = Object.keys(LOCALES.en).sort();
  const zhKeys = Object.keys(LOCALES.zh).sort();
  const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
  const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
  assert.deepEqual(missingInZh, [], `keys missing from zh.json: ${missingInZh}`);
  assert.deepEqual(missingInEn, [], `keys missing from en.json: ${missingInEn}`);
});

test('no locale value is an empty string', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const [key, value] of Object.entries(table)) {
      assert.ok(String(value).trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test('zh strings are actually translated, not copied from en', () => {
  // Brand-ish keys may legitimately match; these content keys must not.
  const mustDiffer = ['nav.home', 'lesson.complete', 'auth.logIn', 'import.title'];
  for (const key of mustDiffer) {
    assert.notEqual(LOCALES.zh[key], LOCALES.en[key], `${key} looks untranslated`);
  }
});

test('translate returns the right string per locale', () => {
  assert.equal(translate('en', 'nav.home'), 'Home');
  assert.equal(translate('zh', 'nav.home'), '首页');
});

test('translate falls back to default locale for an unknown locale', () => {
  assert.equal(translate('fr', 'nav.home'), 'Home');
});

test('translate falls back to the key itself when nothing matches', () => {
  assert.equal(translate('en', 'does.not.exist'), 'does.not.exist');
});

test('interpolation fills placeholders', () => {
  assert.equal(interpolate('Hello, {{name}}', { name: 'Amy' }), 'Hello, Amy');
});

test('interpolation leaves unknown placeholders intact rather than printing undefined', () => {
  assert.equal(interpolate('Hi {{name}}', {}), 'Hi {{name}}');
});

test('interpolation works through translate in both locales', () => {
  assert.equal(translate('en', 'student.hello', { name: 'Amy' }), 'Hello, Amy');
  assert.equal(translate('zh', 'student.hello', { name: 'Amy' }), '你好，Amy');
});

test('interpolated keys use the same placeholder names in every locale', () => {
  const placeholders = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort();
  for (const key of Object.keys(LOCALES.en)) {
    assert.deepEqual(
      placeholders(LOCALES.zh[key]),
      placeholders(LOCALES.en[key]),
      `placeholder mismatch in "${key}"`
    );
  }
});

test('createTranslator binds a locale', () => {
  const t = createTranslator('zh');
  assert.equal(t('nav.profile'), '我的');
  assert.equal(t('notify.lowCreditSelf', { count: 2 }), '你还剩 2 节课。');
});

test('device locales resolve to a supported locale', () => {
  assert.equal(resolveLocale('zh-Hans-CN'), 'zh');
  assert.equal(resolveLocale('zh-TW'), 'zh');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('fr-FR'), DEFAULT_LOCALE);
  assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);
});
