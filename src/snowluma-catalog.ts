/** Compatibility exports; platform-independent modules must not import this catalog. */
export * from './adapters/snowluma/catalog.js';
import { getSnowLumaCatalog } from './adapters/snowluma/catalog.js';
export const snowlumaCatalog = getSnowLumaCatalog().actions;
export const snowlumaCatalogSource = getSnowLumaCatalog().source;
