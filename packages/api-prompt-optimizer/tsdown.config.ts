import { defineConfig } from 'tsdown'

export default defineConfig([
  { name: 'types', entry: ['src/types.ts'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: { sourcemap: false } },
  { name: 'index', entry: ['src/index.ts'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: { sourcemap: false } },
  { name: 'typert', entry: { 'typert.host': 'src/generated/typert.host.ts', 'typert.remote-client': 'src/generated/typert.remote-client.ts' }, outDir: 'lib/generated', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: { sourcemap: false } },
])
