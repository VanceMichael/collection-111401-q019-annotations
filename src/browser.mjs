import { createRequire } from 'node:module';

export async function openBrowser() {
  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require('playwright'); }
  catch { playwright = require('/opt/ccusr/browser-runtime/node_modules/playwright'); }
  return playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
}
