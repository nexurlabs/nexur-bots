import { expect, test } from 'bun:test'

const { modelFamily } = await import('../src/ui/bot-settings')

test('a model is grouped under its family, without the version', () => {
  expect(modelFamily('claude-opus-5-5')).toBe('claude-opus')
  expect(modelFamily('claude-fable-5.1')).toBe('claude-fable')
  expect(modelFamily('gpt-4o')).toBe('gpt')
  expect(modelFamily('llama3.1:8b')).toBe('llama')
})

test('a model with no version keeps its whole name as its family', () => {
  expect(modelFamily('mistral-large')).toBe('mistral-large')
})
