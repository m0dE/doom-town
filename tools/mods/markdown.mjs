// A small Markdown → HTML renderer for docs/MODDING.md → /modding.html (vite.config.js
// injects it at build and dev time, so the guide has one source). No dependencies.
// Supports what the guide uses: ATX headings (with GitHub-style ids), paragraphs,
// ordered/unordered lists with wrapped lines, fenced code, pipe tables, block images,
// and inline code, bold, italic, links and images.
//
//   renderMarkdown(text, { link(href) → href, image(src) → src }) → { html, toc }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces → dashes. */
export function slug(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-');
}

function inline(src, opts) {
  // code spans first, protected from the other rules
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src2) => `<img src="${esc(opts.image(src2.replace(/&amp;/g, '&')))}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const h = opts.link(href.replace(/&amp;/g, '&'));
    const ext = /^https?:/.test(h) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${esc(h)}"${ext}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:)])(?![^<]*<\/a>)(?![^<]*">)/g, (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function renderMarkdown(text, opts = {}) {
  const o = { link: (h) => h, image: (s) => s, ...opts };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const toc = [];
  let i = 0;
  const isBlank = (l) => !l || !l.trim();
  const startsBlock = (l) => /^(#{1,6} |```|\s*([-*]|\d+\.) |\|)/.test(l) || /^!\[[^\]]*\]\([^)]+\)\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    // fenced code
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre${fence[1] ? ` data-lang="${fence[1]}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    // heading
    const h = /^(#{1,6}) (.*)$/.exec(line);
    if (h) {
      const level = h[1].length, html = inline(h[2], o), id = slug(h[2].replace(/`/g, ''));
      if (level === 2) toc.push({ id, html });
      out.push(`<h${level} id="${id}">${html}${level >= 2 ? ` <a class="anchor" href="#${id}" aria-label="link to this section">#</a>` : ''}</h${level}>`);
      i++;
      continue;
    }
    // table
    if (/^\|/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c, o)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, o)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    // list (one level; wrapped lines indented under an item continue it)
    const li = /^(\s*)([-*]|\d+\.) (.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.) (.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered && m[1].length === li[1].length) { items.push(m[3]); i++; continue; }
        if (!isBlank(lines[i]) && /^\s+\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t, o)}</li>`).join('')}</${tag}>`);
      continue;
    }
    // a block image
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) {
      out.push(`<figure><img src="${esc(o.image(img[2]))}" alt="${esc(img[1])}" loading="lazy"><figcaption>${esc(img[1])}</figcaption></figure>`);
      i++;
      continue;
    }
    // paragraph
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '), o)}</p>`);
  }
  return { html: out.join('\n'), toc };
}
