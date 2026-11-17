import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { openBrowser } from '../src/browser.mjs';
import { AnnotationCollector } from '../src/annotations.mjs';
import { Archive } from '../src/archive.mjs';
import { collectVersionSwitch } from '../src/domain.mjs';

let browser;
before(async () => { browser = await openBrowser(); });
after(async () => { await browser.close(); });

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change)
  });
  assert.equal(response.status, 200);
}

function byId(collection, id) {
  const found = collection.threads.find(thread => thread.threadId === id);
  assert.ok(found, `缺少线程 ${id}`);
  return found;
}

function noPixelCoordinates(value) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /"(x|y|clientX|clientY|left|top|width|height)"/);
}

async function freshDirectory() {
  return mkdtemp(join(tmpdir(), 'annotations-'));
}

test('收齐分页并记录作者、线程状态与可复核文本锚点', async () => {
  const provider = await createProvider();
  const directory = await freshDirectory();
  try {
    const page = await browser.newPage();
    const collector = new AnnotationCollector(page);
    await collector.open(provider.base + '/portal');
    const collection = await collector.collect();
    const archive = new Archive(directory);
    const stored = await archive.saveCollection(collection, [
      ...(collector.captured.document ? [{ ...collector.captured.document, role: 'document' }] : []),
      ...collector.captured.segments.map(entry => ({ ...entry, role: 'segments' })),
      ...collector.captured.threads.map(entry => ({ ...entry, role: 'threads' }))
    ]);

    assert.equal(collection.document.id, 'device-manual');
    assert.equal(collection.document.version, 'manual-1');
    assert.equal(collection.content.version, 'manual-1');
    assert.equal(collection.content.versionConsistent, true);
    assert.equal(collection.content.threadPages, 2);
    assert.equal(collection.content.segmentPages, 2);
    assert.equal(collection.content.moreThreadsAvailable, false);
    assert.equal(collection.threads.length, 2);

    const first = byId(collection, 'n-1');
    assert.equal(first.author, '资料审核员');
    assert.equal(first.comment, '请确认额定值');
    assert.equal(first.status, 'open');
    assert.equal(first.statusVerified, true);
    assert.equal(first.anchor.state, 'located');
    assert.equal(first.anchor.paragraph.id, 'main');
    assert.equal(first.anchor.paragraph.section, 'power');
    assert.deepEqual(first.anchor.textOffset, { start: 5, end: 12 });
    assert.equal(first.anchor.selectionText, '设备功率为十瓦');
    assert.equal(first.anchor.verified, true);
    assert.equal(first.anchor.pageLocation, '已定位');
    assert.equal(first.anchor.pageLocationConsistent, true);
    assert.equal(first.source.threadVersion, 'manual-1');
    assert.equal(first.source.documentVersionAtAnchor, 'manual-1');

    const second = byId(collection, 'n-2');
    assert.equal(second.author, '复核员');
    assert.equal(second.status, 'resolved');
    assert.equal(second.anchor.state, 'located');
    assert.equal(second.anchor.paragraph.id, 'later');
    assert.equal(second.anchor.selectionText, '保修范围');
    assert.equal(second.anchor.verified, true);

    noPixelCoordinates(collection);

    // 采集结果与来源原始响应共同入库，原始字节可凭凭据重新读出。
    const listed = await new Archive(directory).listCollections();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, stored.id);
    const receipts = await archive.list();
    assert.ok(receipts.length >= 4);
    for (const receipt of receipts) assert.ok((await archive.read(receipt)).length > 0);
    const roles = new Set(stored.sources.map(source => source.role));
    assert.deepEqual([...roles].sort(), ['document', 'segments', 'threads']);

    // 采集结束后页面不得残留选区，避免下一遍采集沿用旧选区。
    assert.equal(await page.evaluate(() => getSelection().toString()), '');
    await page.close();
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('同一章节存在多个候选时记录歧义而不是任选第一处', async () => {
  const provider = await createProvider();
  try {
    await controlled(provider, { mode: 'ambiguous' });
    const page = await browser.newPage();
    const collector = new AnnotationCollector(page);
    await collector.open(provider.base + '/portal');
    const collection = await collector.collect();
    const first = byId(collection, 'n-1');
    assert.equal(first.anchor.state, 'ambiguous');
    assert.equal(first.anchor.candidates.length, 2);
    assert.deepEqual(first.anchor.candidates.map(candidate => candidate.paragraph).sort(), ['duplicate', 'main']);
    assert.equal(first.anchor.textOffset, undefined);
    assert.equal(first.anchor.pageLocation, '有多个候选');
    assert.equal(first.anchor.pageLocationConsistent, true);
    // 目录段章节不同，不算候选。
    assert.ok(first.anchor.candidates.every(candidate => candidate.section === 'power'));
    // 其他线程的定位不受歧义影响。
    assert.equal(byId(collection, 'n-2').anchor.state, 'located');
    noPixelCoordinates(collection);
    await page.close();
  } finally { await provider.close(); }
});

test('尚未加载的分页线程不等于已删除，加载后按来源状态区分', async () => {
  const provider = await createProvider();
  try {
    const page = await browser.newPage();
    const collector = new AnnotationCollector(page);
    await collector.open(provider.base + '/portal');
    const early = await collector.snapshot();
    assert.equal(early.loadedThreads.length, 1);
    assert.equal(early.loadedThreads[0].threadId, 'n-1');
    assert.equal(early.moreThreadsAvailable, true);
    // n-2 尚未加载：快照中既不出现，也不能被当作 deleted。
    assert.ok(!early.loadedThreads.some(thread => thread.threadId === 'n-2'));

    const collection = await collector.collect();
    assert.equal(collection.content.moreThreadsAvailable, false);
    const second = byId(collection, 'n-2');
    assert.equal(second.status, 'resolved');
    assert.notEqual(second.status, 'deleted');
    await page.close();
  } finally { await provider.close(); }
});

test('切换版本后重建锚点：旧引用不匹配与已删除状态分别记录', async () => {
  const provider = await createProvider();
  const directory = await freshDirectory();
  try {
    const result = await collectVersionSwitch(provider.base, directory);
    const before = result.before.annotations;
    const after = result.after.annotations;

    assert.equal(before.document.version, 'manual-1');
    assert.equal(after.document.version, 'manual-2');
    assert.equal(after.content.versionConsistent, true);
    assert.notEqual(result.before.collectionId, result.after.collectionId);

    const oldFirst = byId(before, 'n-1');
    assert.equal(oldFirst.anchor.state, 'located');
    assert.equal(oldFirst.anchor.verified, true);

    const newFirst = byId(after, 'n-1');
    assert.equal(newFirst.status, 'open');
    assert.equal(newFirst.anchor.state, 'no-match');
    assert.equal(newFirst.anchor.textOffset, undefined);
    assert.equal(newFirst.anchor.candidates.length, 0);
    assert.equal(newFirst.anchor.pageLocation, '原文尚未找到');
    assert.equal(newFirst.anchor.pageLocationConsistent, true);
    assert.equal(newFirst.source.documentVersionAtAnchor, 'manual-2');

    const newSecond = byId(after, 'n-2');
    assert.equal(newSecond.status, 'deleted');
    // 删除是线程状态；锚点关系独立于状态按新正文判定：引用文本仍在则仍可定位，
    // 但线程本身已删除，不能与“暂时未加载”混为一谈。
    assert.equal(newSecond.anchor.state, 'located');
    assert.equal(newSecond.anchor.paragraph.id, 'later');

    // 两份采集分别入库，旧版本记录未被新版本覆盖或套用。
    const stored = await new Archive(directory).listCollections();
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map(item => item.document.version).sort(), ['manual-1', 'manual-2']);
    noPixelCoordinates(after);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('窄屏重排不改变文本锚点，且选区在重采集时重新建立', async () => {
  const provider = await createProvider();
  try {
    const page = await browser.newPage();
    const collector = new AnnotationCollector(page);
    await collector.open(provider.base + '/portal');
    const wide = await collector.collect();
    const wideOffset = byId(wide, 'n-1').anchor.textOffset;
    await page.setViewportSize({ width: 400, height: 700 });
    const narrow = await collector.collect();
    const relocated = byId(narrow, 'n-1');
    assert.equal(relocated.anchor.state, 'located');
    assert.deepEqual(relocated.anchor.textOffset, wideOffset);
    assert.equal(relocated.anchor.selectionText, '设备功率为十瓦');
    assert.equal(relocated.anchor.verified, true);
    assert.equal(relocated.anchor.paragraph.id, 'main');
    assert.equal(await page.evaluate(() => getSelection().toString()), '');
    await page.close();
  } finally { await provider.close(); }
});

test('段落折叠后再展开，锚点按重新出现的正文重建而不套用旧选区', async () => {
  const provider = await createProvider();
  try {
    const page = await browser.newPage();
    const collector = new AnnotationCollector(page);
    await collector.open(provider.base + '/portal');
    const first = await collector.collect();
    assert.equal(byId(first, 'n-1').anchor.state, 'located');

    // 模拟折叠：从正文移除承载原文的段落，旧选区随之失效。
    await page.evaluate(() => {
      const paragraph = document.querySelector('article p[data-paragraph="main"]');
      paragraph.dataset.hiddenBy = 'collapsed';
      paragraph.remove();
    });
    const folded = await collector.collect();
    const foldedAnchor = byId(folded, 'n-1').anchor;
    assert.equal(foldedAnchor.state, 'no-match');
    assert.equal(foldedAnchor.candidates.length, 0);
    assert.equal(foldedAnchor.pageLocation, '原文尚未找到');
    // 折叠期间页面上不得残留上一遍采集的选区。
    assert.equal(await page.evaluate(() => getSelection().toString()), '');

    // 模拟展开：段落重新插入当前正文，重新定位后重新建立真实选区与偏移。
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.dataset.section = 'power';
      paragraph.dataset.paragraph = 'main';
      paragraph.textContent = '正式参数：设备功率为十瓦。适用标准工况。';
      document.querySelector('#document').append(paragraph);
    });
    const expanded = await collector.collect();
    const expandedAnchor = byId(expanded, 'n-1').anchor;
    assert.equal(expandedAnchor.state, 'located');
    assert.equal(expandedAnchor.paragraph.id, 'main');
    assert.equal(expandedAnchor.verified, true);
    assert.equal(expandedAnchor.selectionText, '设备功率为十瓦');
    assert.deepEqual(expandedAnchor.textOffset, { start: 5, end: 12 });
    await page.close();
  } finally { await provider.close(); }
});
