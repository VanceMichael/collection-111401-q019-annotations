import { capture } from './client.mjs';
import { openBrowser } from './browser.mjs';
import { Archive } from './archive.mjs';
import { AnnotationCollector } from './annotations.mjs';

function capturedSources(captured) {
  const sources = [];
  if (captured.document) sources.push({ ...captured.document, role: 'document' });
  for (const entry of captured.segments) sources.push({ ...entry, role: 'segments' });
  for (const entry of captured.threads) sources.push({ ...entry, role: 'threads' });
  return sources;
}

// 在已打开的页面上完成一遍当前版本采集并写入收件目录。
async function collectAndStore(page, base, archive) {
  const collector = new AnnotationCollector(page);
  await collector.open(base + '/portal');
  const collection = await collector.collect();
  const stored = await archive.saveCollection(collection, capturedSources(collector.captured));
  return { collector, collection, stored };
}

export async function receiveCurrent(base, directory) {
  const document = await capture(base + '/document', directory);
  const archive = new Archive(directory);
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    const { collection, stored } = await collectAndStore(page, base, archive);
    return {
      receipt: document.receipt.id,
      document: JSON.parse(document.bytes),
      loadedParagraphs: collection.content.paragraphsLoaded,
      loadedThreads: collection.threads.length,
      annotationCollectionId: stored.id,
      annotations: collection
    };
  } finally { await browser.close(); }
}

// 浏览器内切换资料版本：上一版采集结果先收存，再让页面清空 DOM 与选区，
// 重新建立全新采集，绝不把旧版本的选区或锚点套用到新版本正文。
export async function collectVersionSwitch(base, directory) {
  const archive = new Archive(directory);
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    const first = await collectAndStore(page, base, archive);
    await first.collector.switchVersion();
    const second = await first.collector.collect();
    const secondStored = await archive.saveCollection(second, capturedSources(first.collector.captured));
    return {
      before: { collectionId: first.stored.id, annotations: first.collection },
      after: { collectionId: secondStored.id, annotations: second }
    };
  } finally { await browser.close(); }
}
