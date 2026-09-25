import { describe, expect, it } from 'vitest'
import type { ChatBody } from '../src/types.js'
import { InvalidReasoningEffortError, resolveCliEffort } from '../src/providers/reasoning-effort.js'

function body(overrides: Partial<ChatBody> = {}): ChatBody {
  return { model: 'codex-cli', messages: [], ...overrides }
}

describe('resolveCliEffort', () => {
  it('normaliza effort Claude por modelo e aplica os defaults da tabela', () => {
    expect(resolveCliEffort(body({ reasoning_effort: 'xhigh' }), 'claude', 'claude-opus-5')).toBe('xhigh')
    expect(resolveCliEffort(body(), 'claude', 'claude-opus-5-5')).toBe('medium')
    expect(resolveCliEffort(body(), 'claude', 'claude-fable-5-1')).toBe('high')
    expect(resolveCliEffort(body({ reasoning_effort: 'max' }), 'claude', 'claude-haiku-4-5')).toBeUndefined()
  })

  it('normaliza effort Codex e reduz max para xhigh', () => {
    expect(resolveCliEffort(body({ reasoning_effort: 'max' }), 'codex', 'gpt-5.4')).toBe('xhigh')
    expect(resolveCliEffort(body(), 'codex', 'gpt-5.4')).toBe('medium')
  })

  it('aceita reasoning.effort aninhado, preserva precedência e trata reasoning false/{} como default', () => {
    expect(resolveCliEffort(body({ reasoning: { effort: 'low' } }), 'codex', 'gpt-5.4')).toBe('low')
    expect(
      resolveCliEffort(body({ reasoning_effort: 'high', reasoning: { effort: 'low' } }), 'codex', 'gpt-5.4'),
    ).toBe('high')
    expect(resolveCliEffort(body({ reasoning: false }), 'codex', 'gpt-5.4')).toBe('medium')
    expect(resolveCliEffort(body({ reasoning: {} }), 'codex', 'gpt-5.4')).toBe('medium')
  })

  it.each([
    { reasoning: { effort: 'extreme' } },
    { reasoning: 'medium' },
    { reasoning: [] },
    { reasoning: null },
  ])('rejeita reasoning malformado: %j', (overrides) => {
    expect(() => resolveCliEffort(body(overrides), 'codex', 'gpt-5.4')).toThrow(InvalidReasoningEffortError)
  })

  it.each(['none', '', 42, null])('rejeita reasoning_effort inválido: %j', (effort) => {
    expect(() => resolveCliEffort(body({ reasoning_effort: effort }), 'claude', 'claude-sonnet-5')).toThrow(
      InvalidReasoningEffortError,
    )
  })

  it('usa o effort quando pertence à matriz do modelo, senão cai no default', () => {
    expect(resolveCliEffort(body({ reasoning_effort: 'max' }), 'claude', 'claude-opus-5-5')).toBe('max')
    expect(resolveCliEffort(body({ reasoning_effort: 'low' }), 'claude', 'claude-haiku-4-5')).toBeUndefined()
  })
})
