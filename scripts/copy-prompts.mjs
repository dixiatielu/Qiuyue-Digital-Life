import { cpSync } from 'node:fs';

cpSync(new URL('../src/prompts/', import.meta.url), new URL('../dist/prompts/', import.meta.url), { recursive: true });
