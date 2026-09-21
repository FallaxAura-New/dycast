const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPersistentSettingsStore } = require('../persistent-settings.cjs');
const { normalizeBarkUrl, buildWinnerNotification, createBarkService } = require('../bark.cjs');

function harness(fetchImpl, options = {}) {
  const document = { sections: {} };
  const store = {
    read: () => document,
    updateSection: (name, patch) => { document.sections[name] = { ...document.sections[name], ...patch }; }
  };
  const service = createBarkService({
    getStore: () => store,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    },
    fetchImpl, ...options
  });
  return { service, document };
}
const winner = { winRecordId: 'win-1', nickname: '观众', avatar: 'https://p3.douyinpic.com/avatar.jpg?signature=test', content: '我要中奖', drawNo: 2, batchPosition: 1, batchSize: 3, wonAt: 1700000000000 };

test('Bark accepts keyed self-hosted URLs but rejects credentials and query strings', () => {
  assert.equal(normalizeBarkUrl(' https://api.day.app/my-key/ '), 'https://api.day.app/my-key');
  assert.equal(normalizeBarkUrl('http://localhost:8080/bark/key'), 'http://localhost:8080/bark/key');
  for (const url of ['bad', 'file:///secret', 'https://api.day.app/', 'https://a:key@api.day.app/key', 'https://api.day.app/key?x=1']) {
    assert.throws(() => normalizeBarkUrl(url));
  }
});

test('Bark sends bounded JSON only after enabling, and deduplicates concurrent reveals', async () => {
  const requests = [];
  const { service, document } = harness(async (url, config) => {
    requests.push({ url, config });
    return new Response('{"code":200}', { status: 200 });
  });
  assert.deepEqual(await service.notifyWinner(winner, 4), { skipped: true });
  assert.throws(() => service.save({ enabled: true }));
  service.save({ pushUrl: 'https://api.day.app/private-key', enabled: true });
  assert.ok(!JSON.stringify(document).includes('private-key'));
  assert.ok(!JSON.stringify(service.getState()).includes('private-key'));
  await Promise.all([service.notifyWinner(winner, 4), service.notifyWinner(winner, 4)]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].config.method, 'POST');
  assert.equal(requests[0].config.redirect, 'error');
  const payload = JSON.parse(requests[0].config.body);
  assert.match(payload.body, /剩余名额：4/);
  assert.match(payload.body, /我要中奖/);
  assert.equal(payload.icon, winner.avatar);
  assert.equal(service.getState().lastResult.success, true);
  service.save({ enabled: false });
  await service.notifyWinner({ ...winner, winRecordId: 'win-2' }, 3);
  assert.equal(requests.length, 1);
  await service.test();
  assert.equal(requests.length, 2, 'manual test works while automatic pushes are disabled');
  service.save({ pushUrl: '' });
  assert.equal(service.getState().configured, false);
  assert.equal(service.getState().enabled, false);
});

test('failed Bark requests are contained, hide device keys and release timeout resources', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('failed https://api.day.app/private-key'); },
    async () => new Response('{"code":400,"message":"private-key invalid"}'),
    async () => new Response('x'.repeat(17000)),
    async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort'))))
  ]) {
    const { service } = harness(fetchImpl, { timeoutMs: 20 });
    service.save({ pushUrl: 'https://api.day.app/private-key', enabled: true });
    const result = await service.notifyWinner(winner, 2);
    assert.equal(result.success, false);
    assert.ok(!result.message.includes('private-key'));
    assert.equal(service.getState().lastResult.success, false);
  }
});

test('winner payload fits notification size and excludes unverified IDs and badge data', () => {
  const payload = buildWinnerNotification({ ...winner, content: '🎉'.repeat(10000), nickname: '观'.repeat(1000), userId: 'internal', fansClub: [{ level: 30 }] }, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4096);
  assert.match(payload.body, /抖音号：未获取/);
  assert.ok(!payload.body.includes('灯牌'));
  const verified = buildWinnerNotification({ ...winner, userId: '12345', userIdVerified: true, userIdSource: 'displayId' }, 1);
  assert.match(verified.body, /抖音号：12345/);
});

test('Bark avatars use trusted HTTPS icons and gracefully omit unsafe or oversized URLs', () => {
  for (const avatar of ['', undefined, 'file:///C:/secret', 'http://localhost/avatar',
    'data:image/png;base64,aaaa', 'https://evil.example/a.jpg',
    'https://p3.douyinpic.com.evil.example/a.jpg', 'https://user:key@p3.douyinpic.com/a.jpg',
    `https://p3.douyinpic.com/${'a'.repeat(1200)}`]) {
    const payload = buildWinnerNotification({ ...winner, avatar }, 1);
    assert.equal(payload.icon, undefined);
    assert.match(payload.body, /昵称：观众/);
  }
  const payload = buildWinnerNotification({ ...winner,
    avatar: `https://p3.douyinpic.com/${'a'.repeat(990)}`,
    nickname: '🎉'.repeat(1000), content: '🎉'.repeat(10000)
  }, 9999);
  assert.ok(payload.icon);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4096);
});

test('Bark settings survive reopening the public settings store and send to a local HTTP endpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dycast-bark-test-'));
  let received;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received = { url: request.url, payload: JSON.parse(body) };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"code":200}');
    });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = {
      getStore: () => createPersistentSettingsStore(root),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
      fetchImpl: fetch
    };
    createBarkService(config).save({ enabled: true, pushUrl: `http://127.0.0.1:${server.address().port}/device-test-key` });
    const reopened = createBarkService(config);
    assert.equal(reopened.getState().enabled, true);
    assert.equal(reopened.getState().configured, true);
    assert.equal((await reopened.notifyWinner(winner, 1)).success, true);
    assert.equal(received.url, '/device-test-key');
    assert.match(received.payload.body, /昵称：观众/);
    assert.equal(received.payload.icon, winner.avatar);
    assert.ok(!fs.readFileSync(path.join(root, 'settings.json'), 'utf8').includes('device-test-key'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
