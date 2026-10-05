#!/usr/bin/env node
/**
 * Builds the bookmarklet.
 *
 *   node build.js              dist/chatdump.bookmarklet.js (English; committed)
 *   node build.js --check      nothing is written; exits 1 unless the committed file equals a fresh build
 *   node build.js --release    release/chatdump.<lang>.bookmarklet.js for every language (English
 *                              plus that language) and release/SHA256SUMS; not committed
 *
 * All modes print the SHA-256 and fail if a bookmarklet exceeds the size limit.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { bundle, LANGUAGES, MAX_BYTES } from './bundle.js'

const OUT = 'dist/chatdump.bookmarklet.js'
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
let failed = false

/**
 * Prints the size line for a bookmarklet and flags it when over the limit.
 * @param {string} label - What was built.
 * @param {string} bookmarklet - The javascript: URL.
 * @param {number} rawBytes - Size of the unencoded JavaScript.
 */
function report(label, bookmarklet, rawBytes) {
	const size = Buffer.byteLength(bookmarklet)
	console.log(`${label}: ${size} bytes (raw JS: ${rawBytes}, limit: ${MAX_BYTES}), sha256 ${sha256(bookmarklet)}`)
	if (size > MAX_BYTES) {
		console.error(`ERROR: ${label} exceeds the ${MAX_BYTES}-byte limit`)
		failed = true
	}
}

if (process.argv.includes('--release')) {
	mkdirSync('release', { recursive: true })
	const sums = []
	for (const lang of LANGUAGES) {
		const { bookmarklet, rawBytes } = await bundle({ languages: [lang] })
		const file = `chatdump.${lang}.bookmarklet.js`
		writeFileSync(`release/${file}`, bookmarklet)
		sums.push(`${sha256(bookmarklet)}  ${file}`)
		report(file, bookmarklet, rawBytes)
	}
	writeFileSync('release/SHA256SUMS', sums.join('\n') + '\n')
} else {
	const { bookmarklet, rawBytes } = await bundle()
	if (process.argv.includes('--check')) {
		const same = readFileSync(OUT, 'utf8') === bookmarklet
		console.log(`${same ? 'OK' : 'MISMATCH'}: ${OUT} ${same ? 'reproduces from source' : 'differs from a fresh build'} (sha256 ${sha256(bookmarklet)})`)
		process.exit(same ? 0 : 1)
	}
	writeFileSync(OUT, bookmarklet)
	report(OUT, bookmarklet, rawBytes)
}
process.exit(failed ? 1 : 0)
