import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: ['dist/', 'dist-client/', 'dist-vscode/', 'coverage/', 'node_modules/', 'eslint.config.js'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Model Plane (/v1): nunca importa o Agent Plane (ADR-025).
    files: ['src/*.ts', 'src/routes/**/*.ts', 'src/providers/**/*.ts', 'src/translation/**/*.ts', 'src/upstream/**/*.ts', 'src/models/**/*.ts', 'src/http/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(\\.\\./|\\./)+(agents|agent-control|agentd|workspace|agent-client|worker|vscode-extension)/',
          message: 'O Model Plane não pode depender do Native Agent Plane (ADR-025).',
        }],
      }],
    },
  },
  {
    // Native Agent Plane: nunca importa o Model Plane; compartilha só config, security e observability.
    files: ['src/agents/**/*.ts', 'src/agent-control/**/*.ts', 'src/agentd/**/*.ts', 'src/workspace/**/*.ts', 'src/agent-client/**/*.ts', 'src/worker/**/*.ts', 'src/vscode-extension/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(\\.\\./)+(routes|providers|translation|upstream|models|http|cli-catalog|app|server|types)(/|\\.js$)',
          message: 'O Native Agent Plane não pode depender do Model Plane (ADR-025).',
        }],
      }],
    },
  },
  {
    // Executáveis falsos das CLIs de agente (JS puro, fora do projeto TypeScript).
    files: ['test/fixtures/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: 'readonly', setTimeout: 'readonly' },
    },
  },
)
