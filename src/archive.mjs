import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Archive {
  constructor(root) { this.root = root; }

  async save(bytes, source) {
    const digest = sha256(bytes);
    const objects = join(this.root, 'objects');
    const receipts = join(this.root, 'receipts');
    await mkdir(objects, { recursive: true });
    await mkdir(receipts, { recursive: true });
    const temporary = join(objects, '.' + randomUUID());
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, join(objects, digest));
    await syncDirectory(objects);
    const receipt = { id: randomUUID(), digest, size: bytes.length, source };
    const receiptPath = join(receipts, receipt.id + '.json');
    const staging = receiptPath + '.pending';
    const record = await open(staging, 'wx', 0o600);
    try {
      await record.writeFile(JSON.stringify(receipt));
      await record.sync();
    } finally { await record.close(); }
    await rename(staging, receiptPath);
    await syncDirectory(receipts);
    return receipt;
  }

  async read(receipt) {
    if (!/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('内容标识无效');
    const bytes = await readFile(join(this.root, 'objects', receipt.digest));
    if (sha256(bytes) !== receipt.digest || bytes.length !== receipt.size) throw new Error('已存内容校验不符');
    return bytes;
  }

  async list() {
    let names;
    try { names = await readdir(join(this.root, 'receipts')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).sort().map(async name =>
      JSON.parse(await readFile(join(this.root, 'receipts', name), 'utf8'))));
  }

  // 保存一次批注采集：来源原始响应作为独立内容对象收存，采集结果只引用其
  // 凭据，保证批注与正文关系可逐条复核且与原始字节绑定。
  async saveCollection(payload, sources) {
    const sourceRefs = [];
    for (const source of sources) {
      const receipt = await this.save(source.bytes, {
        url: source.url,
        status: source.status,
        type: source.contentType,
        role: source.role,
        capturedBy: 'browser-annotation-collector'
      });
      sourceRefs.push({ role: source.role, url: source.url, receiptId: receipt.id, digest: receipt.digest });
    }
    const collections = join(this.root, 'collections');
    await mkdir(collections, { recursive: true });
    const record = {
      id: randomUUID(),
      schemaVersion: payload.schemaVersion,
      document: payload.document,
      content: payload.content,
      threads: payload.threads,
      portal: payload.portal,
      collectedAt: payload.collectedAt,
      sources: sourceRefs
    };
    const collectionPath = join(collections, record.id + '.json');
    const staging = collectionPath + '.pending';
    const handle = await open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(staging, collectionPath);
    await syncDirectory(collections);
    return record;
  }

  async listCollections() {
    let names;
    try { names = await readdir(join(this.root, 'collections')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).sort().map(async name =>
      JSON.parse(await readFile(join(this.root, 'collections', name), 'utf8'))));
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
