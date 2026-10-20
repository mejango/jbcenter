import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryStore } from './support/memoryStore.js';

describe('directory browser navigation', () => {
  let browser: Browser, page: Page;
  const app = createApp(new MemoryStore());
  const fetched: string[] = [];
  const errors: string[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    fetched.length = 0;
    await page.route('https://directory.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/journeys/')) fetched.push(path);
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
    await page.goto('https://directory.test/');
    await page.waitForSelector('.is-enhanced');
    expect(await page.locator('.journey-map').count()).toBe(1);
    expect(fetched).toEqual([]);
    await page.locator('#journey-developers').click();
    await expect.poll(current).toBe('developers/' + await page.locator('#map-developers').getAttribute('data-entry'));
    expect(await page.locator('#map-apps').isHidden()).toBe(true);
    await expect.poll(() => page.locator('#map-developers svg.journey-lines path').count()).toBeGreaterThan(0);
    await page.locator('#journey-apps').click();
    await page.locator('#journey-developers').click();
    expect(fetched.filter(path => path.startsWith('/journeys/developers.'))).toHaveLength(1);
  });

  it('follows an edge into a map that is not loaded yet', async () => {
    await page.goto('https://directory.test/');
    const edge = page.locator('#map-apps a.journey-edge[data-target-view]:not([data-target-view="apps"])').first();
    const [view, node] = await edge.evaluate(link => [(link as HTMLElement).dataset.targetView!, (link as HTMLElement).dataset.to!]);
    await edge.click();
    await expect.poll(current).toBe(view + '/' + node);
    expect(new URL(page.url()).hash).toBe('#' + view + '/' + node);
    await page.goBack();
    await expect.poll(current).toBe('apps/' + await page.locator('#map-apps').getAttribute('data-entry'));
  });
});
