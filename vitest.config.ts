import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/server.ts',
        'src/types.ts',
        'src/broker/viability-gate.ts',
        // Entrypoints de CLI do Agent Plane: cobertos por smoke tests em subprocesso.
        'src/agentd/server.ts',
        'src/agentd/worker-token.ts',
        'src/worker/main.ts',
        'src/mcp-bridge/main.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
})
