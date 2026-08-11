// A small, dependency-free Markdown -> HTML renderer for the Constitution
// page. Deliberately covers only what a rules document actually needs:
// headers, bold/italic, bullet/numbered lists, horizontal rules, and
// paragraphs. Not a general-purpose Markdown implementation.
//
// Header levels are offset by two (# -> <h3>, ## -> <h4>, ### -> <h4>) so
// they nest visually under the card's own <h2> title rather than competing
// with it.

function renderMarkdown(md) {
  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, "$1<em>$2</em>");
    out = out.replace(/(^|[^_])_([^_]+?)_(?!_)/g, "$1<em>$2</em>");
    return out;
  }

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headerMatch) {
      const level = Math.min(headerMatch[1].length + 2, 4);
      html.push(`<h${level}>${inline(headerMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (/^-{3,}$/.test(line.trim())) {
      html.push("<hr>");
      i++;
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^-{3,}$/.test(lines[i].trim())
    ) {
      paraLines.push(inline(lines[i]));
      i++;
    }
    html.push(`<p>${paraLines.join("<br>")}</p>`);
  }

  return html.join("\n");
}
