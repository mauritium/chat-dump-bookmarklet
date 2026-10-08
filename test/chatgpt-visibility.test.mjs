/**
 * Only what the chat window shows by default is exported: the answer, not the
 * working phase (tool calls, commentary, analysis, reasoning), whether or not
 * the UI lets you expand it. Messages are invented but shaped like real ones.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mockFetch, pagedRoutes, CONV_ID } from './helpers.mjs'

installDom(`https://chatgpt.com/c/${CONV_ID}`)
const ChatGPTParser = (await import('../src/Parsers/ChatGPTParser.js')).default

let n = 0
/** Builds a message; overrides win. */
function msg(role, content, extra = {}) {
	const i = ++n
	return { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, author: { role, name: null, metadata: {} }, create_time: 1700000000 + i, update_time: 1700000000 + i, content, status: 'finished_successfully', end_turn: false, weight: 1, metadata: {}, recipient: 'all', channel: null, ...extra }
}
const text = (s) => ({ content_type: 'text', parts: [s] })
const code = (s) => ({ content_type: 'code', language: 'unknown', response_format_name: null, text: s })

/** Runs a conversation through the parser and returns the exported responses. */
async function run(messages) {
	const page = { title: 'T', messages, current_node: messages[messages.length - 1].id, page_info: { start_cursor: messages[0].id, has_previous_page: false, has_next_page: false } }
	mockFetch(pagedRoutes([page]))
	const r = await ChatGPTParser.parseRemote({})
	return r.items.filter((i) => i.role === 'RESPONSE')
}

test('only the final answer is exported; working-phase messages are not', async () => {
	const responses = await run([
		msg('user', text('Write a short plan.')),
		msg('assistant', { content_type: 'thoughts', thoughts: [] }),
		// interim narration of the commentary channel, flagged as a thinking preamble
		msg('assistant', text('I will keep the plan narrow and list the open points first.'), { channel: 'commentary', metadata: { is_thinking_preamble_message: true, hide_inline_actions: true } }),
		// a code interpreter call: tool input addressed to a container, not to the user
		msg('assistant', code("bash -lc ls -l /mnt/data && echo '---'"), { recipient: 'container.exec', metadata: { tool_icons: ['code'], reasoning_status: 'is_reasoning' } }),
		msg('tool', { content_type: 'execution_output', text: 'total 4\nfile.txt' }, { author: { role: 'tool', name: 'container.exec', metadata: {} } }),
		msg('assistant', code('cat /mnt/data/file.txt'), { recipient: 'container.exec' }),
		msg('tool', { content_type: 'execution_output', text: 'file contents' }, { author: { role: 'tool', name: 'container.exec', metadata: {} } }),
		// a web search call carrying its query as text
		msg('assistant', text('{"search_query":[{"q":"widget gaskets"}]}'), { recipient: 'web.run' }),
		msg('assistant', text('Reasoning written out as plain text.'), { channel: 'analysis' }),
		msg('assistant', text('More working notes without a channel.'), { metadata: { reasoning_status: 'is_reasoning' } }),
		msg('assistant', text('Another interim note.'), { channel: 'commentary' }),
		msg('assistant', text('A hidden message.'), { metadata: { is_visually_hidden_from_conversation: true } }),
		msg('assistant', text('First part of the answer.'), { channel: 'final' }),
		msg('assistant', text('Second part of the answer.'), { channel: 'final', end_turn: true }),
	])
	assert.equal(responses.length, 1)
	assert.equal(responses[0].markdown, 'First part of the answer.\n\nSecond part of the answer.')
	assert.deepEqual(responses[0].meta.models, [])
})

test('answers without a channel (older format) or without a recipient are still exported', async () => {
	const noRecipient = msg('assistant', text('Answer without recipient field.'))
	delete noRecipient.recipient
	const responses = await run([
		msg('user', text('First')),
		msg('assistant', text('Plain answer, channel null, addressed to the user.'), { end_turn: true }),
		msg('user', text('Second')),
		noRecipient,
	])
	assert.deepEqual(
		responses.map((r) => r.markdown),
		['Plain answer, channel null, addressed to the user.', 'Answer without recipient field.'],
	)
})

test('a turn with nothing but working-phase messages yields no response', async () => {
	const responses = await run([msg('user', text('Hi')), msg('assistant', text('thinking out loud'), { channel: 'commentary' }), msg('assistant', code('ls'), { recipient: 'container.exec' })])
	assert.equal(responses.length, 0)
})

test('code blocks inside the answer text stay; the response metadata comes from the shown messages only', async () => {
	const responses = await run([
		msg('user', text('Show code')),
		msg('assistant', text('Working note.'), { channel: 'commentary', metadata: { model_slug: 'model-a' } }),
		msg('assistant', text('Here:\n\n```python\nprint(1)\n```'), { channel: 'final', end_turn: true, create_time: 1700001000, update_time: 1700001005, metadata: { model_slug: 'model-b' } }),
	])
	assert.equal(responses[0].markdown, 'Here:\n\n```python\nprint(1)\n```')
	assert.deepEqual(responses[0].meta.models, ['model-b'])
	assert.equal(responses[0].meta.created, '2023-11-14T22:30:00.000Z')
})
