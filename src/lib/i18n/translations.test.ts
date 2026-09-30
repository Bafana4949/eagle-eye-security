import { describe, it } from 'node:test';
import assert from 'node:assert';
import { translations } from './translations';

describe('Translation dictionaries', () => {
  const enKeys = Object.keys(translations.en).sort();

  for (const lang of ['af', 'zu'] as const) {
    it(`${lang} defines every English key`, () => {
      const dict = translations[lang] as Record<string, string>;
      const missing = enKeys.filter((k) => typeof dict[k] !== 'string' || dict[k].trim() === '');
      assert.deepStrictEqual(missing, [], `${lang} is missing: ${missing.join(', ')}`);
    });

    it(`${lang} keeps the same {n} placeholders as English`, () => {
      const dict = translations[lang] as Record<string, string>;
      const placeholders = (s: string) => (s.match(/\{\d+\}/g) || []).sort().join(',');
      const mismatched = enKeys.filter(
        (k) => typeof dict[k] === 'string' && placeholders(dict[k]) !== placeholders((translations.en as Record<string, string>)[k])
      );
      assert.deepStrictEqual(mismatched, [], `${lang} placeholder mismatch: ${mismatched.join(', ')}`);
    });
  }
});
