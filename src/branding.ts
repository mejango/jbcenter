import { hashedAsset } from "./hashedAsset.js";
export const BRAND_ICON = '<span class="brand-icon" aria-hidden="true">⚡️</span>';
export const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="52" text-anchor="middle" font-size="56" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">⚡️</text></svg>';
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="${hashedAsset("/favicon.svg", FAVICON_SVG).href}">`;
export const BRAND_CSS = '.brand-icon{font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",emoji;font-weight:400;font-style:normal}';
