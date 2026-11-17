const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A light touch of highlighting: comments, strings and a few keywords. Good enough to read, nothing to load. */
export function paint(src: string): string {
  return esc(src)
    .split("\n")
    .map((line) => {
      const m = line.match(/^(.*?)(\s*(?:\/\/|#) .*)$/);
      const [code, comment] = m && !/https?:$/.test(m[1]) ? [m[1], m[2]] : [line, ""];
      const body = code
        .replace(/(&quot;|"|'|`)((?:(?!\1).)*)\1/g, '<span class="s">$1$2$1</span>')
        .replace(/\b(import|from|const|await|new|export|async|function|return|for|of|if)\b(?![^<]*<\/span>)/g, '<span class="k">$1</span>');
      return body + (comment ? `<span class="c">${comment}</span>` : "");
    })
    .join("\n");
}

export function Code({ children }: { children: string }) {
  return <pre className="code" dangerouslySetInnerHTML={{ __html: paint(children.trim()) }} />;
}
