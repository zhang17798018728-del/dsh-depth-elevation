#!/usr/bin/env node
/**
 * Stub the harness peers so the test suites can import lib/index.js on a bare CI
 * runner.
 *
 * The plugin has no dependencies of its own: at runtime the harness supplies
 * @deepseek-ai/dsh-llm, @deepseek-ai/schemastery and @deepseek-ai/cordis as
 * peers. On GitHub Actions there is no harness, so those imports fail before a
 * single assertion runs.
 *
 * These stubs are deliberately minimal — just enough for the import graph to
 * load and for `apply()` to construct messages. They are NOT an emulation of the
 * harness. Behaviour is verified by test/decide.test.mjs (needs no peers) and by
 * tools/verify_elevation_plugin.py against a real install.
 *
 *   node tools/stub-peers.mjs
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NM = join(ROOT, 'node_modules');

const PACKAGES = {
  '@deepseek-ai/dsh-llm': {
    pkg: { name: '@deepseek-ai/dsh-llm', version: '0.0.0-stub', type: 'module', main: 'index.js' },
    code: `export function createUserMessage(input) {
  return { role: 'user', content: input?.content ?? [], source: input?.source };
}
`,
  },
  '@deepseek-ai/schemastery': {
    pkg: { name: '@deepseek-ai/schemastery', version: '0.0.0-stub', type: 'module', main: 'index.js' },
    // Only the chainable builder surface the plugin's Config uses. Returns the
    // same object so .default().description() chains resolve to a plain schema.
    code: `function builder(fallback) {
  const self = {
    default: (v) => { fallback = v; return self; },
    description: () => self,
    required: () => self,
    _fallback: () => fallback,
  };
  return self;
}
const z = {
  object: (shape) => {
    const schema = {
      shape,
      __defaults: () => Object.fromEntries(
        Object.entries(shape).map(([k, v]) => [k, typeof v?._fallback === 'function' ? v._fallback() : undefined]),
      ),
    };
    function Ctor(config) {
      const defaults = schema.__defaults();
      return { ...defaults, ...(config ?? {}) };
    }
    Ctor.__schema = schema;
    return Ctor;
  },
  string: () => builder(undefined),
  number: () => builder(undefined),
  natural: () => builder(undefined),
  boolean: () => builder(undefined),
  array: () => builder([]),
};
export default z;
`,
  },
  '@deepseek-ai/cordis': {
    pkg: { name: '@deepseek-ai/cordis', version: '0.0.0-stub', type: 'module', main: 'index.js' },
    // The plugin only uses the context object the harness passes to apply().
    code: `export const Context = class {};
`,
  },
};

let written = 0;
for (const [name, { pkg, code }] of Object.entries(PACKAGES)) {
  const dir = join(NM, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(dir, 'index.js'), code);
  written += 1;
}

if (!existsSync(join(NM, '@deepseek-ai'))) {
  console.error('stub dir was not created');
  process.exit(1);
}
console.log(`stubbed ${written} peers into ${NM}`);
