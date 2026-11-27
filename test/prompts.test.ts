import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { fauxAssistantMessage as answer } from '@earendil-works/pi-ai';
import { builtinSystemPrompt, checkSystemPrompt, systemInstructions } from '../src/prompts.js';
import { scopePlugin } from '../src/adapters/scope.js';
import { PluginHost, type LifePlugin } from '../src/plugins.js';
import { createPlugins } from '../src/plugins/index.js';
import { Store } from '../src/store.js';
import { config, event, fixture } from './helpers.js';

test('activity instructions are literal additions to built-in and custom templates', () => {
  const cfg = config();
  cfg.persona = 'A person called $& {{persona}}.';
  cfg.systemPrompt = '{{persona}}\n<!-- current-context -->\nRules.<!-- allow-fiction --> Fiction.<!-- /allow-fiction -->';
  cfg.life.allowFiction = false;
  const instructions = 'Keep $& {{persona}} and <!-- allow-fiction -->literal<!-- /allow-fiction -->.';
  const activities = [{ plugin: 'reading', activity: 'Read a book', tools: ['read_book'], instructions }];
  const text = systemInstructions(cfg, activities);
  assert.ok(text.startsWith('A person called $& {{persona}}.\nRules.'));
  assert.ok(!text.includes('Rules. Fiction.'));
  assert.ok(text.includes(instructions));
  assert.ok(text.includes('Read a book (reading)') && text.includes('Available tools: read_book'));
  assert.equal(systemInstructions(cfg), 'A person called $& {{persona}}.\nRules.');
});

test('ordinary thoughts receive activity guidance, life wakes add state without repeating it, and unavailable activities disappear', async () => {
  let available = true, enabled = true;
  const instructions = 'Reading-room instructions: follow whatever book catches your interest.';
  const f = fixture(undefined, undefined, undefined, () => [{
    id: 'reading-room', enabled: () => enabled,
    tools: runtime => [{ ...runtime.jsonTool('read_book', 'Read a book', Type.Object({}), () => ({})), available: () => available }],
    activities: [{ activity: 'Read a book', tools: ['read_book', 'missing_tool'], instructions }],
  }]);
  try {
    assert.deepEqual(f.brain.activityPrompts().find(item => item.plugin === 'reading-room')?.tools, ['read_book']);
    f.faux.setResponses([context => {
      assert.ok(f.brain.agent.state.systemPrompt.includes(instructions));
      assert.equal(JSON.stringify(context.messages).split(instructions).length - 1, 1);
      return answer('Quiet');
    }]);
    event(f.store); await f.brain.run(f.store.claim(10)!);
    f.store.setSetting('lifeEnabled', true); f.store.schedule('Free time', 'life', Date.now()); f.store.enqueueDue();
    f.faux.setResponses([context => {
      const observation = JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations')));
      assert.ok(observation.includes('Read a book') && observation.includes('lastDone'));
      assert.ok(!observation.includes(instructions));
      assert.ok(!observation.includes('never comes to you by itself'));
      return answer('Rest');
    }]);
    await f.brain.run(f.store.claim(10)!);
    available = false;
    assert.equal(f.brain.refreshTools(), true);
    assert.ok(!f.brain.agent.state.systemPrompt.includes(instructions));
    assert.ok(!f.plugins.activities([], new Set(f.tools.current().map(tool => tool.name))).some(item => item.activity === 'Read a book'));
    available = true; f.brain.refreshTools();
    enabled = false; f.brain.refreshTools();
    assert.ok(!f.brain.agent.state.systemPrompt.includes(instructions));
  } finally { f.store.close(); }
});

test('activity guidance names the correct adapter account and filters its unavailable tools', () => {
  const plugin: LifePlugin = { id: 'reading', tools: () => [], activities: [{ activity: 'Read a book', tools: ['read_book', 'save_book'], instructions: 'Use read_book when curious.' }] };
  const actions = ['read_book', 'save_book'].map(name => ({ name, inputSchema: Type.Object({}), readOnly: true, invariants: [] }));
  const adapter = { execute: async () => ({}) };
  const host = new PluginHost([scopePlugin(plugin, 'first', actions, adapter), scopePlugin(plugin, 'second', actions, adapter)]);
  const prompts = host.activityPrompts(new Set(['second__read_book']));
  assert.deepEqual(prompts, [{ plugin: 'second-reading', activity: 'Read a book', tools: ['second__read_book'], instructions: 'Use second__read_book when curious.' }]);
});

test('built-in system prompt and example persona preserve prompt markers and render cleanly', () => {
  checkSystemPrompt(builtinSystemPrompt);
  const examplePersona = readFileSync(new URL('../persona.example.md', import.meta.url), 'utf8');
  const baseCfg = { ...config(), persona: examplePersona, systemPrompt: undefined };
  const withoutFiction = systemInstructions({ ...baseCfg, life: { ...baseCfg.life, allowFiction: false } });
  const withFiction = systemInstructions({ ...baseCfg, life: { ...baseCfg.life, allowFiction: true } });

  for (const rendered of [withoutFiction, withFiction]) {
    assert.ok(rendered.includes(examplePersona));
    assert.ok(!rendered.includes('{{persona}}'));
    assert.ok(!rendered.includes('<!-- current-context -->'));
    assert.ok(!rendered.includes('<!-- allow-fiction -->'));
    assert.ok(!rendered.includes('<!-- /allow-fiction -->'));
  }
  assert.ok(!withoutFiction.includes('Save fictional daily life with remember as fiction'));
  assert.ok(withFiction.includes('Save fictional daily life with remember as fiction'));
  // Platform-specific guidance must come from enabled adapters rather than being hardcoded in system.md.
  assert.ok(!builtinSystemPrompt.includes('SnowLuma'));
  assert.ok(!builtinSystemPrompt.includes('Telegram upload objects'));
});

test('adapter platform notes are injected dynamically, deduplicated, and kept literal', () => {
  const store = new Store(':memory:');
  try {
    const qqOnly = config();
    const qqHost = createPlugins(qqOnly, store, undefined, () => undefined, () => ({ execute: async () => ({}) }));
    assert.ok(qqHost.platformNotes().some(note => note.includes('SnowLuma')));
    assert.ok(!qqHost.platformNotes().some(note => note.includes('Telegram')));

    const tgOnly = config();
    tgOnly.adapters = [{
      id: 'tg_main', driver: 'telegram', accountId: '42', url: 'https://api.telegram.org',
      tokenEnv: 'TG_TOKEN', groups: [], tools: { allow: '*', deny: [] }, maxStreamBytes: 10_000_000, maxFileBytes: 50_000_000, receive: 'polling',
    }];
    const tgHost = createPlugins(tgOnly, store, undefined, () => undefined);
    assert.ok(tgHost.platformNotes().some(note => note.includes('Telegram')));
    assert.ok(!tgHost.platformNotes().some(note => note.includes('SnowLuma')));

    // Deduplication and literal rendering (no {{persona}} expansion inside platform notes).
    const host = new PluginHost([
      { id: 'a', tools: () => [], promptNotes: ['Note for {{persona}}.', 'Shared note.'] },
      { id: 'b', tools: () => [], promptNotes: ['Shared note.'] },
      { id: 'c', enabled: () => false, tools: () => [], promptNotes: ['Disabled note.'] },
    ]);
    assert.deepEqual(host.platformNotes(), ['Note for {{persona}}.', 'Shared note.']);
    const rendered = systemInstructions(qqOnly, [], [], host.platformNotes());
    assert.ok(rendered.includes('## Platform Notes'));
    assert.ok(rendered.includes('- Note for {{persona}}.'));
    assert.ok(!rendered.includes('Disabled note.'));
  } finally {
    store.close();
  }
});
