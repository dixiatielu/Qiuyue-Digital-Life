import { cpSync } from 'node:fs';

for (const dir of ['prompts', 'webui/public']) cpSync(new URL(`../src/${dir}/`, import.meta.url), new URL(`../dist/${dir}/`, import.meta.url), { recursive: true });

cpSync(new URL('../src/adapters/telegram/LICENSE', import.meta.url), new URL('../dist/adapters/telegram/LICENSE', import.meta.url));
