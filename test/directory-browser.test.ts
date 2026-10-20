import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryStore } from './support/memoryStore.js';

describe('directory browser navigation', () => {
  let browser: Browser, page: Page;
  const app = createApp(new MemoryStore());
  const fetched: string[] = [];
  const errors: string[] = [];
  // Journey maps answer only once released, so a test can act while one is still loading.
  let hold: Promise<void> = Promise.resolve();
  const holdMaps = () => { let release!: () => void; hold = new Promise(resolve => { release = resolve; }); return release; };
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    fetched.length = 0;
    hold = Promise.resolve();
    await page.route('https://directory.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/assets/journey-')) { fetched.push(path); await hold; }
      const response = await app.request(path);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
  });
  afterEach(async () => { await page.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });
  const current = () => page.locator('.journey-node.current').getAttribute('id');
  const open = (id: string) => page.locator(id).evaluate(node => (node as HTMLDetailsElement).open);

  it('opens and scrolls to a native directory fragment on first load', async () => {
    await page.goto('https://directory.test/#directory-agents');
    await page.waitForSelector('.is-enhanced');
    await expect.poll(() => open('#directory-agents')).toBe(true);
    expect(await open('#directory')).toBe(true);
    await expect.poll(() => page.locator('#directory-agents > summary').evaluate(node => {
      const rect = node.getBoundingClientRect(); return rect.top >= -1 && rect.bottom <= innerHeight;
    })).toBe(true);
  });

  it('keeps the selected map when following the MCP reference and skip link', async () => {
    await page.goto('https://directory.test/#api/pinning');
    await page.locator('#map-api a[href="#directory-agents"]').click();
    await expect.poll(() => open('#directory-agents')).toBe(true);
    expect(await current()).toBe('api/pinning');
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
    expect(await current()).toBe('api/pinning');
  });

  it('preserves legacy graph links, forward navigation and browser history', async () => {
    await page.goto('https://directory.test/#rpc');
    await expect.poll(current).toBe('api/rpc');
    await page.locator('#map-api [data-node="rpc"] a[data-to="sdk"]').click();
    await expect.poll(current).toBe('developers/sdk');
    await page.goBack();
    await expect.poll(current).toBe('api/rpc');
    await page.goForward();
    await expect.poll(current).toBe('developers/sdk');
  });

  it('inlines only the first map and loads another the first time it is opened', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/');
    await page.waitForSelector('.is-enhanced');
    expect(await page.locator('.journey-map').count()).toBe(1);
    await page.locator('#journey-developers').click();
    release();
    await expect.poll(current).toBe('developers/' + await page.locator('#map-developers').getAttribute('data-entry'));
    expect(await page.locator('#map-apps').isHidden()).toBe(true);
    await expect.poll(() => page.locator('#map-developers svg.journey-lines path').count()).toBeGreaterThan(0);
    await page.locator('#journey-apps').click();
    await page.locator('#journey-developers').click();
    expect(fetched.filter(path => path.startsWith('/assets/journey-developers.'))).toHaveLength(1);
  });

  it('follows an edge into a map that is not loaded yet', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/');
    const edge = page.locator('#map-apps a.journey-edge[data-target-view]:not([data-target-view="apps"])').first();
    const [view, node] = await edge.evaluate(link => [(link as HTMLElement).dataset.targetView!, (link as HTMLElement).dataset.to!]);
    expect(await page.locator('#map-' + view).count()).toBe(0);
    await edge.click();
    release();
    await expect.poll(current).toBe(view + '/' + node);
    expect(new URL(page.url()).hash).toBe('#' + view + '/' + node);
    await page.goBack();
    await expect.poll(current).toBe('apps/' + await page.locator('#map-apps').getAttribute('data-entry'));
  });

  it('keeps the latest choice when an earlier map finishes loading after it', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/');
    await page.waitForSelector('.is-enhanced');
    const entries = await page.evaluate(() => history.length);
    await page.locator('#journey-developers').click();
    await page.locator('#journey-apps').click();
    release();
    await expect.poll(() => page.locator('#map-developers').count()).toBe(1);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await current()).toBe('apps/' + await page.locator('#map-apps').getAttribute('data-entry'));
    expect(await page.locator('#journey-apps').getAttribute('aria-expanded')).toBe('true');
    expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  });

  it('lets Back cancel a map that is still loading', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/');
    await page.waitForSelector('.is-enhanced');
    const shown = await current();
    // Both maps are still loading, so Back lands on the route already on screen.
    await page.evaluate(() => { location.hash = 'api/rpc'; });
    await page.locator('#journey-developers').click();
    await page.goBack();
    release();
    await expect.poll(() => page.locator('#map-developers').count()).toBe(1);
    await expect.poll(() => page.locator('#map-api').count()).toBe(1);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await current()).toBe(shown);
    expect(new URL(page.url()).hash).toBe('');
  });

  it('keeps a choice made between the two events of one address change', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/');
    await page.waitForSelector('.is-enhanced');
    await page.evaluate(() => { location.hash = 'directory-agents'; document.querySelector<HTMLElement>('#journey-developers')!.click(); });
    release();
    await expect.poll(current).toBe('developers/' + await page.locator('#map-developers').getAttribute('data-entry'));
  });

  it('lets a repeated click on the current fragment cancel a map that is still loading', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/');
    await page.waitForSelector('.is-enhanced');
    const shown = await current();
    const follow = () => page.evaluate(() => document.querySelector<HTMLElement>('a[href="#directory-agents"]')!.click());
    await follow();
    await page.locator('#journey-developers').click();
    await follow();
    release();
    await expect.poll(() => page.locator('#map-developers').count()).toBe(1);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await current()).toBe(shown);
    expect(new URL(page.url()).hash).toBe('#directory-agents');
  });

  it('keeps a later choice when a tab moved the address between the two events of one change', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/');
    await page.waitForSelector('.is-enhanced');
    await page.evaluate(async () => {
      document.querySelector<HTMLElement>('a[href="#directory-agents"]')!.click();
      document.querySelector<HTMLElement>('#journey-apps')!.click();
      await Promise.resolve();
      document.querySelector<HTMLElement>('#journey-developers')!.click();
    });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    release();
    await expect.poll(current).toBe('developers/' + await page.locator('#map-developers').getAttribute('data-entry'));
  });

  it('routes a deep link again when Back returns to it before its map loaded', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/#api/rpc');
    await page.waitForSelector('.is-enhanced');
    await page.evaluate(() => { location.hash = 'developers/sdk'; });
    await page.goBack();
    release();
    await expect.poll(current).toBe('api/rpc');
  });

  it('does not scroll for a deep link that a later choice replaced', async () => {
    const release = holdMaps();
    await page.goto('https://directory.test/#api/rpc');
    await page.waitForSelector('.is-enhanced');
    await page.locator('#journey-apps').click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    release();
    await expect.poll(() => page.locator('#map-api').count()).toBe(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    expect(await current()).toBe('apps/' + await page.locator('#map-apps').getAttribute('data-entry'));
  });

  it('loads every map once the page is idle, so printing shows them all', async () => {
    await page.goto('https://directory.test/');
    const tabs = await page.locator('.journey-tabs button[data-view]').count();
    await expect.poll(() => page.locator('.journey-map').count()).toBe(tabs);
    await page.emulateMedia({ media: 'print' });
    for (const map of await page.locator('.journey-map').all()) expect(await map.isVisible()).toBe(true);
  });
});
