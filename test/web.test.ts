import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { WebReader } from '../src/web.js';
import { config } from './helpers.js';

// Keep the real HTTP transport while mapping a public test hostname to a local fixture.
test('DeepSeek search sends authenticated JSON and handles results and failures', async t => {
  let status = 200; let body: unknown = { results: [] }; let redirect = false;
  const requests: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: unknown }[] = [];
  const server = http.createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: JSON.parse(data) });
    response.writeHead(status, { 'Content-Type': 'application/json', ...(redirect ? { Location: '/other' } : {}) });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const originalRequest = http.request;
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => originalRequest(url, {
    ...options, autoSelectFamily: false, lookup: (_hostname, _options, done) => done(null, '127.0.0.1', 4),
  }, callback));
  syncBuiltinESMExports();
  const cfg = { ...config().web, enabled: true, searchUrl: `http://search.example:${address.port}/v1/tools/search`, searchKeyEnv: 'TEST_DEEPSEEK_KEY' };
  const oldKey = process.env.TEST_DEEPSEEK_KEY; process.env.TEST_DEEPSEEK_KEY = 'test-key';
  const reader = new WebReader(cfg);
  try {
    const result = { title: 'Reference', url: 'https://example.com', summary: 'Detailed summary', snippet: 'Short summary' };
    body = { results: [result, { ...result, summary: '' }, ...Array(5).fill(result)] };
    const results = await reader.search('Qiuyue site:example.com');
    assert.equal(results.length, 5);
    assert.deepEqual(results[0], { title: result.title, url: result.url, description: result.summary });
    assert.equal(results[1]!.description, result.snippet);
    assert.deepEqual(requests[0], {
      method: 'POST', url: '/v1/tools/search',
      headers: { ...requests[0]!.headers, authorization: 'Bearer test-key', 'content-type': 'application/json', accept: 'application/json' },
      body: { query: 'Qiuyue site:example.com', count: 5, need_content: false },
    });
    assert.equal(requests[0]!.headers['x-subscription-token'], undefined);
    body = { results: [] }; assert.deepEqual(await reader.search('No match'), []);
    body = { web: { results: [] } }; await assert.rejects(reader.search('Invalid format'), /invalid results format/);
    body = { results: [{ title: 'Missing link' }] }; await assert.rejects(reader.search('Invalid format'), /invalid results format/);
    status = 401; await assert.rejects(reader.search('Authentication error'), /HTTP 401/);
    status = 429; await assert.rejects(reader.search('Rate limited'), /HTTP 429/);
    status = 302; redirect = true;
    const count = requests.length; await assert.rejects(reader.search('Redirect'), /cannot redirect/);
    assert.equal(requests.length, count + 1);
    status = 200; redirect = false; body = { results: [] };
    await reader.search('😀'.repeat(128));
    const before = requests.length;
    for (const query of ['', '   ', 'a'.repeat(129), '😀'.repeat(129)]) await assert.rejects(reader.search(query), /128/);
    delete process.env.TEST_DEEPSEEK_KEY;
    await assert.rejects(reader.search('Missing credential'), /search credential.*not configured/);
    assert.equal(requests.length, before);
    await assert.rejects(new WebReader({ ...cfg, enabled: false }).search('Disabled'), /disabled/);
    process.env.TEST_DEEPSEEK_KEY = 'test-key';
    await assert.rejects(new WebReader({ ...cfg, maxBytes: 1 }).search('Response too large'), /size limit/);
    await assert.rejects(reader.search('Cancel', AbortSignal.abort()), /abort/i);
  } finally {
    if (oldKey === undefined) delete process.env.TEST_DEEPSEEK_KEY; else process.env.TEST_DEEPSEEK_KEY = oldKey;
    t.mock.restoreAll(); syncBuiltinESMExports();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
