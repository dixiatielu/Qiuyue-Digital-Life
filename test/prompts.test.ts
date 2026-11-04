import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { fauxAssistantMessage as answer } from '@earendil-works/pi-ai';
import { systemInstructions } from '../src/prompts.js';
import { scopePlugin } from '../src/adapters/scope.js';
import { PluginHost, type LifePlugin } from '../src/plugins.js';
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
