const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function load(file, dependencies, fetch) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function('exports', 'module', 'require', 'fetch', 'navigator', code)(
    module.exports, module, name => {
      assert.ok(Object.hasOwn(dependencies, name), name);
      return dependencies[name];
    }, fetch, { appCodeName: 'Mozilla' });
  return module.exports;
}
const util = load('src/core/util.ts', {});
const bounded = load('src/core/boundedResponse.ts', {});
const viewerId = '1234567890123456789';
const emptyPage = JSON.stringify({ userStore: { odin: { user_unique_id: viewerId } }, roomInfo: {} });
function setup(replies) {
  const calls = [];
  const request = load('src/core/request.ts', {
    './abogus': {}, './model': {}, './signature': {}, './util': util,
    './boundedResponse': bounded
  }, async (url, options) => {
    calls.push({ url, options });
    if (options.signal?.aborted) throw options.signal.reason;
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
  return { request, calls };
}
const room = { id_str: '7499001122334455667', status: 2, title: '测试直播' };

test('uses public room fallback after two empty pages, preserving actual viewer and abort signal', async () => {
  const { request, calls } = setup([emptyPage, emptyPage, {
    status_code: 0, data: { data: [room], user: { nickname: '主播' } }
  }]);
  const controller = new AbortController();
  const info = await request.getLiveInfo('83720965753', controller.signal);
  assert.equal(info.roomId, room.id_str);
  assert.equal(info.uniqueId, viewerId);
  assert.equal(info.nickname, '主播');
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /webcast\/room\/web\/enter/);
  assert.equal(new URL(calls[2].url, 'http://localhost').searchParams.get('web_rid'), '83720965753');
  assert.ok(calls.every(call => call.options.signal === controller.signal));
});

test('valid page does not need fallback; ended status is preserved', async () => {
  const { request, calls } = setup([JSON.stringify({
    userStore: { odin: { user_unique_id: viewerId } }, roomInfo: { room: { ...room, status: 4 } }
  })]);
  assert.equal((await request.getLiveInfo('123')).status, 4);
  assert.equal(calls.length, 1);
});

test('never invents a visitor ID for challenge pages', async () => {
  const { request, calls } = setup(['<html>验证</html>', '<html>验证</html>']);
  await assert.rejects(request.getLiveInfo('123'), /访客会话/);
  assert.equal(calls.length, 2);
});

test('empty target does not connect to API recommendations', async () => {
  const { request } = setup([emptyPage, emptyPage, {
    status_code: 0, data: { data: [], similar_rooms: [room] }
  }]);
  await assert.rejects(request.getLiveInfo('123'), /未返回该房间/);
});

test('malformed and denied API responses have actionable errors', async () => {
  for (const [payload, message] of [['<html>验证</html>', /未返回有效数据/],
    [{ status_code: 1 }, /暂未允许读取/]]) {
    const { request } = setup([emptyPage, emptyPage, payload]);
    await assert.rejects(request.getLiveInfo('123'), message);
  }
});

test('canceling a lookup prevents further fallback requests', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Canceled', 'AbortError'));
  const { request, calls } = setup([emptyPage]);
  await assert.rejects(request.getLiveInfo('123', controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('fallback responses retain the bounded response size limit', async () => {
  const { request } = setup([emptyPage, emptyPage, 'x'.repeat(8 * 1024 * 1024 + 1)]);
  await assert.rejects(request.getLiveInfo('123'), /limit|exceed|过大|上限/i);
});
