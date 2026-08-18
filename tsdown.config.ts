import { defineConfig } from 'tsdown'

/**
 * TianShu (天枢) build config.
 *
 * Two build faces:
 *  - Host (node, ESM): the agent tool + auto-trigger + server API.
 *  - Client (browser, CJS factory): wrapped in window.__ModuleLoader__.load({id, factory})
 *    per the DSH client-modules lazy-CJS contract.
 */

const PLUGIN_ID = 'dsh-tianshu-analyzer'

/** Browser platform modules the shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Runtime store exemption (snapshot-store engine, pending rehoming). */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** Host-side externals (node packages resolved at runtime). */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-conversation',
  'react',
  'node:fs',
  'node:path',
  'node:os',
]

export default defineConfig([
  // --- Host (node, ESM) ---
  {
    name: PLUGIN_ID,
    entry: { index: 'src/index.ts' },
    format: 'esm',
    dts: true,
    outDir: 'lib',
    target: 'node20',
    platform: 'node',
    deps: { neverBundle: HOST_EXTERNALS },
    unbundle: true,
  },
  // --- Client (browser, CJS factory) ---
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    external: [...CLIENT_EXTERNALS],
    // Everything NOT in the module table must inline (no require() the table cannot answer).
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // The lazy-CJS contract: bundle executes only to register its factory.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
