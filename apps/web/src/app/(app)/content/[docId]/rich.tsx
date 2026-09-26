"use client";

/**
 * A small rich-text editor on contentEditable: headings, paragraphs, lists,
 * quotes, bold/italic, links and images with alt text — the markup the
 * server's sanitiser keeps. Pasted HTML is cleaned here first (tags outside
 * that set unwrapped, every attribute but href/src/alt dropped), because the
 * editor lives in the panel's own origin.
 *
 * It is uncontrolled: the DOM holds the text, and the parent reads it through
 * onChange (innerHTML) and writes through the imperative handle.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "../../../../components/icons";
import type { ContentStrings } from "../strings";
import type { CommonStrings } from "../../../../lib/common-strings";

export type RichHandle = {
  insertLink: (url: string, text: string) => void;
  html: () => string;
  setAlt: (index: number, alt: string) => void;
  focus: () => void;
};

const BLOCKS = new Set(["P", "H2", "H3", "H4", "UL", "OL", "LI", "BLOCKQUOTE", "BR"]);
const INLINE = new Set(["A", "STRONG", "B", "EM", "I", "IMG", "CODE"]);

/** Keep structure and meaning, drop everything that could run or restyle. */
export function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      walk(child);
      const tag = child.tagName;
      if (tag === "H1") {
        const h2 = doc.createElement("h2");
        h2.append(...Array.from(child.childNodes));
        child.replaceWith(h2);
        continue;
      }
      if (tag === "DIV" || tag === "SECTION" || tag === "ARTICLE") {
        const p = doc.createElement("p");
        p.append(...Array.from(child.childNodes));
        child.replaceWith(p);
        continue;
      }
      if (!BLOCKS.has(tag) && !INLINE.has(tag)) {
        if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "FORM", "INPUT", "BUTTON"].includes(tag)) child.remove();
        else child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const keep = (tag === "A" && attr.name === "href") || (tag === "IMG" && (attr.name === "src" || attr.name === "alt"));
        if (!keep || /^\s*(javascript|data|vbscript):/i.test(attr.value)) child.removeAttribute(attr.name);
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/**
 * Images are shown as placeholders (src parked in data-src): the panel's
 * content policy does not load other sites' images, and the editor should not
 * fetch them either. The text read back always carries the real src.
 */
function toEditor(html: string): string {
  return html.replace(/<img\b([^>]*?)\ssrc=/gi, "<img$1 data-src=");
}
function fromEditor(html: string): string {
  return html.replace(/<img\b([^>]*?)\sdata-src=/gi, "<img$1 src=");
}

type Tool = { key: keyof ContentStrings; icon: string; run: () => void; label?: string };

export const RichText = forwardRef<RichHandle, { initial: string; dir: "rtl" | "ltr"; onChange: (html: string) => void; s: ContentStrings; c: CommonStrings; disabled?: boolean }>(
  function RichText({ initial, dir, onChange, s, c, disabled }, ref) {
    const el = useRef<HTMLDivElement>(null);
    const saved = useRef<Range | null>(null);
    const [form, setForm] = useState<"link" | "image" | null>(null);
    const [url, setUrl] = useState("");
    const [alt, setAlt] = useState("");

    useEffect(() => {
      if (el.current) el.current.innerHTML = toEditor(initial);
      // The initial body is set once; later changes live in the DOM.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const emit = () => el.current && onChange(fromEditor(el.current.innerHTML));

    function remember() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && el.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
    }
    function restore() {
      el.current?.focus();
      const sel = window.getSelection();
      if (saved.current && sel) {
        sel.removeAllRanges();
        sel.addRange(saved.current);
      } else if (el.current && sel) {
        // No caret yet: continue at the end of the text.
        const r = document.createRange();
        r.selectNodeContents(el.current);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    function exec(cmd: string, value?: string) {
      restore();
      document.execCommand(cmd, false, value);
      remember();
      emit();
    }

    useImperativeHandle(ref, () => ({
      insertLink(href: string, text: string) {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = text;
        exec("insertHTML", ` ${a.outerHTML} `);
      },
      html: () => fromEditor(el.current?.innerHTML ?? ""),
      setAlt(index: number, value: string) {
        const img = el.current?.querySelectorAll("img")[index];
        if (img) {
          img.setAttribute("alt", value);
          emit();
        }
      },
      focus: () => el.current?.focus(),
    }));

    const tools: Tool[] = [
      { key: "tb_p", icon: "doc", run: () => exec("formatBlock", "<p>") },
      { key: "tb_h2", icon: "heading", run: () => exec("formatBlock", "<h2>"), label: "H2" },
      { key: "tb_h3", icon: "heading", run: () => exec("formatBlock", "<h3>"), label: "H3" },
      { key: "tb_bold", icon: "bold", run: () => exec("bold") },
      { key: "tb_italic", icon: "italic", run: () => exec("italic") },
      { key: "tb_ul", icon: "list", run: () => exec("insertUnorderedList") },
      { key: "tb_ol", icon: "list", run: () => exec("insertOrderedList"), label: "1." },
      { key: "tb_quote", icon: "quote", run: () => exec("formatBlock", "<blockquote>") },
      { key: "tb_link", icon: "link", run: () => (remember(), setUrl(""), setForm("link")) },
      { key: "tb_unlink", icon: "x", run: () => exec("unlink") },
      { key: "tb_image", icon: "image", run: () => (remember(), setUrl(""), setAlt(""), setForm("image")) },
      { key: "tb_undo", icon: "undo", run: () => exec("undo") },
    ];

    return (
      <div className="rich">
        {!disabled && (
          <div className="rich-tools" role="toolbar" aria-label={s.tb_label}>
            {tools.map((t) => (
              <button
                key={t.key}
                type="button"
                className="btn ghost sm"
                title={s[t.key]}
                aria-label={s[t.key]}
                // Keep the text selection: a click would otherwise move focus to the button first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={t.run}
              >
                {t.label ? <b dir="ltr">{t.label}</b> : <Icon name={t.icon} />}
              </button>
            ))}
          </div>
        )}
        {form && (
          <form
            className="rich-form"
            onSubmit={(e) => {
              e.preventDefault();
              const safe = /^(https?:\/\/|\/|#|mailto:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
              if (form === "link") exec("createLink", safe);
              else {
                const img = document.createElement("img");
                img.setAttribute("data-src", safe);
                img.alt = alt.trim();
                exec("insertHTML", img.outerHTML);
              }
              setForm(null);
            }}
          >
            <label className="field">
              {form === "link" ? s.link_url : s.image_url}
              <input value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" required autoFocus />
            </label>
            {form === "image" && (
              <label className="field">
                {s.image_alt}
                <input value={alt} onChange={(e) => setAlt(e.target.value)} dir="auto" />
                <span className="hint">{s.image_alt_help}</span>
              </label>
            )}
            <div className="row">
              <button type="submit" className="btn primary sm">
                {s.insert}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setForm(null)}>
                {c.cancel}
              </button>
            </div>
          </form>
        )}
        <div
          ref={el}
          className="rich-body"
          dir={dir}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={s.body}
          data-placeholder={s.body_placeholder}
          translate="no"
          onInput={emit}
          onKeyUp={remember}
          onMouseUp={remember}
          onBlur={remember}
          onPaste={(e) => {
            e.preventDefault();
            const html = e.clipboardData.getData("text/html");
            const text = e.clipboardData.getData("text/plain");
            if (html) document.execCommand("insertHTML", false, toEditor(cleanHtml(html)));
            else document.execCommand("insertText", false, text);
            emit();
          }}
        />
      </div>
    );
  },
);
