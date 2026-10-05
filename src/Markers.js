/**
 * Converts ChatGPT's inline UI markers into readable Markdown. A marker is
 * \ue200 name (\ue202 argument)* \ue201: citations (cite, genui), links (url),
 * entity names, products, image groups, news lists, videos and widgets. The
 * message's metadata (content_references, and metadata.citations for the older
 * \u3010n \u2020 source\u3011 style) resolves them. Each marker is rendered in turn by
 *
 *   1. the interpreter for its name (links, product lines, ...),
 *   2. the platform's own plain-text rendering of it (the reference's "alt"),
 *   3. a generic "[name: arguments]", and
 *   4. finally any stray private-use delimiter is removed.
 *
 * Nothing invisible survives and no URL is invented. Only assistant text is
 * converted, and never inside fenced or inline code.
 */
import { t } from './I18n.js'
import { safeHttpUrl } from './Html.js'

// One marker; the bare form "genui{...}" (delimiters lost in transit) is accepted too
const MARKER = /\ue200(\w+)((?:\ue202[^\ue200-\ue202]*)*)\ue201|\ue200?genui\ue202?\{"citation":\{[^{}]*\}\}\ue201?/g
const BRACKET = /\u3010[^\u3011\n]*\u3011/g
const START = /^(?:\ue200|\u3010|genui)/

/**
 * Finds fenced and inline code spans, which must stay literal.
 * @param {string} text - The Markdown text.
 * @returns {number[][]} [start, end) offsets.
 */
function codeRanges(text) {
	const ranges = []
	let fence = null
	let start = 0
	let pos = 0
	for (const line of text.split('\n')) {
		const m = line.match(/^\s*(`{3,}|~{3,})/)
		if (m && !fence) {
			fence = m[1]
			start = pos
		} else if (m && m[1].charAt(0) === fence.charAt(0) && m[1].length >= fence.length) {
			ranges.push([start, pos + line.length])
			fence = null
		}
		pos += line.length + 1
	}
	if (fence) ranges.push([start, text.length])
	const inline = /(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g
	let m
	while ((m = inline.exec(text))) ranges.push([m.index, m.index + m[0].length])
	return ranges
}

/**
 * Removes ChatGPT's own tracking parameter from a URL and validates it.
 * @param {string} url - The URL from the metadata.
 * @returns {string|null} A clean http(s) URL, or null when unusable.
 */
function cleanUrl(url) {
	const href = safeHttpUrl(url)
	if (!href) return null
	const parsed = new URL(href)
	if (parsed.searchParams.get('utm_source') === 'chatgpt.com') {
		parsed.searchParams.delete('utm_source')
	}
	return parsed.href.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/**
 * Builds one Markdown link; brackets are dropped from the label because the
 * export renderers do not support escaping them.
 * @param {object} source - An object with url and optional attribution/title.
 * @returns {string|null} The link, or null when the URL is unusable.
 */
function link(source) {
	const href = cleanUrl(source.url)
	if (!href) return null
	const label = (source.attribution || source.title || new URL(href).hostname).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()
	return `[${label}](${href})`
}

/**
 * Collects the distinct links of a content reference: its items, their
 * supporting websites, a single-page reference, or (last resort) safe_urls.
 * @param {object} ref - A content_references entry.
 * @returns {string[]} Markdown links.
 */
function linksOf(ref) {
	const sources = []
	for (const item of Array.isArray(ref.items) ? ref.items : []) {
		sources.push(item, ...(Array.isArray(item.supporting_websites) ? item.supporting_websites : []))
	}
	if (!sources.length && ref.url) sources.push(ref)
	if (!sources.length) {
		for (const url of Array.isArray(ref.safe_urls) ? ref.safe_urls : []) sources.push({ url })
	}
	const links = []
	for (const source of sources) {
		const md = source && link(source)
		if (md && !links.includes(md)) links.push(md)
	}
	return links
}

/**
 * Locates a reference's marker in the text: the occurrence closest to its
 * start_idx among those not yet claimed. start_idx may count code points, so
 * both interpretations are tried as the target position.
 * @param {string} text - The message text.
 * @param {object} ref - A content_references entry.
 * @param {Map<number, object>} claimed - Start offsets already used, with their references.
 * @returns {number} The offset, or -1.
 */
function locate(text, ref, claimed) {
	const needle = ref.matched_text
	const targets = [ref.start_idx]
	if (typeof ref.start_idx === 'number') {
		const cps = Array.from(text)
		targets.push(cps.slice(0, ref.start_idx).join('').length)
	}
	let best = -1
	let bestDistance = Infinity
	for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
		if (claimed.has(at)) continue
		const distance = Math.min(...targets.map((tg) => (typeof tg === 'number' ? Math.abs(tg - at) : 0)))
		if (distance < bestDistance) {
			best = at
			bestDistance = distance
		}
	}
	return best
}

const DELIMITERS = /[\ue200-\ue202]/g

const parse = (text) => {
	try {
		return JSON.parse(text)
	} catch (e) {
		return text
	}
}

/** Flattens arguments to their text values for the generic rendering. */
const flat = (v) => (v && typeof v === 'object' ? Object.values(v).flatMap(flat) : v == null || v === '' ? [] : [String(v).trim()])

/** Text that is safe inside a Markdown link label. */
const plain = (text) => String(text).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Turns the platform's own Markdown fallback (a reference's "alt") into
 * something clean: signed image URLs and empty links are dropped, headings
 * become bold, and the tracking parameter is removed from links.
 * @param {string} alt - The reference's alt text.
 * @returns {string} The cleaned text, possibly empty.
 */
function cleanAlt(alt) {
	return String(alt || '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\(\)/g, '$1')
		.replace(/\]\(([^)\s]+)\)/g, (m, url) => `](${cleanUrl(url) || url})`)
		.replace(/^#{1,6} (.*)$/gm, '**$1**')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/** One product line: bold name, then price, rating and merchants when known. */
function productLine(product, fallbackTitle) {
	const p = product || {}
	const name = plain(p.title || fallbackTitle || '')
	const rating = p.rating == null ? '' : `${p.rating}★${p.num_reviews ? ` (${p.num_reviews} reviews)` : ''}`
	const bits = [p.price, rating, p.merchants].filter(Boolean)
	const href = p.url && cleanUrl(p.url)
	return name ? `**${href ? `[${name}](${href})` : name}**${bits.length ? ` – ${bits.join(', ')}` : ''}` : null
}

const citation = (ids, ref) => {
	const links = ref ? linksOf(ref) : []
	return links.length ? `(${links.join(', ')})` : `[${t('citation_unresolved')}: ${ids.join(', ')}]`
}

// Interpreters: (arguments, reference) => Markdown, or null to use the generic rendering
const KINDS = {
	cite: (a, ref) => citation(a, ref),
	genui: (a, ref) => {
		const data = parse(a[0])
		const c = data && data.citation
		if (c) return citation([].concat(c.refs || c.ref || []), ref)
		const widget = data && typeof data === 'object' ? Object.keys(data)[0] : null
		const body = widget && data[widget]
		if (body && /math/.test(widget) && typeof body.content === 'string') return `$$\n${body.content}\n$$`
		return widget ? `[${widget}: ${flat(body).join(', ')}]` : null
	},
	entity: (a) => {
		const e = parse(a[0])
		return Array.isArray(e) && e[1] ? String(e[1]) : null
	},
	url: (a, ref) => {
		const href = cleanUrl(a[1]) || cleanUrl(ref && ref.item && ref.item.url)
		return href ? `[${plain(a[0])}](${href})` : plain(a[0])
	},
	product: (a, ref) => {
		const d = parse(a[0])
		return productLine(ref && ref.product, Array.isArray(d) ? d[1] : '')
	},
	products: (a, ref) => {
		const sel = (parse(a[0]) || {}).selections
		const items = ref && Array.isArray(ref.products) ? ref.products.map((p) => productLine(p)) : Array.isArray(sel) ? sel.map((s) => productLine(null, s[1])) : []
		return items.filter(Boolean).map((l) => `- ${l}`).join('\n') || null
	},
	image_group: (a, ref) => {
		const links = ((ref && ref.images) || []).map((i) => i.image_result && link({ url: i.image_result.url, title: i.image_result.title })).filter(Boolean)
		return links.length ? `*Images:* ${links.join(', ')}` : '*[Images]*'
	},
	navlist: (a, ref) => {
		const links = ref ? linksOf(ref) : []
		return a[0] ? `**${plain(a[0])}**${links.length ? `: ${links.join(', ')}` : ''}` : null
	},
	video: (a, ref) => {
		const links = ref ? linksOf(ref) : []
		return `*Video:* ${links.length ? links.join(', ') : plain(a[0] || '')}`.trim()
	},
}
// Markers that stand on lines of their own are rendered as blocks
const BLOCKS = ['product', 'products', 'image_group', 'navlist', 'video']

/**
 * Renders one marker.
 * @param {string} marker - The marker text.
 * @param {object|undefined} ref - Its content_references entry, if located.
 * @returns {{name: string, md: string}} The marker name and its Markdown.
 */
function render(marker, ref) {
	const parts = marker.replace(/^\ue200|\ue201$/g, '').split('\ue202')
	const bare = parts.length === 1 && parts[0].startsWith('genui')
	const name = bare ? 'genui' : parts[0]
	const args = bare ? [parts[0].slice(5)] : parts.slice(1)
	const known = KINDS[name] && KINDS[name](args, ref)
	const alt = known == null ? cleanAlt(ref && ref.alt) : ''
	return { name, md: known || alt || `[${name}: ${args.flatMap((x) => flat(parse(x))).join(', ')}]` }
}

/**
 * Converts the markers in an assistant message's Markdown.
 * @param {string} text - The Markdown text of the message.
 * @param {object} [metadata] - The message metadata (content_references, citations).
 * @returns {string} The text with every marker replaced by readable Markdown.
 */
export function convertMarkers(text, metadata) {
	if (!/genui|\ue200|\ue201|\ue202|\u3010/.test(text)) return text
	const refs = metadata && Array.isArray(metadata.content_references) ? metadata.content_references : []
	const ranges = codeRanges(text)
	const inCode = (i) => ranges.some((r) => i >= r[0] && i < r[1])
	const edits = []
	const overlaps = (s, e) => edits.some((x) => s < x.end && e > x.start)
	const add = (start, end, md) => {
		if (!inCode(start) && !overlaps(start, end)) edits.push({ start, end, md })
	}

	// Each reference belongs to the occurrence of its matched_text closest to its start_idx
	const claimed = new Map()
	for (const ref of refs.slice().sort((a, b) => (a.start_idx || 0) - (b.start_idx || 0))) {
		if (ref && typeof ref.matched_text === 'string' && START.test(ref.matched_text)) {
			const at = locate(text, ref, claimed)
			if (at >= 0) claimed.set(at, ref)
		}
	}
	let m
	MARKER.lastIndex = 0
	while ((m = MARKER.exec(text))) {
		const start = m.index
		const end = start + m[0].length
		const out = render(m[0], claimed.get(start))
		const alone = (start === 0 || text[start - 1] === '\n') && (end === text.length || text[end] === '\n')
		add(start, end, BLOCKS.includes(out.name) && !alone ? `\n\n${out.md}\n\n` : out.md)
	}

	// Older browsing citations: metadata.citations[].start_ix points at the \u3010...\u3011 marker
	const old = metadata && Array.isArray(metadata.citations) ? metadata.citations : []
	BRACKET.lastIndex = 0
	while ((m = BRACKET.exec(text))) {
		if (!/\u2020/.test(m[0])) continue // ordinary bracketed text
		const c = old.find((x) => x.start_ix === m.index)
		const md = c && c.metadata && c.metadata.url ? link(c.metadata) : null
		add(m.index, m.index + m[0].length, md ? `(${md})` : `[${t('citation_unresolved')}: ${m[0]}]`)
	}

	// Whatever delimiter is left is invisible junk
	DELIMITERS.lastIndex = 0
	while ((m = DELIMITERS.exec(text))) add(m.index, m.index + 1, '')

	let out = text
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		out = out.slice(0, edit.start) + edit.md + out.slice(edit.end)
	}
	return out
}
