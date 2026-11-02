import { cpSync } from 'node:fs';

for (const dir of ['prompts', 'webui/public']) cpSync(new URL(`../src/${dir}/`, import.meta.url), new URL(`../dist/${dir}/`, import.meta.url), { recursive: true });
