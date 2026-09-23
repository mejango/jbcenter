import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOMEPAGE_HTML, HOMEPAGE_CSS } from '../src/homepage.js';
import { HOMEPAGE_JS } from '../src/directoryClient.js';

describe('directory browser navigation', () => {
  let browser: Browser, page: Page;
  const errors: string[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://directory.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: path === '/directory.js' ? 'text/javascript' : path === '/directory.css' ? 'text/css' : 'text/html',
        body: path === '/directory.js' ? HOMEPAGE_JS : path === '/directory.css' ? HOMEPAGE_CSS : HOMEPAGE_HTML });
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
});
