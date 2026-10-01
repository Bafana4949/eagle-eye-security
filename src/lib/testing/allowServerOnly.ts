/**
 * TEST SUPPORT ONLY - never import from application code.
 *
 * Server modules start with `import 'server-only'`, which makes `next build` fail when a Client
 * Component (browser bundle) imports them. Outside Next.js the package's default export throws
 * unconditionally, so node:test could not load those modules at all. Importing THIS file first
 * (before the module under test) replaces the marker with an empty module for the current test
 * process only. The Next.js build is unaffected: it resolves `server-only` itself.
 *
 * Works because tsx runs the test files as CommonJS (package.json has no "type": "module");
 * should that ever change, the import of the server module fails loudly instead of silently.
 */
import { createRequire } from 'node:module';

const requireHere = createRequire(__filename);
const resolved = requireHere.resolve('server-only');
const cache = requireHere.cache as Record<string, unknown>;
if (!cache[resolved]) {
  cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {}, children: [], paths: [] };
}
