import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagePlugin } from '../packages/build.mjs';

const packages = new Map<string, Promise<Record<string, string>>>();
/** Exercise the exact self-contained artifacts installed outside the checkout, not an internal factory. */
export async function installPackagedPlugin(directory: string, id: string) {
  if (!packages.has(id)) packages.set(id, packagePlugin(id));
  const files = await packages.get(id)!;
  mkdirSync(join(directory, id), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, id, name), content);
}
