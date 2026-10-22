import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { renderMarkdown } from "../web/markdown.js";

function render(source) {
  const window = new Window();
  const container = window.document.createElement("div");
  renderMarkdown(container, source);
  return container;
}

test("markdown renders headings, paragraphs and inline formatting", () => {
  const container = render("# Title\n\nHello **bold** and *em* with `code` and ~~gone~~.");
  assert.equal(container.querySelector("h1").textContent, "Title");
  assert.equal(container.querySelector("strong").textContent, "bold");
  assert.equal(container.querySelector("em").textContent, "em");
  assert.equal(container.querySelector("code").textContent, "code");
  assert.equal(container.querySelector("del").textContent, "gone");
  assert.equal(
    container.querySelector("p").textContent,
    "Hello bold and em with code and gone.",
  );
});

test("model output is never interpreted as HTML", () => {
  const container = render(
    "<img src=x onerror=alert(1)>\n\n```html\n<script>alert(1)</script>\n```",
  );
  assert.equal(container.querySelector("img"), null);
  assert.equal(container.querySelector("script"), null);
  assert.equal(container.querySelector("p").textContent, "<img src=x onerror=alert(1)>");
  const code = container.querySelector("pre code");
  assert.equal(code.className, "language-html");
  assert.equal(code.textContent, "<script>alert(1)</script>");
});

test("links render only for http and https URLs", () => {
  const container = render(
    "See [site](https://example.com/a?b=1) and [bad](javascript:alert(1)).",
  );
  const links = container.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://example.com/a?b=1");
  assert.equal(links[0].getAttribute("target"), "_blank");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  assert.equal(links[0].textContent, "site");
  assert.match(container.textContent, /\[bad\]\(javascript:alert\(1\)\)/);
});

test("nested and ordered lists keep their structure", () => {
  const container = render(
    "- one\n  - nested\n- two\n\n3. third\n4. fourth",
  );
  const outer = container.querySelector(":scope > ul");
  assert.equal(outer.children.length, 2);
  assert.deepEqual(
    Array.from(outer.children).map((item) => item.firstChild.textContent),
    ["one", "two"],
  );
  assert.equal(outer.querySelector("li ul li").textContent, "nested");
  const ordered = container.querySelector("ol");
  assert.equal(ordered.getAttribute("start"), "3");
  assert.deepEqual(
    Array.from(ordered.querySelectorAll(":scope > li")).map((item) => item.textContent),
    ["third", "fourth"],
  );
});

test("tables render headers, alignment and body rows", () => {
  const container = render("| Name | Score |\n| :--- | ---: |\n| Ann | 10 |\n| Bo | 7 |");
  const headers = container.querySelectorAll("th");
  assert.deepEqual(Array.from(headers).map((cell) => cell.textContent), ["Name", "Score"]);
  assert.equal(headers[0].style.textAlign, "left");
  assert.equal(headers[1].style.textAlign, "right");
  assert.equal(container.querySelectorAll("tbody tr").length, 2);
  assert.deepEqual(
    Array.from(container.querySelectorAll("tbody tr")[0].querySelectorAll("td"))
      .map((cell) => cell.textContent),
    ["Ann", "10"],
  );
});

test("blockquotes, rules and fenced code are block elements", () => {
  const container = render("> quoted **text**\n\n---\n\n```js\nconst x = 1;\n```");
  assert.equal(container.querySelector("blockquote p strong").textContent, "text");
  assert.ok(container.querySelector("hr"));
  assert.equal(container.querySelector("pre code").className, "language-js");
  assert.equal(container.querySelector("pre code").textContent, "const x = 1;");
});

test("rendering replaces previous content and ignores empty input", () => {
  const container = render("# First");
  renderMarkdown(container, "second");
  assert.equal(container.querySelector("h1"), null);
  assert.equal(container.textContent, "second");
  renderMarkdown(container, "");
  assert.equal(container.childNodes.length, 0);
  renderMarkdown(container, null);
  assert.equal(container.childNodes.length, 0);
});

test("snake_case identifiers stay literal", () => {
  const container = render("use snake_case_name here");
  assert.equal(container.querySelector("em"), null);
  assert.equal(container.textContent, "use snake_case_name here");
});
