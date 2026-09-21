const assert = require('node:assert/strict');
const test = require('node:test');
const helper = import('../src/utils/virtualScrollerCache.ts');

test('100000 comments keep virtual row sizes and undefined bookkeeping bounded', async () => {
  const { pruneVirtualScrollerCache, appendRecentItems } = await helper;
  const scroller = { vscrollData: { sizes: {} }, $_undefinedMap: {}, $_undefinedSizes: 0 };
  const retained = [];
  for (let start = 0; start < 100000; start += 500) {
    const ids = Array.from({ length: 500 }, (_, index) => String(start + index));
    for (const id of ids) {
      scroller.vscrollData.sizes[id] = 30 + Number(id) % 70;
      scroller.$_undefinedMap[id] = false;
    }
    appendRecentItems(retained, ids, 2000);
    pruneVirtualScrollerCache(scroller, retained);
    assert.ok(Object.keys(scroller.vscrollData.sizes).length <= 2000);
    assert.ok(Object.keys(scroller.$_undefinedMap).length <= 2000);
    assert.equal(scroller.vscrollData.sizes[ids.at(-1)], 30 + Number(ids.at(-1)) % 70);
  }
  scroller.$_undefinedMap.stale = true;
  scroller.$_undefinedSizes = 1;
  pruneVirtualScrollerCache(scroller, retained);
  assert.equal(scroller.$_undefinedSizes, 0);
  pruneVirtualScrollerCache(scroller, []);
  assert.deepEqual(scroller.vscrollData.sizes, {});
});

test('a hidden window with no animation frames keeps only the latest pending messages', async () => {
  const { appendRecentItems } = await helper;
  const pending = [];
  for (let index = 0; index < 100000; index += 100) {
    appendRecentItems(pending, Array.from({ length: 100 }, (_, offset) => index + offset), 2000);
    assert.ok(pending.length <= 2000);
  }
  assert.equal(pending[0], 98000);
  assert.equal(pending.at(-1), 99999);
  appendRecentItems(pending, Array.from({ length: 300000 }, (_, index) => index), 2000);
  assert.equal(pending[0], 298000);
  assert.equal(pending.length, 2000);
});
