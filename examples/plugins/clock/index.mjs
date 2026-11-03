/** @type {import('qiuyue-digital-life/plugin-sdk').PluginDefinition} */
export default {
  id: 'clock',
  apiVersion: 1,
  name: '时钟',
  description: '读取指定时区的日期和时间。',
  version: '1.0.0',
  defaults: { timeZone: 'Asia/Shanghai' },
  configSchema: {
    type: 'object', additionalProperties: false,
    properties: { timeZone: { type: 'string', title: '时区', description: '例如 Asia/Shanghai 或 Europe/London。' } },
    required: ['timeZone'],
  },
  setup(ctx) {
    const format = new Intl.DateTimeFormat('zh-CN', {
      timeZone: ctx.settings.timeZone, dateStyle: 'full', timeStyle: 'long',
    });
    ctx.tool({
      name: 'clock_read', description: 'Read the current local date and time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      readOnly: true, review: true,
      execute(_args, call) { return call.record('reading', { time: format.format(new Date()) }); },
    });
  },
};
