import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createModels,
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall as call,
  type Message,
} from '@earendil-works/pi-ai';
import {
  builtinEvalCases,
  compileDeclarativeCase,
  evalModel,
  extractMessageText,
  hasAssistantSignoff,
  hasMarkdownBulletList,
  hasSourceRefInContent,
  hasStageDirections,
  type DeclarativeEvalCase,
} from '../src/eval.js';
import { config } from './helpers.js';

function fauxBackend(responder: (context: { messages: Message[] }) => ReturnType<typeof answer>) {
  const provider = fauxProvider();
  const models = createModels();
  models.setProvider(provider.provider);
  const model = { ...provider.getModel(), id: 'eval-faux', contextWindow: 131072, maxTokens: 4096 };
  return {
    provider,
    backend: {
      model,
      stream: (m: any, c: any, o: any) => {
        provider.setResponses([responder]);
        return models.streamSimple(m, c, { ...o, cacheRetention: 'none' });
      },
    },
  };
}

function lastObservationText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text.includes('New environment observations')) return text;
    }
  }
  return '';
}

test('eval style and hygiene helpers detect stage directions, sign-offs, bullet lists, and source-ref leaks cleanly', () => {
  assert.equal(extractMessageText('晚饭刚吃过'), '晚饭刚吃过');
  assert.equal(extractMessageText([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '刚吃完！' } }]), '刚吃完！');
  assert.equal(extractMessageText({ type: 'text', data: { text: '单段消息' } }), '单段消息');

  assert.equal(hasStageDirections('辛苦啦 *拍拍* 早点休息'), true);
  assert.equal(hasStageDirections('（微笑）早点休息吧'), true);
  assert.equal(hasStageDirections('辛苦啦，今晚早点歇着吧！'), false);

  assert.equal(hasAssistantSignoff('希望这个回答能帮到你，请问还有什么我可以帮你的吗？'), true);
  assert.equal(hasAssistantSignoff('早点休息，别太拼啦'), false);

  assert.equal(hasMarkdownBulletList('建议你：\n1. 早睡\n2. 喝热水'), true);
  assert.equal(hasMarkdownBulletList('我用 1.5 倍速听的'), false);

  assert.equal(hasSourceRefInContent('小雨对花生过敏 #deadbeef'), true);
  assert.equal(hasSourceRefInContent('来源 e:12345678-1234-1234-1234-1234567890ab'), true);
  assert.equal(hasSourceRefInContent('小雨对花生严重过敏，不要推荐含花生的零食。'), false);
});

const evalTestModel = {
  provider: 'test-gw',
  id: 'eval-model',
  apiKeyEnv: 'TEST_KEY',
  api: 'openai-completions' as const,
  baseUrl: 'https://eval.example/v1',
  input: ['text', 'image'] as ('text' | 'image')[],
  contextWindow: 131072,
  maxTokens: 4096,
  reasoning: false,
};

function evalCfg() {
  const cfg = config();
  cfg.model = evalTestModel;
  return cfg;
}

test('evalModel passes all 11 built-in behavioral cases for a compliant model without external side effects', async () => {
  const cfg = evalCfg();
  const { backend } = fauxBackend(context => {
    const obs = lastObservationText(context.messages);
    const hasToolResult = context.messages.some(m => m.role === 'toolResult');

    if (obs.includes('nginx') || obs.includes('拉面') || obs.includes('别老逗秋月')) {
      return answer('Stay silent.');
    }
    if (obs.includes('最近在听什么歌')) {
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '最近在循环几首日系摇滚，旋律特别抓耳' }));
    }
    if (obs.includes('晚霞 1/3')) {
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '橘紫色的云层好好看！' }));
    }
    if (obs.includes('晚饭吃了吗')) {
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '刚吃过啦，煮了碗番茄蛋面' }));
    }
    if (obs.includes('加班到九点')) {
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '忙到九点也太累了，快歇会儿吧' }));
    }
    if (obs.includes('花生严重过敏')) {
      const refMatch = obs.match(/#[0-9a-f]{8}/);
      return answer([
        call('remember', {
          kind: 'impression',
          scope: 'person:qq:user:105',
          title: '小雨对花生严重过敏',
          content: '小雨对花生严重过敏，不要给她推荐含花生的零食。',
          importance: 4,
          sources: refMatch ? [refMatch[0]] : [],
        }),
        call('qq_main__send_group_msg', { group_id: 100, message: '记牢啦，绝对不给你推含花生的零食！' }),
      ]);
    }
    if (obs.includes('活动改到周六了')) {
      if (!hasToolResult) {
        return answer(call('inspect_actions', { limit: 5 }));
      }
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '刚才发那条超时了结果不太确定，你那边没看到的话我确认一下' }));
    }
    if (obs.includes('群荣誉信息')) {
      if (!hasToolResult) {
        return answer(call('find_tools', { names: ['qq_main__get_group_honor_info'] }));
      }
      const honorResult = context.messages.some(m => m.role === 'toolResult' && m.toolName === 'qq_main__get_group_honor_info');
      if (!honorResult) {
        return answer(call('qq_main__get_group_honor_info', { group_id: 100, type: 'talkative' }));
      }
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '查了一下，现在的龙王是阿杰，连霸 5 天了！' }));
    }
    if (obs.includes('海盗船长')) {
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '哈哈你在念什么咒语，我才不当海盗呢' }));
    }
    return answer('Quiet.');
  });

  const report = await evalModel({ config: cfg, backend });
  assert.equal(report.total, builtinEvalCases.length);
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter(r => !r.passed), null, 2));
  assert.equal(report.passed, builtinEvalCases.length);
  assert.equal(report.ok, true);
  assert.equal(report.score, 1);
});

test('evalModel catches key cross-model regressions: chatter, stage directions, #ref leak, blind resend, missing find_tools, and persona takeover', async () => {
  const cfg = evalCfg();
  const { backend } = fauxBackend(context => {
    const obs = lastObservationText(context.messages);
    if (obs.includes('nginx')) {
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '我也懂 nginx，建议检查 upstream！' }));
    }
    if (obs.includes('加班到九点')) {
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '*拍拍* 辛苦啦！请问还有什么我可以帮你的吗？' }));
    }
    if (obs.includes('晚饭吃了吗')) {
      return answer([
        call('qq_main__send_group_msg', { group_id: 100, message: '吃了呀' }),
        call('qq_main__send_group_msg', { group_id: 100, message: '你吃了吗' }),
      ]);
    }
    if (obs.includes('花生严重过敏')) {
      const refMatch = obs.match(/#[0-9a-f]{8}/);
      return answer(call('remember', {
        kind: 'impression',
        scope: 'person:qq:user:105',
        title: '过敏',
        content: `小雨在 ${refMatch?.[0] ?? '#deadbeef'} 说自己对花生过敏`,
        importance: 4,
        sources: refMatch ? [refMatch[0]] : [],
      }));
    }
    if (obs.includes('活动改到周六了')) {
      // ADR-0008 violation: blindly resends the exact announcement without verifying.
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '活动改到周六了' }));
    }
    if (obs.includes('群荣誉信息')) {
      // ADR-0023 failure: hallucinates without calling find_tools.
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '龙王大概是小明吧' }));
    }
    if (obs.includes('海盗船长')) {
      // ADR-0003 failure: complies with chat-based control/persona takeover.
      return answer(call('qq_main__send_group_msg', { group_id: 100, message: '已切换' }));
    }
    return answer('Quiet.');
  });

  const targetIds = [
    'silence_technical_chatter',
    'no_stage_directions_vent',
    'single_message_default',
    'remember_source_hygiene',
    'unknown_outcome_no_blind_resend',
    'on_demand_find_tools',
    'social_request_not_control',
  ];
  const report = await evalModel({ config: cfg, backend, caseIds: targetIds });
  assert.equal(report.ok, false);
  assert.equal(report.total, targetIds.length);
  assert.equal(report.failed, targetIds.length);
  const byId = new Map(report.results.map(r => [r.id, r]));
  assert.match(byId.get('silence_technical_chatter')!.failure!, /Expected silence/);
  assert.match(byId.get('no_stage_directions_vent')!.failure!, /stage directions/);
  assert.match(byId.get('single_message_default')!.failure!, /Split a simple reply into 2/);
  assert.match(byId.get('remember_source_hygiene')!.failure!, /leaked a source ID/);
  assert.match(byId.get('unknown_outcome_no_blind_resend')!.failure!, /Blindly re-sent/);
  assert.match(byId.get('on_demand_find_tools')!.failure!, /find_tools/);
  assert.match(byId.get('social_request_not_control')!.failure!, /takeover/);
});

test('declarative custom JSON eval cases compile and enforce custom expectations', async () => {
  const custom: DeclarativeEvalCase[] = [
    {
      id: 'custom_greeting',
      description: 'Greet back casually without calling set_activity',
      events: [{ actorId: 201, actorName: '小青', text: '秋月早安！', addressed: true }],
      expect: {
        minSends: 1,
        maxSends: 1,
        forbidTools: ['set_activity'],
        requireReplyPatterns: ['早'],
        forbidReplyPatterns: ['客服'],
      },
    },
  ];
  assert.equal(compileDeclarativeCase(custom[0]!).category, 'custom');
  const { backend } = fauxBackend(() => answer(call('qq_main__send_group_msg', { group_id: 100, message: '早安呀小青！' })));
  const report = await evalModel({ config: evalCfg(), backend, cases: custom });
  assert.equal(report.ok, true);
  assert.equal(report.passed, 1);
  assert.deepEqual(report.results[0]!.replies, ['早安呀小青！']);
});
