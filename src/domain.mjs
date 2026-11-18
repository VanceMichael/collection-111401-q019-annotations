import { capture } from './client.mjs';
import { openBrowser } from './browser.mjs';
import { Archive } from './archive.mjs';
import { collectAnnotations } from './annotations.mjs';

export async function receiveCurrent(base, directory) {
  const document = await capture(base + '/document', directory);
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(base + '/portal');
    const collection = await collectAnnotations(page);
    const archive = new Archive(directory);
    const annotationReceipt = await archive.save(Buffer.from(JSON.stringify(collection, null, 2)), {
      url: base + '/portal',
      kind: 'annotation-collection',
      document: document.receipt.id,
      version: collection.version
    });
    return {
      receipt: document.receipt.id,
      document: JSON.parse(document.bytes),
      loadedParagraphs: await page.locator('article p').count(),
      loadedThreads: await page.locator('[data-thread]').count(),
      annotations: { receipt: annotationReceipt.id, ...collection }
    };
  } finally {
    await browser.close();
  }
}
