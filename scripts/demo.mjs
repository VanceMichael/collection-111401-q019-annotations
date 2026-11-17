import { createProvider } from '../provider/server.mjs';
import { receiveCurrent, collectVersionSwitch } from '../src/domain.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
  const result = await receiveCurrent(provider.base, directory);
  const summary = {
    service: 'annotations',
    current: {
      receipt: result.receipt,
      collection: result.annotationCollectionId,
      threads: result.annotations.threads.map(thread => ({
        threadId: thread.threadId,
        author: thread.author,
        status: thread.status,
        anchor: thread.anchor.state,
        paragraph: thread.anchor.paragraph?.id ?? null
      }))
    }
  };
  const switched = await collectVersionSwitch(provider.base, directory);
  summary.versionSwitch = {
    before: switched.before.annotations.document.version,
    after: switched.after.annotations.document.version,
    threads: switched.after.annotations.threads.map(thread => ({
      threadId: thread.threadId,
      status: thread.status,
      anchor: thread.anchor.state
    }))
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await provider.close();
  await rm(directory, { recursive: true, force: true });
}
