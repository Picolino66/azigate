import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['test/setup-home.ts'],
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
        'src/workspace/server/main.ts',
        'src/agentd/mcp-bridge/main.ts',
        'src/agentd/agy-remote.ts',
        'src/agent-client/main.ts',
        'src/agentd/client-setup-cli.ts',
        // Ponto de entrada da extensão VS Code: só liga a API do editor ao SessionController.
        'src/vscode-extension/extension.ts',
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
