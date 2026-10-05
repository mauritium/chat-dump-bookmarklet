/** The build stores spaces of the message tables as '~'; translations must come out identical. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as esbuild from 'esbuild'
import { bundle, i18nPlugin, LANGUAGES, MAX_BYTES } from '../bundle.js'
import { installDom } from './helpers.mjs'

const source = readFileSync(new URL('../src/I18n.js', import.meta.url), 'utf8')

test('no message value contains the space sentinel', () => {
	const values = [...source.matchAll(/^\t\t[a-z_]+: '(.*)',$/gm)].map((m) => m[1])
	assert.ok(values.length > 100)
	assert.ok(values.every((v) => !v.includes('~')))
})

/** Bundles src/I18n.js alone with the build's plugin and imports the result. */
async function builtI18n(languages) {
	const built = await esbuild.build({ entryPoints: ['src/I18n.js'], bundle: true, format: 'esm', write: false, plugins: [i18nPlugin(languages)] })
	return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
}

const PARAMS = { n: 1, list: 'a b', format: 'F', tool: 'T', date: 'D', url: 'U' }
const keys = [...new Set([...source.matchAll(/^\t\t([a-z_]+): '/gm)].map((m) => m[1]))]

test('every language variant translates its own language, falls back to English for the rest, and restores spaces', async () => {
	const srcI18n = await import('../src/I18n.js')
	const setLang = (lang) => {
		installDom('https://claude.ai/')
		Object.defineProperty(global.navigator, 'language', { value: lang, configurable: true })
	}
	const expected = {}
	for (const lang of LANGUAGES) {
		setLang(lang)
		expected[lang] = keys.map((k) => srcI18n.t(k, PARAMS))
	}
	let restored = 0
	for (const variant of LANGUAGES) {
		const i18n = await builtI18n([variant])
		for (const browser of LANGUAGES) {
			setLang(browser)
			// the browser language only matches when it is the variant's language; otherwise English
			const want = browser === variant ? expected[browser] : expected.en
			const got = keys.map((k) => i18n.t(k, PARAMS))
			assert.deepEqual(got, want, `variant ${variant}, browser ${browser}`)
			restored += got.filter((t) => t.includes(' ')).length
		}
	}
	assert.ok(restored > 1000)
})

test('the default build contains English only', async () => {
	const i18n = await builtI18n([])
	installDom('https://claude.ai/')
	Object.defineProperty(global.navigator, 'language', { value: 'it', configurable: true })
	assert.equal(i18n.t('save_md'), 'Save as MD')
	assert.equal(i18n.isRtl(), false)
})

test('Arabic and Urdu variants keep right-to-left layout', async () => {
	for (const lang of ['ar', 'ur']) {
		const i18n = await builtI18n([lang])
		installDom('https://claude.ai/')
		Object.defineProperty(global.navigator, 'language', { value: lang, configurable: true })
		assert.equal(i18n.isRtl(), true, lang)
	}
})

test('unknown languages are rejected', () => {
	assert.throws(() => i18nPlugin(['xx']), /Unknown language/)
})

test('every release variant fits the size limit and carries exactly English plus its language', async () => {
	const english = decodeURIComponent((await bundle()).bookmarklet.slice('javascript:'.length))
	assert.ok(english.includes('save_md:"Save~as~MD"'))
	for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
		const { bookmarklet } = await bundle({ languages: [lang] })
		assert.ok(Buffer.byteLength(bookmarklet) <= MAX_BYTES, `${lang}: ${Buffer.byteLength(bookmarklet)} bytes`)
		const code = decodeURIComponent(bookmarklet.slice('javascript:'.length))
		for (const other of LANGUAGES) {
			const present = new RegExp(`[,{]${other}:\\{save_txt:`).test(code)
			assert.equal(present, other === 'en' || other === lang, `${lang} variant, table ${other}`)
		}
	}
})

test('the committed bookmarklet carries the translations with sentinel spaces', () => {
	const built = decodeURIComponent(readFileSync(new URL('../dist/chatdump.bookmarklet.js', import.meta.url), 'utf8').slice('javascript:'.length))
	assert.match(built, /save_md:"Save~as~MD"/)
})
