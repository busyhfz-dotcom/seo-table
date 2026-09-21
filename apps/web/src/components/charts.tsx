"use client";

/**
 * Charts.
 *
 * One measure, one axis. The score trend is a single series, so it carries no
 * legend — the card title names it. Severity uses the reserved status colours
 * with a bar and a direct label, so the encoding survives colourblindness and
 * printing. Chart text takes its colour from the theme tokens.
 */
import { useId, useState } from "react";

export type TrendPoint = { label: string; value: number };

export function ScoreTrend({
  points,
  ariaLabel,
  todayLabel,
}: {
  points: TrendPoint[];
  ariaLabel: string;
  todayLabel: string;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  if (points.length === 0) return null;
  if (points.length === 1) {
    // One data point is not a trend; show the value rather than a misleading line.
    // The gauge beside this already shows the value; here, say when it was taken.
    return (
      <div style={{ padding: "18px 0", color: "var(--ink-3)", fontSize: 12.5 }}>{points[0]!.label}</div>
    );
  }

  const W = 680;
  const H = 210;
  const pl = 34;
  const pr = 14;
  const pt = 14;
  const pb = 24;

  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const min = Math.max(0, Math.floor((rawMin - 4) / 5) * 5);
  const max = Math.min(100, Math.ceil((rawMax + 4) / 5) * 5);
  const span = Math.max(1, max - min);

  const x = (i: number) => pl + (i * (W - pl - pr)) / (points.length - 1);
  const y = (v: number) => pt + ((max - v) / span) * (H - pt - pb);

  const coords = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  const ticks = tickValues(min, max);
  const last = points.length - 1;

  function onMove(event: React.MouseEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const rel = ((event.clientX - rect.left) / rect.width) * (W - pl - pr);
    const i = Math.max(0, Math.min(last, Math.round((rel / (W - pl - pr)) * last)));
    setHover({ i, x: x(i), y: y(points[i]!.value) });
  }

  return (
    <div style={{ position: "relative" }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} style={{ direction: "ltr" }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2BE08A" stopOpacity="0.28" />
            <stop offset="1" stopColor="#2BE08A" stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((v) => (
          <g key={v}>
            <line className="grid-l" x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} />
            <text x={pl - 8} y={y(v) + 3.5} textAnchor="end">
              {v}
            </text>
          </g>
        ))}

        <text x={pl} y={H - 6} textAnchor="start">
          {points[0]!.label}
        </text>
        <text x={W - pr} y={H - 6} textAnchor="end">
          {todayLabel}
        </text>

        <polygon
          fill={`url(#${gradientId})`}
          points={`${pl},${H - pb} ${coords.join(" ")} ${W - pr},${H - pb}`}
        />
        <polyline
          fill="none"
          stroke="#2BE08A"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={coords.join(" ")}
        />

        {hover && (
          <>
            <line x1={hover.x} x2={hover.x} y1={pt} y2={H - pb} stroke="#314138" strokeWidth="1" />
            <circle cx={hover.x} cy={hover.y} r="4" fill="#2BE08A" stroke="#080B09" strokeWidth="2" />
          </>
        )}

        <circle cx={x(last)} cy={y(points[last]!.value)} r="4.5" fill="#63F2AD" stroke="#080B09" strokeWidth="2" />

        <rect
          x={pl}
          y={pt}
          width={W - pl - pr}
          height={H - pt - pb}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {hover && (
        <div
          style={{
            position: "absolute",
            insetInlineStart: `${(hover.x / W) * 100}%`,
            top: `${(hover.y / H) * 100}%`,
            transform: "translate(8px, -120%)",
            background: "var(--surface-3)",
            boxShadow: "inset 0 0 0 1px var(--border-strong), 0 14px 30px -18px #000",
            borderRadius: "var(--r-sm)",
            padding: "6px 10px",
            fontSize: 12,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <b className="num" style={{ fontFamily: "var(--f-en)" }}>
            {points[hover.i]!.value}
          </b>{" "}
          · {points[hover.i]!.label}
        </div>
      )}
    </div>
  );
}

function tickValues(min: number, max: number): number[] {
  const step = max - min <= 20 ? 5 : 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out.length >= 2 ? out : [min, max];
}

export function ScoreGauge({ score, label }: { score: number; label: string }) {
  const R = 54;
  const C = Math.PI * R;
  const frac = Math.max(0, Math.min(1, score / 100));
  return (
    <svg
      viewBox="0 0 140 96"
      style={{ width: 150, height: "auto", flex: "none", direction: "ltr" }}
      role="img"
      aria-label={`${label}: ${score} / 100`}
    >
      <path d="M16 70a54 54 0 0 1 108 0" fill="none" stroke="#1E2823" strokeWidth="11" strokeLinecap="round" />
      <path
        d="M16 70a54 54 0 0 1 108 0"
        fill="none"
        stroke="#2BE08A"
        strokeWidth="11"
        strokeLinecap="round"
        strokeDasharray={`${(C * frac).toFixed(1)} ${C.toFixed(1)}`}
      />
      <text x="70" y="64" textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 26, fontWeight: 600 }}>
        {score}
      </text>
      <text x="70" y="90" textAnchor="middle">
        0 – 100
      </text>
    </svg>
  );
}
