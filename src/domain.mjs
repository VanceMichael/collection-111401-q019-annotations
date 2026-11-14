import {capture} from './client.mjs';
import {openBrowser} from './browser.mjs';
export async function receiveCurrent(base,directory){const document=await capture(base+'/document',directory);const browser=await openBrowser();try{const page=await browser.newPage();await page.goto(base+'/portal');await page.locator('article p').first().waitFor();return {receipt:document.receipt.id,document:JSON.parse(document.bytes),loadedParagraphs:await page.locator('article p').count(),loadedThreads:await page.locator('[data-thread]').count()};}finally{await browser.close();}}
