import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mockFetch, loadPagedFixture, splitPages, pagedRoutes, CONV_ID } from './helpers.mjs'

installDom(`https://chatgpt.com/c/${CONV_ID}`)
const { convertMarkers } = await import('../src/Markers.js')
const ChatGPTParser = (await import('../src/Parsers/ChatGPTParser.js')).default
const { renderMarkdown } = await import('../src/MarkdownRenderer.js')

// Private-use delimiters ChatGPT wraps around citation markers
const OPEN = String.fromCharCode(0xe200)
const SEP = String.fromCharCode(0xe202)
const CLOSE = String.fromCharCode(0xe201)
const genui = (payload) => `${OPEN}genui${SEP}${JSON.stringify(payload)}${CLOSE}`
const ref = (matched, items, extra) => ({ matched_text: matched, start_idx: 0, type: 'grouped_webpages', items, ...extra })
const item = (url, attribution, extra) => ({ title: `Title of ${attribution}`, url, attribution, supporting_websites: null, ...extra })

test('synthetic fixture: single and multiple sources, supporting websites, utm_source removed', () => {
	const d = loadPagedFixture()
	const one = d.messages[5]
	const out1 = convertMarkers(one.content.parts[0], one.metadata)
	assert.match(out1, /§4\.2\. \(\[docs\.example\.com\]\(https:\/\/docs\.example\.com\/gaskets\/g1-datasheet\.html\)\)/)
	assert.match(out1, /\(\[docs\.example\.com\]\(https:\/\/docs\.example\.com\/gaskets\/g3-overview\.html\)\)/)
	assert.doesNotMatch(out1, /genui|utm_source|unresolved/)

	const two = d.messages[11]
	const out2 = convertMarkers(two.content.parts[0], two.metadata)
	assert.match(out2, /\(\[Acme Wiki\]\(https:\/\/wiki\.example\.org\/acme-x-series\/getting-started\/\), \[Acme Shop\]\(https:\/\/shop\.example\.net\/gasket-kit-p-5475\.html\)\)/)
	assert.doesNotMatch(out2, /genui|utm_source|unresolved/)
	// no invisible private-use characters survive
	assert.doesNotMatch(out1 + out2, /[-]/)
})

test('bare genui text (delimiters lost) converts too', () => {
	const marker = 'genui{"citation":{"ref":"t1"}}'
	const out = convertMarkers(`Claim. ${marker}`, { content_references: [ref(marker, [item('https://a.example/x', 'a.example')])] })
	assert.equal(out, 'Claim. ([a.example](https://a.example/x))')
})

test('unresolved references stay visible; no URL is invented', () => {
	const m1 = genui({ citation: { refs: ['turn9view1', 'turn9view2'] } })
	const m2 = genui({ citation: { ref: 'turn3view0' } })
	const m3 = genui({ citation: { ref: 'turn4view0' } })
	const text = `A ${m1} B ${m2} C ${m3}`
	const out = convertMarkers(text, {
		content_references: [
			ref(m1, [], { status: 'error' }), // reference without any source
			ref(m3, [item('javascript:alert(1)', 'evil')]), // unusable URL
		],
	})
	assert.equal(out, 'A [Citation unresolved: turn9view1, turn9view2] B [Citation unresolved: turn3view0] C [Citation unresolved: turn4view0]')
	assert.doesNotMatch(out, /http|javascript/)
})

test('a marker without any content_references is marked, not dropped', () => {
	const out = convertMarkers(`x ${genui({ citation: { ref: 'r1' } })}`, undefined)
	assert.equal(out, 'x [Citation unresolved: r1]')
})

test('code examples and inline code keep literal markers', () => {
	const m = genui({ citation: { ref: 'r1' } })
	const text = ['Doc ' + m, '', '```js', `const s = '${m}'`, '```', '', `Inline \`${m}\` stays.`].join('\n')
	const out = convertMarkers(text, { content_references: [ref(m, [item('https://a.example/', 'a')])] })
	const lines = out.split('\n')
	assert.equal(lines[0], 'Doc ([a](https://a.example/))')
	assert.equal(lines[3], `const s = '${m}'`)
	assert.equal(lines[6], `Inline \`${m}\` stays.`)
})

test('repeated identical markers map to their own references in order', () => {
	const m = genui({ citation: { ref: 'r1' } })
	const text = `one ${m} two ${m}`
	const refs = [
		{ ...ref(m, [item('https://first.example/', 'first')]), start_idx: text.indexOf(m) },
		{ ...ref(m, [item('https://second.example/', 'second')]), start_idx: text.lastIndexOf(m) },
	]
	assert.equal(convertMarkers(text, { content_references: refs }), 'one ([first](https://first.example/)) two ([second](https://second.example/))')
})

test('start_idx counted in code points still finds the right marker', () => {
	const m = genui({ citation: { ref: 'r1' } })
	const text = `😀😀 first ${m} then ${m}`
	const cpIndex = (n) => Array.from(text.slice(0, n)).length
	const refs = [
		{ ...ref(m, [item('https://one.example/', 'one')]), start_idx: cpIndex(text.indexOf(m)) },
		{ ...ref(m, [item('https://two.example/', 'two')]), start_idx: cpIndex(text.lastIndexOf(m)) },
	]
	assert.equal(convertMarkers(text, { content_references: refs }), '😀😀 first ([one](https://one.example/)) then ([two](https://two.example/))')
})

test('URLs with parentheses and brackets in labels produce valid Markdown links', () => {
	const m = genui({ citation: { ref: 'r1' } })
	const out = convertMarkers(m, { content_references: [ref(m, [item('https://en.example/wiki/Foo_(bar)', 'A [b] c')])] })
	assert.equal(out, '([A b c](https://en.example/wiki/Foo_%28bar%29))')
})

test('older formats: cite markers, entities and numbered source brackets', () => {
	const cite = `${OPEN}cite${SEP}turn0search0${SEP}turn0search1${CLOSE}`
	const entity = `${OPEN}entity${SEP}["city","Paris","capital of France"]${CLOSE}`
	const text = `Fact ${cite}. Visit ${entity}. Old 【 3†source】 and plain 【note】.`.replace(/【 3/, '【3')
	const out = convertMarkers(text, {
		content_references: [{ matched_text: cite, start_idx: 5, type: 'grouped_webpages', items: [item('https://s1.example/', 's1'), item('https://s2.example/', 's2')] }],
		citations: [],
	})
	assert.match(out, /^Fact \(\[s1\]\(https:\/\/s1\.example\/\), \[s2\]\(https:\/\/s2\.example\/\)\)\. Visit Paris\. /)
	assert.match(out, /\[Citation unresolved: 【3†source】\]/)
	assert.match(out, /plain 【note】\./)

	const old = 'See 【1†source】.'
	const resolved = convertMarkers(old, { citations: [{ start_ix: 4, end_ix: 15, metadata: { title: 'T', url: 'https://old.example/p' } }] })
	assert.equal(resolved, 'See ([T](https://old.example/p)).')
})

test('parser: assistant citations convert, user text with the same marker stays literal', async () => {
	const full = loadPagedFixture()
	const literal = 'genui{"citation":{"ref":"user-typed"}}'
	full.messages[0].content.parts = [`Explain this literal: ${literal}`]
	mockFetch(pagedRoutes(splitPages(full, [12])))
	const r = await ChatGPTParser.parseRemote({})
	assert.match(r.items[0].markdown, new RegExp(literal.replace(/[{}]/g, '\\$&')))
	assert.match(r.items[1].markdown, /\(\[docs\.example\.com\]\(https:\/\/docs/)
	assert.doesNotMatch(r.items[1].markdown, /genui/)
})

test('HTML export renders converted citations as links', () => {
	const m = genui({ citation: { ref: 'r1' } })
	const md = convertMarkers(`Claim ${m}`, { content_references: [ref(m, [item('https://a.example/?q=1&r=2', 'a.example')])] })
	assert.match(renderMarkdown(md), /<a href="https:\/\/a\.example\/\?q=1&amp;r=2">a\.example<\/a>/)
})

// ---- other markers: url, product(s), image_group, widgets, navlist, video, fallbacks ----
const mk = (name, ...args) => `${OPEN}${name}${SEP}${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(SEP)}${CLOSE}`
const withRef = (marker, extra) => ({ matched_text: marker, start_idx: 0, prefix: null, ...extra })
const convert = (text, refs, extra) => convertMarkers(text, { content_references: refs, ...extra })
const product = (title, extra) => ({ title, url: '', price: '€10.00', rating: 4.5, num_reviews: 12, merchants: 'Shop A + others', image_urls: ['https://images.openai.com/x'], ...extra })

test('url marker becomes a link: reference item, plain URL argument, or text only', () => {
	const m = mk('url', 'the source file', 'https://example.com/src/main.c')
	const ref = withRef(m, { type: 'url', alt: '[the source file](https://example.com/src/main.c?utm_source=chatgpt.com)', item: { title: 'the source file', url: 'https://example.com/src/main.c?utm_source=chatgpt.com' } })
	assert.equal(convert(`See ${m}.`, [ref]), 'See [the source file](https://example.com/src/main.c).')
	assert.equal(convert(`See ${m}.`), 'See [the source file](https://example.com/src/main.c).')
	// the second argument is a reference id: the reference supplies the URL
	const byId = mk('url', 'docs', 'turn2view0')
	assert.equal(convert(byId, [withRef(byId, { type: 'url', item: { url: 'https://example.com/d?utm_source=chatgpt.com' } })]), '[docs](https://example.com/d)')
	// nothing usable: the anchor text survives, never a made-up or unsafe URL
	assert.equal(convert(byId), 'docs')
	assert.equal(convert(mk('url', 'x [y]', 'javascript:alert(1)')), 'x y')
})

test('product marker renders name, price, rating and merchants; links only with a real URL', () => {
	const m = mk('product', ['turn1product3', 'Widget Pro', { render_as: 'hero' }])
	const line = convert(`Intro\n\n${m}\n\nMore`, [withRef(m, { type: 'product', alt: '### [Widget Pro]()\n*€10.00*', product: product('Widget Pro') })])
	assert.equal(line, 'Intro\n\n**Widget Pro** – €10.00, 4.5★ (12 reviews), Shop A + others\n\nMore')
	const linked = convert(m, [withRef(m, { type: 'product', product: product('Widget Pro', { url: 'https://shop.example.com/p/1?utm_source=chatgpt.com', rating: null, price: null, merchants: null }) })])
	assert.equal(linked, '**[Widget Pro](https://shop.example.com/p/1)**')
	// no reference at all: the title from the arguments
	assert.equal(convert(m), '**Widget Pro**')
	// the reference's image URLs are signed and short-lived and are not exported
	assert.doesNotMatch(line, /images\.openai/)
})

test('products marker renders a list from the reference, or from the selections', () => {
	const m = mk('products', { selections: [['turn9product0', 'Alpha One'], ['turn9product3', 'Beta Two'], ['turn9product5', 'Gamma Three']] })
	const ref = withRef(m, {
		type: 'products',
		// the product ids in the reference differ from the ids in the marker: the order matches
		products: [product('Alpha One', { cite: 'turn1product0' }), product('Beta Two', { cite: 'turn1product1', rating: null, num_reviews: null }), product('Gamma Three', { price: null, merchants: null, rating: 3.9, num_reviews: null })],
	})
	assert.equal(convert(`Top picks:\n${m}\nEnd`, [ref]), 'Top picks:\n- **Alpha One** – €10.00, 4.5★ (12 reviews), Shop A + others\n- **Beta Two** – €10.00, Shop A + others\n- **Gamma Three** – 3.9★\nEnd')
	assert.equal(convert(m), '- **Alpha One**\n- **Beta Two**\n- **Gamma Three**')
})

test('a block marker in the middle of a line is moved onto lines of its own', () => {
	const m = mk('product', ['id', 'Mid Line', {}])
	assert.equal(convert(`Before ${m} after`), 'Before \n\n**Mid Line**\n\n after')
})

test('image_group lists the source pages of the images, never the signed image URLs', () => {
	const m = mk('image_group', { layout: 'carousel', aspect_ratio: '1:1', image_refs: ['turn1image0', 'turn1image1'] })
	const image = (title, url) => ({ image_result: { title, url, content_url: 'https://images.openai.com/signed?purpose=fullsize', thumbnail_url: 'https://tse1.example.net/t.jpg' } })
	const ref = withRef(m, { type: 'image_group', alt: '![Image](https://images.openai.com/signed?purpose=fullsize)', images: [image('A forum thread', 'https://forum.example.org/t/1?page=2'), image('The shop page', 'https://shop.example.com/p/2'), { image_result: null }] })
	assert.equal(convert(m, [ref]), '*Images:* [A forum thread](https://forum.example.org/t/1?page=2), [The shop page](https://shop.example.com/p/2)')
	assert.equal(convert(m), '*[Images]*')
})

test('genui widgets: math becomes a display equation, others a readable summary', () => {
	const math = mk('genui', { math_block_widget_always_prefetch_v2: { content: 'a^2 + b^2 = c^2' } })
	assert.equal(convert(`Pythagoras:\n${math}\n`), 'Pythagoras:\n$$\na^2 + b^2 = c^2\n$$\n')
	assert.equal(convert(mk('genui', { weather_forecast: { location: 'Berlin', days: 3, units: null } })), '[weather_forecast: Berlin, 3]')
})

test('navlist and video use their reference links when there are any', () => {
	const nav = mk('navlist', 'Latest news', 'turn0news1,turn0news2')
	const ref = withRef(nav, { type: 'navlist', items: [{ title: 'One', url: 'https://news.example.com/1?utm_source=chatgpt.com', attribution: 'News A' }, { title: 'Two', url: 'https://news.example.org/2', attribution: 'News B' }] })
	assert.equal(convert(nav, [ref]), '**Latest news**: [News A](https://news.example.com/1), [News B](https://news.example.org/2)')
	assert.equal(convert(nav), '**Latest news**')
	assert.equal(convert(mk('video', 'A talk', 'turn0youtube1')), '*Video:* A talk')
})

test('unknown markers use the reference alt text, cleaned, or a generic rendering', () => {
	const m = mk('shiny_new_widget', ['turn1x0', { mode: 'wide' }], 'Label')
	const alt = '### [Gadget]()\n*€5.00*\n\n![Image](https://images.openai.com/signed?purpose=fullsize)\n\n[Page](https://example.com/p?utm_source=chatgpt.com)'
	assert.equal(convert(m, [withRef(m, { type: 'shiny_new_widget', alt })]), '**Gadget**\n*€5.00*\n\n[Page](https://example.com/p)')
	assert.equal(convert(m, [withRef(m, { alt: '' })]), '[shiny_new_widget: turn1x0, wide, Label]')
	assert.equal(convert(m), '[shiny_new_widget: turn1x0, wide, Label]')
})

test('stray private-use delimiters are removed; code keeps them literal', () => {
	const stray = `Text${OPEN}broken and ${CLOSE}${SEP}done`
	assert.equal(convert(stray), 'Textbroken and done')
	const code = '```\n' + mk('product', ['id', 'In Code', {}]) + '\n```'
	assert.equal(convert(code), code)
})

test('parser: products, images and urls are readable in the export, with no invisible delimiters left', async () => {
	const full = loadPagedFixture()
	const prod = mk('products', { selections: [['x1', 'Alpha One'], ['x2', 'Beta Two']] })
	const img = mk('image_group', { layout: 'bento', image_refs: ['i0'] })
	const link = mk('url', 'the manual', 'https://docs.example.com/manual.pdf')
	const text = `Options:\n\n${prod}\n\nPictures:\n\n${img}\n\nRead ${link} first.`
	full.messages[5].content.parts = [text]
	full.messages[5].metadata.content_references = [
		withRef(prod, { type: 'products', products: [product('Alpha One'), product('Beta Two', { price: '€20.00' })] }),
		withRef(img, { type: 'image_group', images: [{ image_result: { title: 'Photos', url: 'https://example.com/photos' } }] }),
	]
	mockFetch(pagedRoutes(splitPages(full, [12])))
	const md = (await ChatGPTParser.parseRemote({})).items[1].markdown
	assert.match(md, /\n- \*\*Alpha One\*\* – €10\.00, 4\.5★ \(12 reviews\), Shop A \+ others\n- \*\*Beta Two\*\* – €20\.00/)
	assert.match(md, /\*Images:\* \[Photos\]\(https:\/\/example\.com\/photos\)/)
	assert.match(md, /Read \[the manual\]\(https:\/\/docs\.example\.com\/manual\.pdf\) first\./)
	assert.doesNotMatch(md, /[-]/)
	const html = renderMarkdown(md)
	assert.match(html, /<ul><li><strong>Alpha One<\/strong> – €10\.00/)
})
