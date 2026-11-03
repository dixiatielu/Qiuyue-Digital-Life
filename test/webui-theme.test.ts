import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, normalizeColor, normalizeAppearance, themeTokens, contrastRatio, readAppearance, saveAppearance } from '../src/webui/public/theme.js';

test('appearance accepts HEX colors and rejects CSS or malformed stored values', () => {
  assert.equal(normalizeColor(' abc '), '#AABBCC');
  assert.equal(normalizeColor('#53afB5'), '#53AFB5');
  for (const value of ['', '#1234', '#12345G', 'red', 'url(https://example.com)', null, 123]) assert.equal(normalizeColor(value), null);
  assert.deepEqual(normalizeAppearance({ accent: 'invalid', mode: 'auto' }), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ accent: '#ABC', mode: 'dark' }), { accent: '#AABBCC', mode: 'dark' });
});

test('custom colors keep primary buttons and accent text readable in light and dark modes', () => {
  const colors = ['#536FB5', '#8064B2', '#BA6F8D', '#315F4B', '#B88637', '#646874', '#FFFFFF', '#000000', '#FFFF00', '#00FF00', '#FF0000'];
  for (let i = 0; i < 64; i++) colors.push(`#${((i * 2654435761) >>> 8).toString(16).padStart(6, '0')}`);
  for (const color of colors) for (const dark of [false, true]) {
    const tokens = themeTokens(color, dark);
    assert.ok(contrastRatio(tokens['accent-fill'], tokens['on-accent']) >= 4.5, `${color} primary button`);
    for (const surface of ['bg', 'panel', 'accent-soft']) assert.ok(contrastRatio(tokens.accent, tokens[surface]) >= 4.5, `${color} / ${dark} / ${surface}`);
    assert.ok(contrastRatio(tokens['nav-text'], tokens['nav-active']) >= 4.5, `${color} navigation`);
  }
});

test('appearance round-trips only its own browser preference and tolerates denied storage', () => {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value) };
  assert.deepEqual(readAppearance(storage), DEFAULT_APPEARANCE);
  assert.equal(saveAppearance(storage, { accent: '#abc', mode: 'dark' }), true);
  assert.equal(map.size, 1);
  assert.deepEqual(readAppearance(storage), { accent: '#AABBCC', mode: 'dark' });
  map.set(APPEARANCE_KEY, '{broken');
  assert.deepEqual(readAppearance(storage), DEFAULT_APPEARANCE);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(readAppearance(blocked), DEFAULT_APPEARANCE);
  assert.equal(saveAppearance(blocked, DEFAULT_APPEARANCE), false);
});
