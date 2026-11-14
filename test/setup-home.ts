import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Nenhum teste pode ler ou alterar a configuração real do operador (~/.gemini, ~/.claude,
// ~/.codex). Cada worker do Vitest recebe um HOME temporário e vazio.
process.env.HOME = mkdtempSync(join(tmpdir(), 'azigate-test-home-'))
