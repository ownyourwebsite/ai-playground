import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "./Markdown";

function render(text: string) {
  return renderToStaticMarkup(<Markdown text={text} />);
}

// Ignore presentation when checking the semantic structure, but retain URLs,
// accessibility attributes, list numbering and checkbox state.
function semanticHtml(text: string) {
  return render(text).replace(/ (?:class|style)="[^"]*"/g, "");
}

function assertSafeOutput(html: string) {
  assert.doesNotMatch(
    html,
    /<(?:img|picture|source|script|iframe|object|embed|style|link|meta|base|form|svg|math)\b/i,
  );
  assert.doesNotMatch(html, /<[a-z][^>]*\s(?:src|srcset|on\w+)\s*=/i);
  for (const [anchor] of html.matchAll(/<a\b[^>]*>/g)) {
    assert.match(anchor, /href="https?:\/\//i);
    assert.match(anchor, /target="_blank"/);
    assert.match(anchor, /rel="noopener noreferrer"/);
  }
}

test("the user's Hugging Face Course example remains a safe, styled new-tab link", () => {
  const html = render(
    "[Hugging Face Course](https://huggingface.co/learn) **bold** *italic* `code`",
  );
  assert.match(html, /<a\b[^>]*href="https:\/\/huggingface.co\/learn"[^>]*>Hugging Face Course<\/a>/);
  assert.match(html, /class="[^"]*text-blue-600[^"]*underline[^"]*focus-visible:/);
  assert.match(html, /<strong\b[^>]*>bold<\/strong>/);
  assert.match(html, /<em\b[^>]*>italic<\/em>/);
  assert.match(html, /<code\b[^>]*>code<\/code>/);
  assertSafeOutput(html);
});

test("CommonMark headings, paragraphs, hard breaks and thematic breaks are semantic blocks", () => {
  const html = semanticHtml([
    "# Первый", "", "## Второй", "", "### Третий", "", "#### Четвёртый", "",
    "##### Пятый", "", "###### Шестой", "", "Setext", "======", "",
    "Первый абзац.", "Продолжение.  ", "Новая строка.", "", "---", "", "Второй абзац.",
  ].join("\n"));
  for (const [index, heading] of ["Первый", "Второй", "Третий", "Четвёртый", "Пятый", "Шестой"].entries()) {
    assert.ok(html.includes(`<h${index + 1}>${heading}</h${index + 1}>`));
  }
  assert.match(html, /<h1>Setext<\/h1>/);
  assert.match(html, /<p>Первый абзац\.\nПродолжение\.<br\/>\nНовая строка\.<\/p>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<p>Второй абзац\.<\/p>/);
});

test("inline formatting follows CommonMark nesting, escaping and GFM strikethrough", () => {
  const html = semanticHtml(
    "**bold and *italic*** __strong__ _emphasis_ ~~obsolete~~ \\*literal\\* `` `code` **not bold** ``",
  );
  assert.match(html, /<strong>bold and <em>italic<\/em><\/strong>/);
  assert.match(html, /<strong>strong<\/strong> <em>emphasis<\/em> <del>obsolete<\/del>/);
  assert.match(html, /\*literal\*/);
  assert.match(html, /<code>`code` \*\*not bold\*\*<\/code>/);
});

test("nested ordered and unordered lists preserve numbering and mixed nesting", () => {
  const html = semanticHtml([
    "3. Первый пункт",
    "   - Вложенный **пункт**",
    "     1. Глубокий пункт",
    "   - Ещё пункт",
    "4. Второй пункт",
  ].join("\n"));
  assert.match(html, /<ol start="3">\s*<li>Первый пункт\s*<ul>\s*<li>Вложенный <strong>пункт<\/strong>\s*<ol>\s*<li>Глубокий пункт<\/li>\s*<\/ol>\s*<\/li>/);
  assert.match(html, /<li>Ещё пункт<\/li>\s*<\/ul>\s*<\/li>\s*<li>Второй пункт<\/li>/);
});

test("loose list items can contain paragraphs, fenced code and block quotes", () => {
  const html = semanticHtml([
    "1. Установите зависимости.", "",
    "   ```sh",
    "   npm install",
    "   printf '**literal**'",
    "   ```", "",
    "   > Проверка **готова**.", "",
    "2. Завершите.",
  ].join("\n"));
  assert.match(html, /<ol>\s*<li>\s*<p>Установите зависимости\.<\/p>\s*<pre\b[^>]*><code>npm install\nprintf &#x27;\*\*literal\*\*&#x27;\n<\/code><\/pre>\s*<blockquote>\s*<p>Проверка <strong>готова<\/strong>\.<\/p>/);
  assert.match(html, /<li>\s*<p>Завершите\.<\/p>\s*<\/li>/);
  assert.doesNotMatch(html, /<strong>literal<\/strong>/);
});

test("block quotes support nested quotes and lists", () => {
  const html = semanticHtml(
    "> Совет:\n>\n> - **Первый** шаг\n> - Второй шаг\n>\n> > Вложенная цитата",
  );
  assert.match(html, /<blockquote>\s*<p>Совет:<\/p>\s*<ul>\s*<li>\s*<p><strong>Первый<\/strong> шаг<\/p>\s*<\/li>/);
  assert.match(html, /<blockquote>\s*<p>Вложенная цитата<\/p>\s*<\/blockquote>\s*<\/blockquote>/);
});

test("GFM tables have headers, alignment and inline formatting", () => {
  const text = [
    "| Курс | Статус |", "| :--- | ---: |",
    "| [Hugging Face Course](https://huggingface.co/learn) | **Готово** |",
    "| `Markdown` | ~~Старый~~ |",
  ].join("\n");
  const html = render(text);
  assert.match(html, /<table\b/);
  assert.match(html, /<thead>\s*<tr>\s*<th\b[^>]*>Курс<\/th>\s*<th\b[^>]*>Статус<\/th>/);
  assert.match(html, /<th\b[^>]*style="text-align:right"/);
  assert.match(html, /<tbody>[\s\S]*<strong\b[^>]*>Готово<\/strong>/);
  assert.match(html, /<code\b[^>]*>Markdown<\/code>/);
  assert.match(html, /<del\b[^>]*>Старый<\/del>/);
  assertSafeOutput(html);
});

test("GFM task lists render disabled, named checkboxes with the correct state", () => {
  const html = render("- [x] Прочитано\n- [ ] Сделать\n  - [X] Вложенная задача");
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(([input]) => input);
  assert.equal(inputs.length, 3);
  for (const input of inputs) {
    assert.match(input, /type="checkbox"/);
    assert.match(input, /disabled=""/);
    assert.match(input, /aria-label="[^"]+"/);
  }
  assert.match(inputs[0], /checked=""/);
  assert.doesNotMatch(inputs[1], /checked=/);
  assert.match(inputs[2], /checked=""/);
});

test("HTTP(S) autolinks, bare URLs, reference links and formatted link labels work", () => {
  const html = render([
    "https://huggingface.co/learn and http://example.com/docs.", "",
    "<https://example.com/angle> [**Reference**][course]", "",
    '[course]: https://huggingface.co/learn "Course title"',
  ].join("\n"));
  assert.equal([...html.matchAll(/<a\b/g)].length, 4);
  assert.match(html, /href="http:\/\/example.com\/docs"/);
  assert.match(html, /href="https:\/\/example.com\/angle"/);
  assert.match(html, /title="Course title"[^>]*><strong\b[^>]*>Reference<\/strong><\/a>/);
  assertSafeOutput(html);
});

test("standard links retain balanced parentheses, query strings and titles", () => {
  const html = render('[Документация](https://example.com/a_(b)?x=1&y=2 "Справка")');
  assert.match(html, /href="https:\/\/example.com\/a_\(b\)\?x=1&amp;y=2"/);
  assert.match(html, /title="Справка"/);
  assertSafeOutput(html);
});

const disallowedUrls = [
  "javascript:alert%281%29",
  "JaVaScRiPt:alert%281%29",
  "jav&#x61;script:alert%281%29",
  "java&#x09;script:alert%281%29",
  "data:text/html;base64,PHNjcmlwdD4=",
  "vbscript:msgbox%281%29",
  "file:///etc/passwd",
  "ftp://example.com/file",
  "mailto:user@example.com",
  "tel:+123456789",
  "//example.com/tracker",
  "/relative/path",
  "relative/path",
  "#fragment",
  "https://",
  "%6aavascript:alert%281%29",
];

for (const url of disallowedUrls) {
  test(`disallowed URL stays non-interactive: ${url}`, () => {
    const html = render(`[**нельзя**](${url})`);
    assert.doesNotMatch(html, /<a\b|\shref=/i);
    assert.match(html, /нельзя/);
    assertSafeOutput(html);
  });
}

test("GFM email autolinks cannot bypass the HTTP(S)-only policy", () => {
  const html = render("user@example.com <user@example.com>");
  assert.doesNotMatch(html, /<a\b|href=/);
  assert.match(html, /user@example\.com/);
});

test("raw HTML and XSS payloads cannot create executable or resource-loading elements", () => {
  const payloads = [
    '<script>alert("xss")</script>',
    '<img src="https://tracker.invalid/pixel" onerror="alert(1)">',
    '<a href="javascript:alert(1)" onclick="alert(1)">bad</a>',
    '<iframe src="https://tracker.invalid/frame"></iframe>',
    '<svg><a xlink:href="javascript:alert(1)">bad</a></svg>',
    '<style>body { background: url(https://tracker.invalid/style); }</style>',
    '<link rel="stylesheet" href="https://tracker.invalid/style">',
    '<base href="https://tracker.invalid/"><meta http-equiv="refresh" content="0;url=https://tracker.invalid/">',
    '<form action="https://tracker.invalid/"><input autofocus onfocus="alert(1)"></form>',
  ];
  for (const payload of payloads) {
    const html = render(payload);
    assertSafeOutput(html);
    assert.doesNotMatch(html, /<a\b|<input\b/);
  }
  const escaped = render('&lt;img src=x onerror=alert(1)&gt; **safe**');
  assert.match(escaped, /&lt;img/);
  assert.match(escaped, /<strong\b[^>]*>safe<\/strong>/);
  // Escaped, visible text is not an HTML attribute or a resource request.
  assert.doesNotMatch(escaped, /<img\b/);
});

test("Markdown images become alt text, never tracking requests or React image preloads", () => {
  const html = render([
    '![Описание изображения](https://tracker.invalid/pixel.gif "Tracking")', "",
    "![Reference image][pixel]", "",
    "![](https://tracker.invalid/empty)", "",
    "![Unsafe image](data:image/svg+xml;base64,PHN2Zz4=)", "",
    "[pixel]: https://tracker.invalid/reference",
  ].join("\n"));
  assert.match(html, /Описание изображения/);
  assert.match(html, /Reference image/);
  assert.match(html, /Unsafe image/);
  assert.doesNotMatch(html, /tracker\.invalid|data:image|\bpreload\b/);
  assertSafeOutput(html);
});

test("a linked image keeps only its safe navigation link and text", () => {
  const html = render("[![Course badge](https://tracker.invalid/badge)](https://huggingface.co/learn)");
  assert.equal([...html.matchAll(/<a\b/g)].length, 1);
  assert.match(html, /href="https:\/\/huggingface.co\/learn"/);
  assert.match(html, /Course badge/);
  assert.doesNotMatch(html, /tracker\.invalid/);
  assertSafeOutput(html);
});

test("nonstandard and unfinished links are not heuristically repaired", () => {
  for (const text of [
    "[Hugging Face Course] - (https://huggingface.co/learn)",
    "[Hugging Face Course] https://huggingface.co/learn",
    "[Hugging Face Course](https://huggingface.co/learn",
    "[Hugging Face Course](https://huggingface.co/learn extra words)",
  ]) {
    const html = render(text);
    assert.match(html, /\[Hugging Face Course\]/);
    assert.doesNotMatch(html, /<a\b[^>]*>Hugging Face Course<\/a>/);
    assertSafeOutput(html);
  }
});

test("fenced and indented code stay literal, including HTML, links and indentation", () => {
  const html = semanticHtml([
    "```html", '<img src="https://tracker.invalid/pixel">',
    "  **literal** [link](https://example.com)", "```", "",
    "    indented code", "      nested indentation", "",
    "~~~js", "const value = 1;", "~~~",
  ].join("\n"));
  assert.equal([...html.matchAll(/<pre\b/g)].length, 3);
  assert.match(html, /&lt;img src=&quot;https:\/\/tracker\.invalid\/pixel&quot;&gt;/);
  assert.match(html, /\n  \*\*literal\*\* \[link\]\(https:\/\/example\.com\)\n/);
  assert.match(html, /<code>indented code\n  nested indentation\n<\/code>/);
  assert.doesNotMatch(html, /<img\b|<a\b|<strong\b/);
});

test("the component resets inherited whitespace and styles scrollable code and tables without typography", () => {
  const html = renderToStaticMarkup(
    <div className="whitespace-pre-wrap">
      <Markdown text={"# Заголовок\n\n```text\n  code\n```\n\n| A |\n| - |\n| B |"} />
    </div>,
  );
  assert.match(html, /^<div class="whitespace-pre-wrap"><div class="[^"]*\bwhitespace-normal\b/);
  assert.doesNotMatch(html, /class="[^"]*\bprose\b/);
  const pre = html.match(/<pre\b[^>]*>/)?.[0] ?? "";
  assert.match(pre, /\bwhitespace-pre\b/);
  assert.match(pre, /\boverflow-x-auto\b/);
  assert.match(pre, /tabindex="0"/);
  assert.match(pre, /aria-label="[^"]+"/);
  assert.match(html, /<div\b[^>]*class="[^"]*overflow-x-auto[^"]*"[^>]*tabindex="0"[^>]*>\s*<table\b/);
});

test("every prefix of representative streams renders without throwing or enabling unsafe markup", () => {
  const streams = [
    "# Материалы\n\n1. [Hugging Face Course](https://huggingface.co/learn)\n   - **Вложенный _текст_**\n\n> Цитата\n",
    "- [x] Готово\n- [ ] Ещё\n\n| Курс | Статус |\n| :--- | ---: |\n| ~~Старый~~ | `код` |\n",
    "```html\n<img src=x onerror=alert(1)>\n  **code**\n```\n\n~~~sh\nprintf 'hello'\n~~~",
    "`inline` **strong** _emphasis_ [ref][course]\n\n[course]: https://huggingface.co/learn\n",
    "![tracking](https://tracker.invalid/pixel) [bad](javascript:alert%281%29) <script>alert(1)</script>",
    '[bad](jav&#x61;script:alert%281%29) <img src="https://tracker.invalid/pixel" onerror="alert(1)">',
  ];
  for (const stream of streams) {
    for (let end = 0; end <= stream.length; end++) {
      assert.doesNotThrow(() => {
        assertSafeOutput(render(stream.slice(0, end)));
      }, `Unsafe or broken stream prefix ending at ${end}: ${JSON.stringify(stream.slice(0, end))}`);
    }
  }
});
