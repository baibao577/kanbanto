import { defineConfig } from 'tsup'

// One file for production. The shared model is TypeScript source, so it's bundled in.
export default defineConfig({
  entry: ['src/main.ts', 'src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  // react-email is only a build-time dependency: the few email components used are bundled, so production installs
  // don't pull in its preview tool.
  noExternal: ['@kanbanto/model', 'react-email'],
  sourcemap: true,
  clean: true,
})
