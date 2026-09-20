'use strict';

/**
 * Optional UI test. Runs the REAL frontend (public/*) in headless Chromium
 * against the REAL server logic (src/socketHandlers.js). Only the network
 * transport is replaced: the browser's `io()` is a small stub that forwards
 * events to an in-process FakeIO. Real WebSocket transport is covered by
 * test/integration.test.js.
 *
 * Needs Playwright (not a project dependency):
 *   npm i -D playwright && npx playwright install chromium
 *   node test/ui-sim.js            (screenshots go to ./test/screenshots)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const { loadConfig } = require('../src/config');
const { ModerationStore } = require('../src/moderation');
const { registerSocketHandlers } = require('../src/socketHandlers');
const { FakeIO } = require('./helpers/fakeIo');

const PUBLIC = path.join(__dirname, '..', 'public');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

// Same policy the real server sends via helmet.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Browser-side stand-in for the socket.io client.
const MOCK_CLIENT = `
window.io = function (opts) {
  const handlers = {};
  const deliver = (evt, payload) => (handlers[evt] || []).slice().forEach((fn) => fn(payload));
  const sock = {
    connected: false,
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
    emit(evt, ...args) {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      window.__toServer(evt, args[0] === undefined ? null : args[0]).then((res) => { if (ack) ack(res); });
      return sock;
    },
    timeout() { return { emit(evt, ...args) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      window.__toServer(evt, args[0] === undefined ? null : args[0]).then((res) => cb(null, res));
    } }; },
    disconnect() { sock.connected = false; window.__disconnect(); },
  };
  window.__deliver = (evt, payload) => {
    if (evt === '__connect') { sock.connected = true; deliver('connect'); return; }
    if (evt === '__disconnect') { sock.connected = false; deliver('disconnect', 'transport close'); return; }
    deliver(evt, payload);
  };
  setTimeout(() => opts.auth((auth) => window.__connect(auth)), 0);
  return sock;
};`;

function staticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/socket.io/socket.io.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Content-Security-Policy': CSP });
        return res.end(MOCK_CLIENT);
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
      return fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipCounter = 10;

async function main() {
  const config = loadConfig({
    IP_HASH_SECRET: 'ui-sim', INTEREST_MATCH_TIMEOUT_MS: '400', RECONNECT_GRACE_MS: '800', STRIKE_LIMIT: '50',
  });
  const io = new FakeIO();
  const moderation = new ModerationStore({});
  const chat = registerSocketHandlers(io, { config, moderation });
  const server = await staticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  const problems = [];

  /** A visitor = isolated browser context (own sessionStorage) wired to the fake server. */
  async function visitor(name, viewport = { width: 390, height: 844 }) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
    context.setDefaultTimeout(6000);
    const page = await context.newPage();
    const v = { name, page, context, socket: null, queue: Promise.resolve() };
    const ip = `10.1.0.${(ipCounter += 1)}`;

    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${name}] console.${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));

    const forward = (evt, payload) => {
      v.queue = v.queue.then(() => page.evaluate(([e, p]) => window.__deliver && window.__deliver(e, p), [evt, payload]).catch(() => {}));
    };
    // A real browser closes its WebSocket when the page navigates or reloads.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && v.socket) { v.socket.drop(); v.socket = null; }
    });
    await page.exposeFunction('__connect', (auth) => {
      const res = io.connect({ ip, auth: auth || {}, onEmit: forward });
      if (res.error) { forward('connect_error', { data: res.error.data }); return; }
      v.socket = res.socket;
      forward('__connect');
    });
    await page.exposeFunction('__toServer', async (evt, payload) => {
      if (!v.socket || !v.socket.connected) return null;
      const res = await v.socket.send(evt, payload);
      return res === undefined ? null : res;
    });
    await page.exposeFunction('__disconnect', () => { if (v.socket) v.socket.drop(); });
    return v;
  }

  const text = (page, sel) => page.locator(sel).innerText();
  const shot = (v, label) => v.page.screenshot({ path: path.join(SHOTS, `${label}.png`) });

  /** Go through the real landing -> topic -> Find Stranger flow. */
  async function startChatting(v, topic) {
    await v.page.goto(`${base}/`);
    await v.page.click('#start-btn');
    await v.page.waitForSelector('#interests:not([hidden])');
    assert.equal(await v.page.locator('#find-btn').isDisabled(), true, 'Find is disabled until the checkbox is ticked');
    if (topic !== 'random') await v.page.locator(`input[name=interest][value=${topic}]`).check({ force: true });
    await v.page.check('#agree');
    assert.equal(await v.page.locator('#find-btn').isDisabled(), false);
    await v.page.click('#find-btn');
    await v.page.waitForURL('**/chat.html');
  }

  let passed = 0;
  const step = async (title, fn) => {
    try { await fn(); passed += 1; console.log(`  ok  ${title}`); }
    catch (err) { console.error(`  FAIL ${title}\n       ${err.message.split('\n')[0]}`); problems.push(`FAILED: ${title}: ${err.message.split('\n')[0]}`); }
  };

  /* ---------------------------------- run --------------------------------- */
  console.log('UI simulation');

  const alice = await visitor('alice');
  const bob = await visitor('bob');

  await step('landing page renders with privacy copy and honest anonymity caveat', async () => {
    await alice.page.goto(`${base}/`);
    const body = await text(alice.page, 'body');
    assert.match(body, /Start Chatting/);
    assert.match(body, /not the same as untraceable/i);
    assert.match(body, /IP address/);
    assert.match(body, /No saved chats/);
    await shot(alice, '01-landing-mobile');
  });

  await step('interest selection lists all nine topics', async () => {
    await alice.page.click('#start-btn');
    await alice.page.waitForSelector('#interests:not([hidden])');
    const values = await alice.page.$$eval('input[name=interest]', (els) => els.map((e) => e.value));
    assert.deepEqual(values, ['random', 'music', 'gaming', 'movies', 'technology', 'school', 'business', 'relationships', 'other']);
    await shot(alice, '02-interests-mobile');
  });

  await step('Back button returns to landing (history works)', async () => {
    await alice.page.goBack();
    await alice.page.waitForSelector('#landing:not([hidden])');
  });

  await step('a lone user sees the matching screen and can cancel', async () => {
    await startChatting(alice, 'music');
    await alice.page.waitForSelector('#screen-matching:not([hidden])');
    assert.match(await text(alice.page, '#matching-sub'), /Music/);
    await shot(alice, '03-matching-mobile');
    assert.equal(chat.stats().waiting, 1);
    await alice.page.click('#cancel-btn');
    await alice.page.waitForURL(`${base}/`);
    assert.equal(chat.stats().waiting, 0);
  });

  await step('two users on the same topic are matched and see "You are now connected with Stranger-XXXXX"', async () => {
    await startChatting(alice, 'music');
    await startChatting(bob, 'music');
    await alice.page.waitForSelector('#screen-chat:not([hidden])');
    await bob.page.waitForSelector('#screen-chat:not([hidden])');
    const aName = await text(alice.page, '#stranger-name');
    const bName = await text(bob.page, '#stranger-name');
    assert.match(aName, /^Stranger-\d{5}$/);
    assert.notEqual(aName, bName);
    assert.match(await text(alice.page, '#messages'), new RegExp(`You are now connected with ${aName}`));
    assert.equal(await text(alice.page, '#status-text'), 'Connected');
  });

  await step('typing indicator appears for the stranger and clears', async () => {
    await alice.page.locator('#input').pressSequentially('hel', { delay: 20 });
    await bob.page.waitForFunction(() => /is typing/.test(document.getElementById('typing').textContent));
    await alice.page.locator('#input').fill('');
    await alice.page.locator('#input').dispatchEvent('input');
    await bob.page.waitForFunction(() => document.getElementById('typing').textContent === '');
  });

  await step('Enter sends, Shift+Enter makes a newline, timestamps are shown', async () => {
    await alice.page.locator('#input').fill('Hello from Alice');
    await alice.page.keyboard.press('Enter');
    await bob.page.waitForSelector('.msg.them');
    assert.equal(await bob.page.locator('.msg.them span').first().innerText(), 'Hello from Alice');
    assert.match(await bob.page.locator('.msg.them time').first().innerText(), /\d{1,2}:\d{2}/);
    assert.equal(await alice.page.locator('.msg.me').count(), 1);
    assert.equal(await alice.page.inputValue('#input'), '', 'input clears after send');
    await alice.page.locator('#input').fill('line1');
    await alice.page.keyboard.press('Shift+Enter');
    await alice.page.keyboard.type('line2');
    assert.equal(await alice.page.inputValue('#input'), 'line1\nline2');
    await alice.page.keyboard.press('Enter');
    await bob.page.waitForFunction(() => document.querySelectorAll('.msg.them').length === 2);
    await bob.page.locator('#input').fill('Hi Alice, this is Bob. Nice to meet you!');
    await bob.page.keyboard.press('Enter');
    await alice.page.waitForSelector('.msg.them');
    await shot(alice, '04-chat-mobile');
  });

  await step('XSS: markup from a stranger is shown as literal text and never executes', async () => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script><b>bold</b>';
    await alice.page.locator('#input').fill(evil);
    await alice.page.keyboard.press('Enter');
    await bob.page.waitForFunction(() => document.querySelectorAll('.msg.them').length === 3);
    const shown = await bob.page.locator('.msg.them span').last().innerText();
    assert.equal(shown, evil);
    assert.equal(await bob.page.locator('#messages img, #messages script, #messages b').count(), 0);
    assert.equal(await bob.page.evaluate(() => window.__xss), undefined);
    assert.equal(await alice.page.evaluate(() => window.__xss), undefined);
  });

  await step('server-side rejections (links) are shown to the sender and the text is kept', async () => {
    await alice.page.locator('#input').fill('visit https://spam.example now');
    await alice.page.keyboard.press('Enter');
    await alice.page.waitForFunction(() => /Links are turned off/.test(document.getElementById('messages').textContent));
    assert.equal(await alice.page.inputValue('#input'), 'visit https://spam.example now');
    await alice.page.locator('#input').fill('');
  });

  await step('message rate limiting is surfaced to the user', async () => {
    for (let i = 0; i < 8; i += 1) {
      await alice.page.locator('#input').fill(`burst ${i}`);
      await alice.page.keyboard.press('Enter');
    }
    await alice.page.waitForFunction(() => /too fast/.test(document.getElementById('messages').textContent));
    await alice.page.locator('#input').fill('');
  });

  await step('profanity is masked for the recipient', async () => {
    await sleep(5200); // let the rate-limit window pass
    await alice.page.locator('#input').fill('this is bullshit');
    await alice.page.keyboard.press('Enter');
    await bob.page.waitForFunction(() => /\*{8}/.test(document.getElementById('messages').textContent));
  });

  await step('report dialog sends a report and confirms it', async () => {
    await alice.page.click('#report-btn');
    await alice.page.waitForSelector('#report-dialog[open]');
    await shot(alice, '05-report-dialog-mobile');
    await alice.page.check('input[name=reason][value=harassment]');
    await alice.page.fill('#report-note', 'test report');
    await alice.page.click('#report-submit');
    await alice.page.waitForFunction(() => /Report sent/.test(document.getElementById('messages').textContent));
    const reports = moderation.list();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, 'harassment');
    await alice.page.click('#report-btn');
    await alice.page.check('input[name=reason][value=spam]');
    await alice.page.click('#report-submit');
    await alice.page.waitForFunction(() => /already reported/.test(document.getElementById('report-error').textContent));
    await alice.page.click('#report-cancel');
  });

  await step('refreshing mid-chat resumes the same conversation with its history', async () => {
    const before = await text(alice.page, '#stranger-name');
    const count = await alice.page.locator('.msg').count();
    await alice.page.reload();
    await alice.page.waitForSelector('#screen-chat:not([hidden])');
    assert.equal(await text(alice.page, '#stranger-name'), before);
    await alice.page.waitForFunction((n) => document.querySelectorAll('.msg').length >= n, count - 1);
    assert.match(await text(alice.page, '#messages'), /Reconnected/);
    assert.match(await text(alice.page, '#messages'), /Hello from Alice/);
  });

  await step('stranger dropping shows status; ending happens after the grace period', async () => {
    bob.socket.drop();
    await bob.page.evaluate(() => window.__deliver('__disconnect'));
    await alice.page.waitForFunction(() => /reconnecting/.test(document.getElementById('status-text').textContent));
    await shot(alice, '06-stranger-offline-mobile');
    await bob.page.reload(); // comes back within the grace period
    await alice.page.waitForFunction(() => document.getElementById('status-text').textContent === 'Connected');
    assert.match(await text(alice.page, '#messages'), /The stranger is back/);
  });

  await step('End chat asks for confirmation, then ends for both sides and deletes the room', async () => {
    await alice.page.click('#end-btn');
    await alice.page.waitForSelector('#confirm-dialog[open]');
    await shot(alice, '07-end-confirm-mobile');
    await alice.page.click('#confirm-ok');
    await alice.page.waitForSelector('#ended-panel:not([hidden])');
    await bob.page.waitForSelector('#ended-panel:not([hidden])');
    assert.match(await text(alice.page, '#ended-title'), /Conversation ended/);
    assert.match(await text(bob.page, '#messages'), /The stranger has left the conversation/);
    assert.equal(await alice.page.locator('#composer').isHidden(), true);
    assert.equal(chat.stats().rooms, 0);
    await shot(bob, '08-ended-mobile');
  });

  await step('after the stranger leaves, the remaining user can immediately find another stranger', async () => {
    const carol = await visitor('carol');
    await startChatting(carol, 'music');
    await carol.page.waitForSelector('#screen-matching:not([hidden])');
    await bob.page.click('#find-another');
    await bob.page.waitForSelector('#screen-chat:not([hidden]) #composer:not([hidden])');
    assert.equal(await bob.page.locator('.msg').count(), 0, 'old transcript is gone');
    assert.match(await text(bob.page, '#messages'), /You are now connected with Stranger-\d{5}/);
    await carol.context.close();
  });

  await step('block ends the chat, tells the blocker, and the pair never re-match', async () => {
    // bob is now chatting with carol's session (closed => grace) - use fresh users for a clean case
    const dave = await visitor('dave');
    const erin = await visitor('erin');
    await startChatting(dave, 'gaming');
    await startChatting(erin, 'gaming');
    await dave.page.waitForSelector('#screen-chat:not([hidden])');
    await erin.page.waitForSelector('#screen-chat:not([hidden])');
    await dave.page.click('#block-btn');
    await dave.page.click('#confirm-ok');
    await dave.page.waitForSelector('#ended-panel:not([hidden])');
    assert.match(await text(dave.page, '#ended-text'), /blocked/i);
    await erin.page.waitForSelector('#ended-panel:not([hidden])');
    assert.doesNotMatch(await text(erin.page, 'body'), /blocked/i, 'the blocked user is not told');
    await dave.page.click('#find-another');
    await erin.page.click('#find-another');
    await sleep(400);
    assert.equal(await dave.page.locator('#screen-matching').isVisible(), true);
    assert.equal(await erin.page.locator('#screen-matching').isVisible(), true);
    await dave.context.close();
    await erin.context.close();
  });

  await step('no one for the topic: user is offered "match with anyone" and it works', async () => {
    const frank = await visitor('frank');
    const gina = await visitor('gina');
    await startChatting(frank, 'business');
    await startChatting(gina, 'random');
    await frank.page.waitForSelector('#no-match:not([hidden])', { timeout: 3000 });
    await shot(frank, '09-no-topic-match-mobile');
    await frank.page.click('#match-anyone');
    await frank.page.waitForSelector('#screen-chat:not([hidden])');
    await gina.page.waitForSelector('#screen-chat:not([hidden])');
    await frank.context.close();
    await gina.context.close();
  });

  await step('opening chat.html directly (no search intent) sends you home', async () => {
    const heidi = await visitor('heidi');
    await heidi.page.goto(`${base}/chat.html`);
    await heidi.page.waitForURL(`${base}/`);
    await heidi.context.close();
  });

  await step('a banned client sees a clear message and no chat UI', async () => {
    const ivan = await visitor('ivan');
    // ban ivan's network the same way the server would
    const { hashIp } = require('../src/moderation');
    moderation.ban(hashIp(`10.1.0.${ipCounter}`, 'ui-sim'), 60000, 'test');
    await startChatting(ivan, 'music');
    await ivan.page.waitForSelector('#screen-error:not([hidden])');
    assert.match(await text(ivan.page, '#error-title'), /Access paused/);
    await ivan.context.close();
  });

  await step('desktop layout renders', async () => {
    const desk1 = await visitor('desk1', { width: 1280, height: 800 });
    const desk2 = await visitor('desk2', { width: 1280, height: 800 });
    await desk1.page.goto(`${base}/`);
    await shot(desk1, '10-landing-desktop');
    await startChatting(desk1, 'movies');
    await startChatting(desk2, 'movies');
    await desk1.page.waitForSelector('#screen-chat:not([hidden])');
    await desk2.page.waitForSelector('#screen-chat:not([hidden])');
    for (const line of ['Have you seen anything good lately?', 'I just rewatched an old classic, honestly still holds up.']) {
      await desk1.page.locator('#input').fill(line);
      await desk1.page.keyboard.press('Enter');
      await sleep(150);
    }
    await desk2.page.locator('#input').fill('Which one? I love old films.');
    await desk2.page.keyboard.press('Enter');
    await desk1.page.waitForFunction(() => document.querySelectorAll('.msg').length >= 3);
    await shot(desk1, '11-chat-desktop');
    await desk1.context.close();
    await desk2.context.close();
  });

  console.log(`\n${passed} steps passed`);
  const relevant = problems.filter((p) => !/Failed to load resource: the server responded with a status of 404/.test(p));
  if (relevant.length) {
    console.error('\nProblems:\n' + relevant.map((p) => ` - ${p}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('No console errors, CSP violations or page errors.');
  }

  await browser.close();
  server.close();
  chat.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
