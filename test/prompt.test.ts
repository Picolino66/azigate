import { describe, expect, it } from 'vitest'
import { decisionJsonSchema } from '../src/broker/prompt.js'

function collectArraySchemas(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectArraySchemas(item, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  const record = node as Record<string, unknown>
  if (record.type === 'array') found.push(record)
  for (const value of Object.values(record)) collectArraySchemas(value, found)
  return found
}

describe('schema de decisão CLI', () => {
  it('gera raiz única tipo objeto compatível com structured outputs quando texto e tools são permitidos', () => {
    expect(decisionJsonSchema({
      tools: [{ name: 'read_file', parameters: {} }, { name: 'write_file', parameters: {} }],
      toolChoice: 'auto',
      parallelToolCalls: false,
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['content', 'tool_calls'],
      properties: {
        content: { type: ['string', 'null'] },
        tool_calls: {
          type: 'array',
          maxItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { type: 'string', enum: ['read_file', 'write_file'] },
              arguments: { type: 'string' },
            },
          },
        },
      },
    })
  })

  it('restringe content a null e exige tool call quando tool_choice força uma ferramenta', () => {
    expect(decisionJsonSchema({
      tools: [{ name: 'read_file', parameters: {} }],
      toolChoice: { name: 'read_file' },
      parallelToolCalls: false,
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['content', 'tool_calls'],
      properties: {
        content: { type: 'null' },
        tool_calls: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { type: 'string', enum: ['read_file'] },
              arguments: { type: 'string' },
            },
          },
        },
      },
    })
  })

  it('não limita a quantidade de tool calls quando parallel_tool_calls é permitido', () => {
    expect(decisionJsonSchema({
      tools: [{ name: 'read_file', parameters: {} }],
      toolChoice: 'required',
      parallelToolCalls: true,
    })).toMatchObject({
      properties: {
        content: { type: 'null' },
        tool_calls: { minItems: 1 },
      },
    })
  })

  it('impede tools quando tool_choice é none', () => {
    const schema = decisionJsonSchema({ tools: [], toolChoice: 'none', parallelToolCalls: false })
    expect(schema).toMatchObject({
      properties: {
        content: { type: 'string' },
        tool_calls: { maxItems: 0 },
      },
    })
  })

  it('nunca emite oneOf/anyOf na raiz nem arrays sem items, rejeitados pelo structured outputs da OpenAI', () => {
    const variants = [
      decisionJsonSchema({ tools: [{ name: 'read_file', parameters: {} }], toolChoice: 'auto', parallelToolCalls: true }),
      decisionJsonSchema({ tools: [{ name: 'read_file', parameters: {} }], toolChoice: 'required', parallelToolCalls: false }),
      decisionJsonSchema({ tools: [{ name: 'read_file', parameters: {} }], toolChoice: { name: 'read_file' }, parallelToolCalls: false }),
      decisionJsonSchema({ tools: [], toolChoice: 'auto', parallelToolCalls: true }),
      decisionJsonSchema({ tools: [], toolChoice: 'none', parallelToolCalls: false }),
    ]
    for (const schema of variants) {
      expect(schema.type).toBe('object')
      expect(schema).not.toHaveProperty('oneOf')
      expect(schema).not.toHaveProperty('anyOf')
      for (const arraySchema of collectArraySchemas(schema)) {
        expect(arraySchema.items).toBeDefined()
      }
    }
  })
})
