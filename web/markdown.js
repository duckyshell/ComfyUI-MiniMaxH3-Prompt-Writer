// Minimal, dependency-free Markdown renderer for chat replies.
//
// Model output is never interpreted as HTML: the renderer only creates
// elements and text nodes. Links are restricted to http(s) URLs. The raw
// source stays owned by the chat so the copy button can copy it verbatim.

const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const LIST_MARKER = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)(?:\s+"[^"]*")?\)/i;
const CODE_SPAN = /^(`+)([\s\S]*?)\1/;

function leadingSpaces(line) {
  const match = /^\s*/.exec(line);
  return match ? match[0].length : 0;
}

function listMarker(line) {
  const match = LIST_MARKER.exec(line);
  if (!match) return null;
  return {
    indent: match[1].length,
    ordered: Boolean(match[3]),
    start: Number(match[3]) || 0,
    text: match[4],
  };
}

function isBlockStart(line, nextLine) {
  return FENCE.test(line)
    || HEADING.test(line)
    || RULE.test(line)
    || QUOTE.test(line)
    || Boolean(listMarker(line))
    || (line.includes("|") && TABLE_DIVIDER.test(nextLine || ""));
}

function appendText(parent, text, doc) {
  if (text) parent.append(doc.createTextNode(text));
}

function appendEmphasis(parent, text, index, doc, markerChar) {
  const double = text.startsWith(markerChar + markerChar, index);
  const marker = double ? markerChar + markerChar : markerChar;
  // Underscores inside identifiers (snake_case) are not emphasis.
  if (markerChar === "_") {
    const before = index > 0 ? text[index - 1] : "";
    if (before && /[A-Za-z0-9]/.test(before)) return -1;
  }
  const rest = text.slice(index + marker.length);
  const close = rest.indexOf(marker);
  if (close <= 0) return -1;
  const content = rest.slice(0, close);
  if (!content || !content.trim()) return -1;
  const after = rest[close + marker.length] || "";
  if (markerChar === "_" && after && /[A-Za-z0-9]/.test(after)) return -1;
  if (!double && after && /[A-Za-z0-9]/.test(after)) return -1;
  const element = doc.createElement(double ? "strong" : "em");
  appendInline(element, content, doc);
  parent.append(element);
  return index + marker.length + close + marker.length;
}

function appendInline(parent, text, doc) {
  let index = 0;
  let plain = "";
  const flush = () => {
    appendText(parent, plain, doc);
    plain = "";
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length && "\\`*_~[]()".includes(text[index + 1])) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      parent.append(doc.createElement("br"));
      index += 1;
      continue;
    }
    if (char === "`") {
      const match = CODE_SPAN.exec(text.slice(index));
      if (match) {
        flush();
        let content = match[2];
        if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()) {
          content = content.slice(1, -1);
        }
        const code = doc.createElement("code");
        code.textContent = content;
        parent.append(code);
        index += match[0].length;
        continue;
      }
    }
    if (char === "[") {
      const match = LINK.exec(text.slice(index));
      if (match) {
        flush();
        const link = doc.createElement("a");
        link.href = match[2];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        appendInline(link, match[1], doc);
        parent.append(link);
        index += match[0].length;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      flush();
      const next = appendEmphasis(parent, text, index, doc, char);
      if (next !== -1) {
        index = next;
        continue;
      }
    }
    if (char === "~" && text.startsWith("~~", index)) {
      const close = text.indexOf("~~", index + 2);
      const content = close === -1 ? "" : text.slice(index + 2, close);
      if (content.trim()) {
        flush();
        const element = doc.createElement("del");
        appendInline(element, content, doc);
        parent.append(element);
        index = close + 2;
        continue;
      }
    }
    plain += char;
    index += 1;
  }
  flush();
}

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function columnAlignments(divider) {
  return splitRow(divider).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function appendTable(container, lines, index, doc) {
  const header = splitRow(lines[index]);
  const alignments = columnAlignments(lines[index + 1]);
  const table = doc.createElement("table");
  const head = doc.createElement("thead");
  const headRow = doc.createElement("tr");
  header.forEach((cell, column) => {
    const th = doc.createElement("th");
    th.style.textAlign = alignments[column] || "left";
    appendInline(th, cell, doc);
    headRow.append(th);
  });
  head.append(headRow);
  table.append(head);
  const body = doc.createElement("tbody");
  index += 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
    const row = doc.createElement("tr");
    const cells = splitRow(lines[index]);
    header.forEach((_, column) => {
      const td = doc.createElement("td");
      td.style.textAlign = alignments[column] || "left";
      appendInline(td, cells[column] || "", doc);
      row.append(td);
    });
    body.append(row);
    index += 1;
  }
  table.append(body);
  container.append(table);
  return index;
}

function appendList(container, lines, index, doc) {
  const first = listMarker(lines[index]);
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const list = doc.createElement(ordered ? "ol" : "ul");
  if (ordered && first.start > 1) list.setAttribute("start", String(first.start));
  let item = doc.createElement("li");
  appendInline(item, first.text, doc);
  list.append(item);
  index += 1;
  while (index < lines.length) {
    const marker = listMarker(lines[index]);
    if (marker && marker.indent === baseIndent) {
      if (marker.ordered !== ordered) break;
      item = doc.createElement("li");
      appendInline(item, marker.text, doc);
      list.append(item);
      index += 1;
      continue;
    }
    if (marker && marker.indent < baseIndent) break;
    if (!lines[index].trim()) {
      let look = index + 1;
      while (look < lines.length && !lines[look].trim()) look += 1;
      const peek = listMarker(lines[look]);
      const continues = Boolean(lines[look]) && (
        leadingSpaces(lines[look]) > baseIndent
        || Boolean(peek && peek.indent === baseIndent && peek.ordered === ordered)
      );
      if (!continues) break;
      index = look;
      continue;
    }
    if (leadingSpaces(lines[index]) <= baseIndent || !item) break;
    const nested = [];
    while (index < lines.length) {
      const line = lines[index];
      const nestedMarker = listMarker(line);
      if (nestedMarker && nestedMarker.indent <= baseIndent) break;
      if (line.trim() && leadingSpaces(line) <= baseIndent) break;
      nested.push(line);
      index += 1;
    }
    appendBlocks(item, nested, doc);
  }
  container.append(list);
  return index;
}

function appendBlocks(container, lines, doc) {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const language = fence[2];
      const code = [];
      index += 1;
      while (index < lines.length) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[index]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = doc.createElement("pre");
      const codeEl = doc.createElement("code");
      if (language) codeEl.className = `language-${language}`;
      codeEl.textContent = code.join("\n");
      pre.append(codeEl);
      container.append(pre);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const element = doc.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2], doc);
      container.append(element);
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      container.append(doc.createElement("hr"));
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (index < lines.length) {
        const quote = QUOTE.exec(lines[index]);
        if (!quote) break;
        quoted.push(quote[1]);
        index += 1;
      }
      const blockquote = doc.createElement("blockquote");
      appendBlocks(blockquote, quoted, doc);
      container.append(blockquote);
      continue;
    }
    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] || "")) {
      index = appendTable(container, lines, index, doc);
      continue;
    }
    if (listMarker(line)) {
      index = appendList(container, lines, index, doc);
      continue;
    }
    const start = index;
    while (index < lines.length && lines[index].trim()) {
      if (index > start && isBlockStart(lines[index], lines[index + 1])) break;
      index += 1;
    }
    const paragraph = doc.createElement("p");
    appendInline(paragraph, lines.slice(start, index).join("\n"), doc);
    container.append(paragraph);
  }
}

export function renderMarkdown(container, source) {
  if (!container) return;
  const doc = container.ownerDocument;
  container.replaceChildren();
  if (typeof source !== "string" || !source) return;
  appendBlocks(container, source.replace(/\r\n?/g, "\n").split("\n"), doc);
}
