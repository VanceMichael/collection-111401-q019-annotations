import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { openBrowser } from '../src/browser.mjs';
import { collectAnnotations } from '../src/annotations.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change)
  });
  assert.equal(response.status, 200);
}

async function collectWith(provider, prepare) {
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    if (prepare) await prepare(page);
    await page.goto(provider.base + '/portal');
    return await collectAnnotations(page);
  } finally {
    await browser.close();
  }
}

test('采集保存作者、线程状态与回指原文的文本锚点', async () => {
  const provider = await createProvider();
  try {
    const collection = await collectWith(provider);
    assert.equal(collection.kind, 'annotation-collection');
    assert.equal(collection.version, 'manual-1');
    assert.deepEqual(collection.complete, { segments: true, threads: true });
    assert.equal(collection.threads.length, 2);

    const [first, second] = collection.threads;
    assert.equal(first.id, 'n-1');
    assert.equal(first.author, '资料审核员');
    assert.equal(first.comment, '请确认额定值');
    assert.equal(first.status, 'open');
    assert.equal(first.quote, '设备功率为十瓦');
    assert.equal(first.section, 'power');
    assert.equal(first.version, 'manual-1');
    assert.deepEqual(first.anchor, {
      state: 'located', paragraph: 'main', section: 'power', start: 5, end: 12, text: '设备功率为十瓦'
    });

    // 第二条批注的正文在下一个分页：先取齐分页再定位，才不会误判原文缺失
    assert.equal(second.id, 'n-2');
    assert.equal(second.author, '复核员');
    assert.equal(second.status, 'resolved');
    assert.deepEqual(second.anchor, {
      state: 'located', paragraph: 'later', section: 'warranty', start: 0, end: 4, text: '保修范围'
    });
  } finally {
    await provider.close();
  }
});

test('相同文字有多处候选时记录歧义而不是任选一处', async () => {
  const provider = await createProvider();
  try {
    await controlled(provider, { mode: 'ambiguous' });
    const collection = await collectWith(provider);
    const [first] = collection.threads;
    assert.equal(first.anchor.state, 'ambiguous');
    assert.deepEqual(first.anchor.candidates, [
      { paragraph: 'main', section: 'power' },
      { paragraph: 'duplicate', section: 'power' }
    ]);
    // 没有真实选区时不伪造文本偏移
    assert.ok(!('start' in first.anchor) && !('end' in first.anchor));
    // 目录中的相同文字章节不同，不应成为候选
    assert.ok(!first.anchor.candidates.some(candidate => candidate.paragraph === 'toc'));
  } finally {
    await provider.close();
  }
});

test('切换版本后重新采集，旧选区结果不套用到新正文', async () => {
  const provider = await createProvider();
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(provider.base + '/portal');
    const before = await collectAnnotations(page);
    assert.equal(before.threads[0].anchor.state, 'located');

    await page.locator('#version').click();
    await page.waitForFunction(() => document.querySelector('#document').dataset.version === 'manual-2');
    const after = await collectAnnotations(page);

    assert.equal(after.version, 'manual-2');
    assert.equal(after.threads[0].version, 'manual-2');
    // 新正文把十瓦改为十二瓦，旧引用不再匹配
    assert.equal(after.threads[0].anchor.state, 'missing');
    assert.equal(after.threads[1].status, 'deleted');
    // 线程被删除不等于原文消失：引用仍能定位到保修段
    assert.equal(after.threads[1].anchor.state, 'located');
    assert.equal(after.threads[1].anchor.paragraph, 'later');
    // 旧采集结果保持旧版本，不被新内容改写
    assert.equal(before.version, 'manual-1');
    assert.equal(before.threads[0].anchor.text, '设备功率为十瓦');
  } finally {
    await browser.close();
    await provider.close();
  }
});

test('被删除的批注与尚未加载的批注分开记录', async () => {
  const provider = await createProvider();
  try {
    await controlled(provider, { generation: 2 });
    const collection = await collectWith(provider);
    // 分页取齐：不存在“暂时没加载”的批注
    assert.equal(collection.complete.threads, true);
    assert.equal(collection.threads.length, 2);
    // 删除由来源状态明示，保留在记录中而不是消失
    const deleted = collection.threads.filter(thread => thread.status === 'deleted');
    assert.deepEqual(deleted.map(thread => thread.id), ['n-2']);
  } finally {
    await provider.close();
  }
});

test('窗口重排不改变文本锚点', async () => {
  const provider = await createProvider();
  try {
    const narrow = await collectWith(provider, page => page.setViewportSize({ width: 400, height: 700 }));
    const wide = await collectWith(provider, page => page.setViewportSize({ width: 1400, height: 900 }));
    assert.deepEqual(narrow.threads, wide.threads);
  } finally {
    await provider.close();
  }
});

test('批注采集随文档一同入库并可凭收据复核', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'annotations-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.ok(result.annotations.receipt);
    assert.equal(result.annotations.threads.length, 2);

    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.equal(receipts.length, 2);
    const receipt = receipts.find(entry => entry.id === result.annotations.receipt);
    assert.equal(receipt.source.kind, 'annotation-collection');
    assert.equal(receipt.source.document, result.receipt);
    assert.equal(receipt.source.version, 'manual-1');

    const stored = JSON.parse(await archive.read(receipt));
    assert.equal(stored.kind, 'annotation-collection');
    assert.equal(stored.version, result.document.version);
    for (const thread of stored.threads) {
      if (thread.anchor.state === 'located') assert.equal(thread.anchor.text, thread.quote);
    }
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
