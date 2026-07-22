import { describe, expect, it } from 'vitest'
import { decisionJsonSchema } from '../src/broker/prompt.js'

describe('schema de decisão CLI', () => {
  it('impõe alternativas exclusivas e limita tools ao request atual', () => {
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

  it('impede tools quando tool_choice é none', () => {
    expect(decisionJsonSchema({ tools: [], toolChoice: 'none', parallelToolCalls: false })).toMatchObject({
      properties: { tool_calls: { maxItems: 0 } },
    })
  })
})
