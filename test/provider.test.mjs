import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(response.status, 200);
}

test('现有业务入口真实收存来源资料并可重新打开', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'business-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.ok(result);
    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.ok(receipts.length > 0);
    for (const receipt of receipts) assert.ok((await archive.read(receipt)).length > 0);
    assert.ok(provider.audit.some(request => !request.path.startsWith('/_')));
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('批注的后续页不是不存在', async () => {
 const provider = await createProvider();
 try {
const first=await(await fetch(provider.base+'/threads')).json();const second=await(await fetch(provider.base+'/threads?page=1')).json();assert.equal(first.next,1);assert.equal(second.threads[0].status,'resolved');
 } finally { await provider.close(); }
});

test('切版本后旧原文不再可引用', async () => {
 const provider = await createProvider();
 try {
await controlled(provider,{generation:2});const page=await(await fetch(provider.base+'/segments')).json();assert.match(page.paragraphs.find(paragraph=>paragraph.section==='power').text,/十二瓦/);const notes=await(await fetch(provider.base+'/threads?page=1')).json();assert.equal(notes.threads[0].status,'deleted');
 } finally { await provider.close(); }
});

test('定位由真实浏览器文本选区提供', async () => {
 const provider = await createProvider();
 try {
const {openBrowser}=await import('../src/browser.mjs');const browser=await openBrowser();try{const page=await browser.newPage();await page.goto(provider.base+'/portal');await page.locator('[data-thread="n-1"] button').click();assert.equal(await page.evaluate(()=>getSelection().toString()),'设备功率为十瓦');await page.setViewportSize({width:400,height:700});assert.equal(await page.evaluate(()=>getSelection().toString()),'设备功率为十瓦');}finally{await browser.close();}
 } finally { await provider.close(); }
});
