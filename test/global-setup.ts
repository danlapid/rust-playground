import fs from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
// @ts-expect-error plain JS helper shared with the toolchain scripts
import { fixtureObjects, linkNative } from '../toolchain/link-native.mjs';
import { hasCompiler } from './workers.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../dist/toolchain/fixtures');

export default function setup(project: TestProject) {
  if (!fs.existsSync(FIXTURES)) {
    throw new Error('dist/toolchain is missing: run `pnpm toolchain:runtime` first');
  }
  const linked: Record<string, string> = {};
  for (const name of fs.readdirSync(FIXTURES)) {
    linked[name] = Buffer.from(linkNative(fixtureObjects(name))).toString('base64');
  }
  project.provide('hasCompiler', hasCompiler());
  project.provide('linkedFixtures', linked);
  project.provide(
    'fixtureObjects',
    Object.fromEntries(
      fs.readdirSync(FIXTURES).map((name) => [
        name,
        fixtureObjects(name).map((f: string) => fs.readFileSync(f).toString('base64')),
      ]),
    ),
  );
}

declare module 'vitest' {
  export interface ProvidedContext {
    hasCompiler: boolean;
    linkedFixtures: Record<string, string>;
    fixtureObjects: Record<string, string[]>;
  }
}
