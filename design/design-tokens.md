# SEO Table — Design Tokens

منبع واحد رنگ/تایپ/فاصله برای `apps/web`. هیچ رنگی نباید hard-code شود.
این فایل را در `design/` مخزن بگذار تا فاز ۲ از آن بخواند.

## ۱) CSS variables (`apps/web/src/styles/tokens.css`)

```css
:root{
  /* ground — near-black with a green bias */
  --bg:#080B09;  --bg-2:#0D120F;
  --surface:#121815; --surface-2:#18201C; --surface-3:#1E2823;
  --border:#243029; --border-strong:#314138;

  /* ink */
  --ink:#E8F1EC; --ink-2:#A3B3AA; --ink-3:#6D7E75;

  /* accent — emerald, spent sparingly: primary action, active nav, one chart series */
  --acc:#2BE08A; --acc-hi:#63F2AD; --acc-dim:#0E9A5C; --acc-ink:#062B18;
  --acc-08:rgba(43,224,138,.08); --acc-14:rgba(43,224,138,.14); --acc-24:rgba(43,224,138,.24);

  /* status — reserved; never reused as a chart series hue */
  --ok:#35D399; --warn:#F3C24B; --serious:#F79245; --crit:#F0655E; --info:#5BB8F5;

  /* radius / spacing / elevation */
  --r-sm:6px; --r:10px; --r-lg:14px;
  --shadow:0 1px 0 rgba(255,255,255,.03) inset, 0 12px 28px -18px rgba(0,0,0,.9);

  /* type */
  --f-fa:"Vazirmatn", system-ui, sans-serif;
  --f-en:"Sora", system-ui, sans-serif;
  --f-mono:"IBM Plex Mono", ui-monospace, monospace;
  color-scheme: dark;
}
```

## ۲) Tailwind mapping (`tailwind.config.ts`)

```ts
theme: { extend: {
  colors: {
    bg:{DEFAULT:'var(--bg)',2:'var(--bg-2)'},
    surface:{DEFAULT:'var(--surface)',2:'var(--surface-2)',3:'var(--surface-3)'},
    border:{DEFAULT:'var(--border)',strong:'var(--border-strong)'},
    ink:{DEFAULT:'var(--ink)',2:'var(--ink-2)',3:'var(--ink-3)'},
    acc:{DEFAULT:'var(--acc)',hi:'var(--acc-hi)',dim:'var(--acc-dim)',ink:'var(--acc-ink)'},
    ok:'var(--ok)', warn:'var(--warn)', serious:'var(--serious)', crit:'var(--crit)', info:'var(--info)',
  },
  borderRadius:{sm:'var(--r-sm)',DEFAULT:'var(--r)',lg:'var(--r-lg)'},
  fontFamily:{fa:'var(--f-fa)',en:'var(--f-en)',mono:'var(--f-mono)'},
}}
```

## ۳) مقیاس تایپوگرافی

| نقش | اندازه | وزن | کاربرد |
|---|---|---|---|
| tile value | 30px | 600 | فقط عدد اصلی کارت‌های KPI |
| gauge | 40px | 600 | امتیاز سئو |
| h3 / card title | 14px | 600 | تیتر کارت |
| body | 14px (fa) / 13.5px (en) | 400 | متن |
| table cell | 13px | 400 | جدول |
| label / eyebrow | 11.5px | 500 | uppercase, letter-spacing .05em |
| meta / mono | 12px | 400 | مسیر، ID، لاگ |

`font-variant-numeric: tabular-nums` روی هر ستون عددی و هر KPI.

## ۴) قواعد RTL/LTR

- فقط logical properties: `margin-inline`, `padding-inline`, `inset-inline-start`, `border-inline-end`. هیچ `left`/`right`.
- `dir` روی `<html>` ست شود و همراه زبان عوض شود؛ فونت هم با آن سوییچ کند (`Vazirmatn` ↔ `Sora`).
- بلوک‌های کد، مسیر، URL و لاگ همیشه `dir="ltr"` بگیرند، حتی در حالت فارسی.
- اعداد با `toLocaleString('fa-IR')` در فارسی و `en-US` در انگلیسی.
- آیکون‌های جهت‌دار (فلش، chevron) در RTL آینه شوند.

## ۵) قواعد نمودار

- یک محور؛ هرگز دو مقیاس y.
- روند امتیاز = یک سری با accent، خط 2px، نقطه‌ی انتهایی برجسته، area fill با گرادیان محو.
- توزیع شدت = میله با رنگ status + برچسب مستقیم + نوار شدت (`i` عمودی) تا فقط رنگ حامل معنا نباشد.
- متن نمودار همیشه از `--ink-2/--ink-3`، هرگز رنگ سری.
- hover با crosshair + tooltip روی نمودار خطی؛ tooltip روی میله‌ها.

## ۶) الگوهای وضعیت

- `pill` برای وضعیت (ok/warn/serious/crit/info/mute/acc) — همیشه آیکون + متن، نه فقط رنگ.
- `sev` برای شدت ایشو — نوار عمودی + برچسب.
- ریسک اصلاح: `low` سبز، `sensitive` زرد، `blocked` قرمز با آیکون قفل.

## ۷) چیزی که در UI قفل است

ریدایرکت، تغییر URL و ادغام صفحات همیشه با بنر قفل زرد نمایش داده می‌شوند و دکمه‌ی «اعمال» ندارند — فقط «ارسال برای تأیید». این در UI صرفاً بازتاب قاعده‌ای است که باید سمت سرور enforce شود.
