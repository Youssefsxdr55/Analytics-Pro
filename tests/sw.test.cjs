'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../www/sw.js'), 'utf8');
const scope = 'https://example.test/app/';
const keyOf = (input) => new URL(typeof input === 'string' ? input : input.url, scope).href;

function harness(options = {}) {
  const handlers = {};
  const stores = new Map();
  const deleted = [];
  const added = [];
  let claimed = false;
  let skipped = false;
  let opened;
  const storeFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const caches = {
    async open(name) {
      opened = name;
      const store = storeFor(name);
      return {
        async add(url) {
          added.push(url);
          if (options.failAdd) throw new Error('Unavailable asset');
          store.set(keyOf(url), new Response('asset'));
        },
        async match(request) { return store.get(keyOf(request))?.clone(); },
        async put(request, response) {
          if (options.beforePut) await options.beforePut();
          if (options.failPut) throw new Error('Storage full');
          store.set(keyOf(request), response.clone());
        }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
    async match(request) {
      for (const store of stores.values()) {
        const response = store.get(keyOf(request));
        if (response) return response.clone();
      }
    }
  };
  const self = {
    registration: { scope },
    location: { href: `${scope}sw.js`, origin: new URL(scope).origin },
    addEventListener(name, handler) { handlers[name] = handler; },
    async skipWaiting() { skipped = true; },
    clients: { async claim() { claimed = true; } }
  };
  vm.runInNewContext(source, {
    self, caches, URL, Response, Request,
    fetch: options.fetch || (async () => new Response('network'))
  }, { filename: 'sw.js' });
  const dispatch = (name, extra = {}) => {
    const pending = [];
    let response;
    handlers[name]({
      ...extra,
      waitUntil(promise) { pending.push(Promise.resolve(promise)); },
      respondWith(promise) { response = Promise.resolve(promise); }
    });
    return { response, pending, async done() { await Promise.all(pending); } };
  };
  return {
    stores, deleted, added,
    get opened() { return opened; },
    get claimed() { return claimed; },
    get skipped() { return skipped; },
    async install() { await dispatch('install').done(); },
    activate() { return dispatch('activate'); },
    seed(name, url, text) { storeFor(name).set(keyOf(url), new Response(text)); },
    fetch(url = 'index.html', mode = 'navigate', method = 'GET') {
      return dispatch('fetch', { request: { url: keyOf(url), mode, method } });
    }
  };
}

// Characterization: preserve the existing public service-worker behavior.
test('installation tolerates unavailable CDN assets', async () => {
  const h = harness({ failAdd: true });
  await h.install();
  assert.ok(h.added.includes('./index.html'));
  assert.ok(h.added.some((url) => url.includes('chart.js')));
  assert.equal(h.skipped, true);
});

test('non-GET requests remain untouched', () => {
  const event = harness().fetch('index.html', 'navigate', 'POST');
  assert.equal(event.response, undefined);
});

test('cached assets are served while a successful request refreshes them', async () => {
  const h = harness();
  await h.install();
  h.seed(h.opened, 'icon-192.png', 'cached icon');
  const event = h.fetch('icon-192.png', 'cors');
  assert.equal(await (await event.response).text(), 'cached icon');
  await event.done();
  assert.equal(await h.stores.get(h.opened).get(keyOf('icon-192.png')).clone().text(), 'network');
});

// Regression: isolate application caches and enforce safe offline fallbacks.
test('activation deletes only old Analytics Pro version caches', async () => {
  const h = harness();
  await h.install();
  const current = h.opened;
  h.seed('analytics-pro-v1', 'index.html', 'old');
  h.seed('another-app-v1', 'index.html', 'unrelated');
  h.seed('analytics-pro-user-backups', 'backup.json', 'backup');
  await h.activate().done();
  assert.deepEqual(h.deleted, ['analytics-pro-v1']);
  assert.ok(h.stores.has(current));
  assert.ok(h.stores.has('another-app-v1'));
  assert.ok(h.stores.has('analytics-pro-user-backups'));
  assert.equal(h.claimed, true);
});

test('navigation can use the app shell offline', async () => {
  const h = harness({ fetch: async () => { throw new Error('Offline'); } });
  await h.install();
  h.seed(h.opened, 'index.html', 'app shell');
  const event = h.fetch('reports');
  assert.equal(await (await event.response).text(), 'app shell');
  await event.done();
});

test('an uncached script never receives HTML as an offline fallback', async () => {
  const h = harness({ failAdd: true, fetch: async () => { throw new Error('Offline'); } });
  await h.install();
  h.seed(h.opened, 'index.html', 'app shell');
  const event = h.fetch('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'cors');
  assert.equal((await event.response).type, 'error');
  await event.done();
});

test('unrelated caches cannot supply application content', async () => {
  const h = harness({ failAdd: true, fetch: async () => { throw new Error('Offline'); } });
  h.seed('another-app-v1', 'icon-192.png', 'wrong icon');
  await h.install();
  const event = h.fetch('icon-192.png', 'cors');
  assert.equal((await event.response).type, 'error');
  await event.done();
});

test('cache write failures do not discard valid network responses', async () => {
  const h = harness({ failAdd: true, failPut: true });
  await h.install();
  const event = h.fetch();
  assert.equal(await (await event.response).text(), 'network');
  await event.done();
});

test('fetch lifetime includes background cache writes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ beforePut: () => gate });
  await h.install();
  const event = h.fetch('icon-192.png', 'cors');
  assert.equal(await (await event.response).text(), 'asset');
  assert.ok(event.pending.length > 0);
  let finished = false;
  const completion = event.done().then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await completion;
  assert.equal(finished, true);
});

test('unknown external resources and out-of-scope navigation remain untouched', () => {
  const h = harness();
  assert.equal(h.fetch('https://other.test/private', 'cors').response, undefined);
  assert.equal(h.fetch('https://example.test/another-app/', 'navigate').response, undefined);
  assert.equal(h.fetch('api/private-data', 'cors').response, undefined);
});

test('network error without any cached shell returns a valid error response', async () => {
  const h = harness({ failAdd: true, fetch: async () => { throw new Error('Offline'); } });
  await h.install();
  const event = h.fetch();
  assert.equal((await event.response).type, 'error');
  await event.done();
});

test('HTTP errors are not cached', async () => {
  const h = harness({ failAdd: true, fetch: async () => new Response('unavailable', { status: 503 }) });
  await h.install();
  const event = h.fetch();
  assert.equal((await event.response).status, 503);
  await event.done();
  assert.equal(h.stores.get(h.opened).has(keyOf('index.html')), false);
});
