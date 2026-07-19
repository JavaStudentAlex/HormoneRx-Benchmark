import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const backendDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: backendDir,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
