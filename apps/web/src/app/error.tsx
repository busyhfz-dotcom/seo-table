"use client";

/**
 * A screen that failed to render. Client-side, so the language comes from the
 * document the server already rendered (its lang attribute), not a cookie read.
 */
import { useEffect, useState } from "react";

const TEXT = {
  fa: {
    title: "مشکلی پیش آمد",
    body: "این صفحه باز نشد. دوباره تلاش کن؛ اگر ادامه داشت، چند دقیقه‌ی دیگر سر بزن.",
    retry: "تلاش دوباره",
  },
  en: {
    title: "Something went wrong",
    body: "This page could not be opened. Try again; if it keeps happening, check back in a few minutes.",
    retry: "Retry",
  },
};

export default function ErrorScreen({ reset }: { error: Error; reset: () => void }) {
  const [lang, setLang] = useState<"fa" | "en">("fa");
  useEffect(() => {
    setLang(document.documentElement.lang === "en" ? "en" : "fa");
  }, []);
  const text = TEXT[lang];
  return (
    <div className="view">
      <div className="note crit" role="alert">
        <div>
          <b style={{ display: "block", marginBottom: 4 }}>{text.title}</b>
          {text.body}
        </div>
      </div>
      <div>
        <button className="btn primary" onClick={reset}>
          {text.retry}
        </button>
      </div>
    </div>
  );
}
