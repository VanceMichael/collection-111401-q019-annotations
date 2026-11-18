const MAX_PAGES = 50;

// 阅览页面会按窗口宽度重排，相同文字也可能同时出现在目录、正文和引用中，
// 因此锚点只记录文档版本、章节/段落身份与文本偏移，不记录任何屏幕坐标。
// 定位一律通过页面自身的“定位原文”操作完成：没有真实选区时不伪造文本偏移。
export async function collectAnnotations(page) {
  await waitForFirstItem(page, 'article p', '#more');
  await waitForFirstItem(page, '[data-thread]', '#threads');
  // 先取齐全部正文分页与批注分页，再逐条定位，
  // 避免把“下一段尚未加载”误判成“原文已不匹配”，也避免漏掉后续页的批注。
  await loadAllPages(page, '#more', 'article p');
  await loadAllPages(page, '#threads', '[data-thread]');

  const version = await documentVersion(page);
  const meta = await threadMetadata(page);
  if (meta.version !== version) {
    throw new Error(`批注数据版本 ${meta.version} 与正文版本 ${version} 不一致`);
  }

  // 页面中用户可见的批注行必须与来源分页数据一一对应，
  // 否则无法确认采集集合完整，直接失败而不是给出残缺结果。
  const rows = await page.locator('[data-thread]').all();
  const byId = new Map();
  for (const row of rows) {
    const id = await row.getAttribute('data-thread');
    if (byId.has(id)) throw new Error(`页面中批注 ${id} 重复出现`);
    byId.set(id, row);
  }
  if (byId.size !== meta.threads.length || meta.threads.some(thread => !byId.has(thread.id))) {
    throw new Error('页面批注与来源批注不一致，无法确认采集完整');
  }

  const threads = [];
  for (const thread of meta.threads) {
    const row = byId.get(thread.id);
    const state = await row.getAttribute('data-state');
    if (state !== thread.status) {
      throw new Error(`批注 ${thread.id} 页面状态 ${state} 与来源状态 ${thread.status} 不一致`);
    }
    if ((await row.getAttribute('data-version')) !== version) {
      throw new Error(`批注 ${thread.id} 来自其他文档版本，不能混入本次采集`);
    }
    const anchor = await locateThread(page, row, thread);
    threads.push({
      id: thread.id,
      author: thread.author,
      comment: thread.comment,
      status: thread.status,
      quote: thread.quote,
      section: thread.section,
      version,
      anchor
    });
  }

  if ((await documentVersion(page)) !== version) {
    throw new Error('采集期间文档版本发生变化，本次结果已放弃');
  }

  // complete 表示正文与批注分页都已取到末页：线程缺失只能以来源报告的
  // deleted 状态为准，绝不能由“尚未加载”推断。
  return {
    kind: 'annotation-collection',
    version,
    complete: { segments: true, threads: true },
    threads
  };
}

async function documentVersion(page) {
  return page.evaluate(() => document.querySelector('#document').dataset.version);
}

async function waitForFirstItem(page, item, button) {
  await page.waitForFunction(
    ({ item, button }) =>
      document.querySelectorAll(item).length > 0 || document.querySelector(button).disabled,
    { item, button },
    { timeout: 5000 }
  );
}

async function loadAllPages(page, button, item) {
  for (let loaded = 0; loaded < MAX_PAGES; loaded++) {
    if (!(await page.locator(button).isEnabled())) return;
    const before = await page.locator(item).count();
    await page.locator(button).click();
    await page.waitForFunction(
      ({ item, before }) => document.querySelectorAll(item).length > before,
      { item, before },
      { timeout: 5000 }
    );
  }
  throw new Error('来源分页超过采集上限');
}

// 线程的作者、状态与引用原文以来源分页数据为准；页面行只保留展示文本，
// 从展示文本反推字段不可靠，因此直接读取页面自己使用的同一份接口数据。
async function threadMetadata(page) {
  return page.evaluate(async (maxPages) => {
    const threads = [];
    let pageNumber = 0;
    for (let fetched = 0; fetched < maxPages; fetched++) {
      const data = await (await fetch('/threads?page=' + pageNumber)).json();
      threads.push(...data.threads);
      if (data.next === null) return { threads, version: data.version };
      pageNumber = data.next;
    }
    throw new Error('批注分页超过采集上限');
  }, MAX_PAGES);
}

// 每次定位都重新点击定位按钮并立即把选区提取为普通数据，随后清空选区；
// 旧选区不会被带到翻页、段落展开或版本切换后的内容上。
async function locateThread(page, row, thread) {
  await row.locator('button').click();
  const outcome = (await page.locator('#location').textContent()).trim();
  const selection = await page.evaluate(() => {
    const current = getSelection();
    if (!current.rangeCount) return null;
    const range = current.getRangeAt(0);
    const container = range.startContainer;
    const element = container.nodeType === 1 ? container : container.parentElement;
    const paragraph = element?.closest('p[data-paragraph]');
    if (!paragraph) return null;
    return {
      paragraph: paragraph.dataset.paragraph,
      section: paragraph.dataset.section,
      start: range.startOffset,
      end: range.endOffset,
      text: current.toString()
    };
  });
  await page.evaluate(() => getSelection().removeAllRanges());
  const candidates = await page.evaluate(({ section, quote }) =>
    [...document.querySelectorAll('article p')]
      .filter(paragraph => paragraph.dataset.section === section && paragraph.textContent.includes(quote))
      .map(paragraph => ({ paragraph: paragraph.dataset.paragraph, section: paragraph.dataset.section })),
    { section: thread.section, quote: thread.quote });

  if (outcome === '已定位') {
    if (!selection) throw new Error(`批注 ${thread.id} 报告已定位但页面没有真实选区`);
    if (selection.text !== thread.quote) throw new Error(`批注 ${thread.id} 的选区文本与来源引用不符`);
    if (candidates.length !== 1 || candidates[0].paragraph !== selection.paragraph) {
      throw new Error(`批注 ${thread.id} 的选区与候选段落不一致`);
    }
    return { state: 'located', ...selection };
  }
  if (outcome === '有多个候选') {
    if (candidates.length < 2) throw new Error(`批注 ${thread.id} 报告存在多个候选但页面复核不符`);
    return { state: 'ambiguous', candidates };
  }
  if (outcome === '原文尚未找到') {
    if (candidates.length !== 0) throw new Error(`批注 ${thread.id} 报告原文缺失但页面复核不符`);
    return { state: 'missing' };
  }
  throw new Error(`批注 ${thread.id} 的定位结果无法识别：${outcome}`);
}
