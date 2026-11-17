/** Runs the original script-style API checks (remote-*.js) as part of npm test. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

for (const script of ['remote-chatgpt.js', 'remote-claude.js', 'remote-gemini.js']) {
	test(`legacy check ${script}`, () => {
		const out = execFileSync(process.execPath, [`test/${script}`], { encoding: 'utf8' })
		assert.match(out, /all checks passed/)
		assert.doesNotMatch(out, /FAIL/)
	})
}
