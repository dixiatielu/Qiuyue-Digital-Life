import { cpSync, rmSync } from 'node:fs';

// Older builds copied the restricted upstream catalog into dist; current builds read a local cache.
rmSync(new URL('../dist/generated/snowluma-catalog.json', import.meta.url), { force: true });
for (const dir of ['prompts', 'webui/public']) cpSync(new URL(`../src/${dir}/`, import.meta.url), new URL(`../dist/${dir}/`, import.meta.url), { recursive: true });

cpSync(new URL('../src/adapters/telegram/LICENSE', import.meta.url), new URL('../dist/adapters/telegram/LICENSE', import.meta.url));
