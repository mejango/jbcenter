import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { qrModules, qrSvg } from '../src/rest/web/qr.js';

/** The page's own encoder must produce the same modules as a reference encoder for the same
 * version, level M and mask, for every length the device link can take. */
describe('account page QR encoder', () => {
  it('matches the reference encoder module for module across versions and masks', () => {
    const samples = ['https://my.juicebox.center/add#' + 'A'.repeat(43), 'https://my.juicebox.center/add#' + 'a1-_'.repeat(11).slice(0, 43),
      'juicebox', 'x'.repeat(60), 'https://my.juicebox.center/add#' + 'Z9_-'.repeat(20)];
    for (const text of samples) for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const reference = QRCode.create([{ data: Buffer.from(text), mode: 'byte' }], { errorCorrectionLevel: 'M', maskPattern: mask as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 });
      const ours = qrModules(text, mask);
      expect(ours.version, `${text.length} chars`).toBe(reference.version);
      expect(ours.size).toBe(reference.modules.size);
      const mismatches: string[] = [];
      for (let y = 0; y < ours.size; y++) for (let x = 0; x < ours.size; x++)
        if (ours.dark(x, y) !== (reference.modules.get(y, x) === 1)) mismatches.push(`${x},${y}`);
      expect(mismatches, `${text.length} chars mask ${mask}: ${mismatches.slice(0, 5).join(' ')}`).toEqual([]);
    }
  });
  it('renders an accessible SVG with a quiet zone', () => {
    const svg = qrSvg('https://my.juicebox.center/add#' + 'A'.repeat(43), 'Add a device link');
    expect(svg).toContain('aria-label="Add a device link"'); expect(svg).toMatch(/viewBox="0 0 (\d+) \1"/);
    expect(() => qrSvg('x'.repeat(500), 'too long')).toThrow();
  });
});
