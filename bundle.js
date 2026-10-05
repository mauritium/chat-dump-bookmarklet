/**
 * The one definition of how dist/chatdump.bookmarklet.js is produced; shared
 * by build.js and the reproducibility test so they cannot drift apart.
 */
import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import { encodeBookmarklet } from './encode.js'

// Browser bookmarklet hard limit (URL length): keep the encoded build below this.
export const MAX_BYTES = 62 * 1024

// Every language of src/I18n.js; English is always included as the fallback
export const LANGUAGES = ['en', 'zh', 'hi', 'es', 'fr', 'ar', 'bn', 'pt', 'ru', 'ur', 'it']

/**
 * Prepares src/I18n.js for the bookmarklet: keeps English plus the requested
 * languages (the tables of the others cost about 1KB each once encoded), and
 * rewrites the spaces inside the message values to '~' (t() turns them back;
 * a space costs 3 bytes in the percent-encoded URL, a '~' one).
 * @param {string[]} [languages] - Languages to keep in addition to 'en'.
 * @returns {import('esbuild').Plugin}
 */
export function i18nPlugin(languages = []) {
	const unknown = languages.filter((l) => !LANGUAGES.includes(l))
	if (unknown.length) {
		throw new Error(`Unknown language(s): ${unknown.join(', ')} (available: ${LANGUAGES.join(', ')})`)
	}
	const keep = ['en', ...languages]
	return {
		name: 'i18n',
		setup(build) {
			build.onLoad({ filter: /src[\\/]I18n\.js$/ }, async (args) => {
				let contents = await readFile(args.path, 'utf8')
				contents = contents.replace(/^(\t\t[a-z_]+: ')(.*)(',)$/gm, (m, head, value, tail) => head + value.replace(/ /g, '~') + tail)
				contents = contents.replace(/^\t([a-z]{2}): \{\n[\s\S]*?^\t\},\n/gm, (table, lang) => (keep.includes(lang) ? table : ''))
				return { contents, loader: 'js' }
			})
		},
	}
}

/**
 * Bundles index.js and returns the javascript: URL.
 * @param {{languages?: string[]}} [options] - Languages to include besides English.
 * @returns {Promise<{bookmarklet: string, rawBytes: number}>}
 */
export async function bundle(options) {
	const result = await esbuild.build({
		bundle: true,
		entryPoints: ['index.js'],
		format: 'iife',
		legalComments: 'none',
		minify: true,
		// Never write a file here: the caller decides. Output path is only used for type detection.
		outfile: 'dist/chatdump.bookmarklet.js',
		sourcemap: false,
		// The chat platforms themselves require evergreen browsers: no point
		// transpiling below what claude.ai/chatgpt.com/gemini already demand.
		target: ['chrome90', 'firefox88', 'safari14', 'edge90'],
		write: false,
		plugins: [i18nPlugin(options && options.languages)],
	})
	const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text
	return { bookmarklet: encodeBookmarklet('void ' + js), rawBytes: Buffer.byteLength(js) }
}
