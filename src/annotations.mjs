// 浏览器批注采集：驱动真实合作阅览器页面，记录批注作者、线程状态以及
// 能够回指原文的文本锚点。锚点只基于文档版本、章节/段落身份与文本范围，
// 不使用屏幕坐标；每次定位都重新读取当前 DOM，不缓存旧选区。

const MAX_PAGES = 50;
const LOCATION_LABEL = { located: '已定位', ambiguous: '有多个候选', 'no-match': '原文尚未找到' };

// 在浏览器页面内执行：按页面自身的同一规则（章节一致且段落包含引用文本）
// 枚举候选段落，并读取真实 Selection 与页面给出的定位结论。
function evaluateThreadAnchor({ threadId, quote, section }) {
  const article = document.querySelector('#document');
  const candidates = [...article.querySelectorAll('p')]
    .filter(paragraph => paragraph.dataset.section === section && paragraph.textContent.includes(quote))
    .map(paragraph => ({
      section: paragraph.dataset.section,
      paragraph: paragraph.dataset.paragraph,
      text: paragraph.textContent
    }));
  const selection = getSelection();
  const selectionText = selection && selection.rangeCount ? selection.toString() : '';
  let selectionAnchor = null;
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const paragraphElement = element && element.closest ? element.closest('article p') : null;
    if (paragraphElement) {
      selectionAnchor = {
        section: paragraphElement.dataset.section,
        paragraph: paragraphElement.dataset.paragraph,
        start: range.startOffset,
        end: range.endOffset
      };
    }
  }
  const row = document.querySelector(`[data-thread="${CSS.escape(threadId)}"]`);
  return {
    documentVersion: article.dataset.version,
    rowState: row ? row.dataset.state : null,
    pageLocation: document.querySelector('#location').textContent,
    candidates,
    selectionText,
    selectionAnchor
  };
}

function clearSelection(page) {
  return page.evaluate(() => {
    const selection = getSelection();
    if (selection) selection.removeAllRanges();
  });
}

export class AnnotationCollector {
  constructor(page) {
    this.page = page;
    this.captured = { document: null, segments: [], threads: [] };
    this.#attachListener();
  }

  #attachListener() {
    this.page.on('response', response => {
      let pathname;
      try { pathname = new URL(response.url()).pathname; }
      catch { return; }
      // /document 由页面上下文主动取回（见 fetchDocument），不在事件通道重复读取；
      // 当前运行环境中对该响应调用 text()/body() 会挂起。
      if (pathname !== '/segments' && pathname !== '/threads') return;
      const target = { kind: pathname.slice(1), url: response.url(), status: response.status(), contentType: response.headers()['content-type'] ?? null };
      target.ready = response.text()
        .then(text => { target.bytes = Buffer.from(text, 'utf8'); })
        .catch(error => { target.error = error; });
      this.captured[target.kind].push(target);
    });
  }

  // 文档身份在页面同源上下文中取回，保留来源 URL、状态与内容类型用于凭据。
  async fetchDocument() {
    const result = await this.page.evaluate(async () => {
      const response = await fetch('/document');
      return {
        url: response.url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: await response.text()
      };
    });
    this.captured.document = {
      kind: 'document',
      url: result.url,
      status: result.status,
      contentType: result.contentType,
      bytes: Buffer.from(result.text, 'utf8'),
      ready: Promise.resolve()
    };
  }

  async #settle() {
    const pending = [
      this.captured.document,
      ...this.captured.segments,
      ...this.captured.threads
    ].filter(Boolean).map(entry => entry.ready);
    await Promise.all(pending);
    const failed = [
      this.captured.document,
      ...this.captured.segments,
      ...this.captured.threads
    ].find(entry => entry && entry.error);
    if (failed) throw new Error(`来源响应读取失败：${failed.error.message}`);
  }

  #resetCaptured() {
    this.captured = { document: null, segments: [], threads: [] };
  }

  async open(portalUrl) {
    this.#resetCaptured();
    await this.page.goto(portalUrl);
    await this.page.locator('article p').first().waitFor();
    await this.page.locator('[data-thread]').first().waitFor();
    // 门户自身只拉取正文与批注分页；文档身份由浏览器同源补取一次并作为来源凭据入库。
    await this.fetchDocument();
  }

  async currentVersion() {
    return this.page.locator('#document').getAttribute('data-version');
  }

  // 只反映当前浏览器里已经加载的内容：未按下一页时，后续线程既不是已删除，
  // 也不会出现在结果里，而是通过 moreThreadsAvailable 表明尚未加载。
  async snapshot() {
    const [version, rows, moreThreadsAvailable, paragraphsLoaded] = await Promise.all([
      this.currentVersion(),
      this.page.$$eval('[data-thread]', elements => elements.map(element => ({
        threadId: element.dataset.thread,
        status: element.dataset.state,
        version: element.dataset.version
      }))),
      this.page.locator('#threads').isDisabled().then(disabled => !disabled),
      this.page.locator('article p').count()
    ]);
    return { version, paragraphsLoaded, loadedThreads: rows, moreThreadsAvailable };
  }

  async #loadAll(buttonSelector, responsePath) {
    let loaded = 0;
    for (let guard = 0; guard < MAX_PAGES; guard += 1) {
      if (await this.page.locator(buttonSelector).isDisabled()) return loaded;
      await Promise.all([
        this.page.waitForResponse(response => {
          const candidate = new URL(response.url());
          return candidate.pathname === responsePath;
        }, { timeout: 5000 }),
        this.page.locator(buttonSelector).click()
      ]);
      loaded += 1;
    }
    throw new Error('分页加载超过上限，来源可能未正确终止分页');
  }

  async loadAllParagraphs() {
    return this.#loadAll('#more', '/segments');
  }

  async loadAllThreads() {
    return this.#loadAll('#threads', '/threads');
  }

  // 切换版本：先交出并清空上一版采集痕迹，等待新版本正文与批注 DOM 就绪。
  // 上一版结果由调用方先行收存；本对象不会把任何旧选区或旧锚点带到新内容。
  async switchVersion() {
    const previous = await this.currentVersion();
    this.#resetCaptured();
    await clearSelection(this.page);
    await Promise.all([
      this.page.waitForResponse(response => {
        const candidate = new URL(response.url());
        return candidate.pathname === '/segments' && candidate.searchParams.get('page') === '0';
      }, { timeout: 5000 }),
      this.page.locator('#version').click()
    ]);
    await this.page.waitForFunction(version =>
      document.querySelector('#document').dataset.version !== version, previous, { timeout: 5000 });
    await this.page.locator('[data-thread]').first().waitFor();
    await this.page.waitForFunction(() => getSelection().toString() === '');
    await this.fetchDocument();
  }

  #payloadPages(kind) {
    return this.captured[kind].map((entry, index) => {
      const json = JSON.parse(entry.bytes.toString('utf8'));
      return { index, url: entry.url, version: json.version, next: json.next, json };
    });
  }

  async collect() {
    const startVersion = await this.currentVersion();
    await this.loadAllParagraphs();
    await this.loadAllThreads();
    await this.#settle();
    const segmentPages = this.#payloadPages('segments');
    const threadPages = this.#payloadPages('threads');
    if (!this.captured.document) throw new Error('缺少文档身份响应，无法建立批注与文档的关系');
    const documentPayload = JSON.parse(this.captured.document.bytes.toString('utf8'));

    const threadById = new Map();
    for (const page of threadPages) {
      for (const thread of page.json.threads) {
        threadById.set(thread.id, {
          threadId: thread.id,
          author: thread.author,
          comment: thread.comment,
          status: thread.status,
          quote: thread.quote,
          section: thread.section,
          threadPage: page.index,
          threadVersion: page.version
        });
      }
    }

    const domRows = await this.page.$$eval('[data-thread]', elements =>
      elements.map(element => ({ threadId: element.dataset.thread, status: element.dataset.state })));

    const threads = [];
    for (const row of domRows) {
      const item = threadById.get(row.threadId);
      if (!item) throw new Error(`浏览器线程 ${row.threadId} 缺少对应的来源响应，锚点无法复核`);
      await clearSelection(this.page);
      await this.page.locator(`[data-thread="${item.threadId}"] button`).click();
      const probe = await this.page.evaluate(evaluateThreadAnchor, { threadId: item.threadId, quote: item.quote, section: item.section });
      await clearSelection(this.page);

      const state = probe.candidates.length === 1 ? 'located'
        : probe.candidates.length > 1 ? 'ambiguous' : 'no-match';
      const anchor = {
        state,
        section: item.section,
        quote: item.quote,
        pageLocation: probe.pageLocation,
        pageLocationConsistent: probe.pageLocation === LOCATION_LABEL[state],
        candidates: probe.candidates
      };
      if (state === 'located') {
        const only = probe.candidates[0];
        const offset = probe.selectionAnchor
          ? { start: probe.selectionAnchor.start, end: probe.selectionAnchor.end }
          : null;
        anchor.paragraph = { id: only.paragraph, section: only.section };
        anchor.textOffset = offset;
        anchor.selectionText = probe.selectionText || null;
        anchor.verified = Boolean(offset)
          && probe.selectionAnchor.paragraph === only.paragraph
          && probe.selectionText === item.quote
          && only.text.slice(offset.start, offset.end) === item.quote;
      } else {
        anchor.selectionText = probe.selectionText || null;
      }

      threads.push({
        threadId: item.threadId,
        author: item.author,
        comment: item.comment,
        status: item.status,
        statusVerified: item.status === probe.rowState && item.status === row.status,
        anchor,
        source: {
          threadPage: item.threadPage,
          threadVersion: item.threadVersion,
          documentVersionAtAnchor: probe.documentVersion
        }
      });
    }

    const articleVersion = await this.currentVersion();
    const payloadVersions = [
      ...segmentPages.map(page => page.version),
      ...threadPages.map(page => page.version),
      documentPayload.version
    ];
    const versionConsistent = articleVersion === startVersion
      && payloadVersions.every(version => version === articleVersion);

    return {
      schemaVersion: 1,
      portal: this.page.url(),
      collectedAt: new Date().toISOString(),
      document: {
        id: documentPayload.id,
        version: documentPayload.version,
        title: documentPayload.title,
        portal: documentPayload.portal
      },
      content: {
        version: articleVersion,
        versionConsistent,
        paragraphsLoaded: await this.page.locator('article p').count(),
        segmentPages: segmentPages.length,
        threadPages: threadPages.length,
        moreThreadsAvailable: await this.page.locator('#threads').isDisabled().then(disabled => !disabled)
      },
      threads
    };
  }
}

// 单遍采集：打开门户、收齐当前版本的正文与批注分页、逐条建立锚点。
export async function collectPortalAnnotations(page, portalUrl) {
  const collector = new AnnotationCollector(page);
  await collector.open(portalUrl);
  const collection = await collector.collect();
  return { collection, captured: collector.captured };
}
