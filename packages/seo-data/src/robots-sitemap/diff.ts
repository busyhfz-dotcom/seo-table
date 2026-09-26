/**
 * Line diff (longest common subsequence) for the robots.txt editor. Files are
 * small (Google reads at most 500 KiB), but the table is O(n·m), so very long
 * inputs fall back to "everything removed, everything added" rather than
 * allocating a huge matrix.
 */
export type DiffLine = { op: "=" | "+" | "-"; line: string; oldNo: number | null; newNo: number | null };

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((line, i) => ({ op: "-" as const, line, oldNo: i + 1, newNo: null })),
      ...b.map((line, i) => ({ op: "+" as const, line, oldNo: null, newNo: i + 1 })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "=", line: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", line: a[i]!, oldNo: i + 1, newNo: null });
      i++;
    } else {
      out.push({ op: "+", line: b[j]!, oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ op: "-", line: a[i]!, oldNo: i + 1, newNo: null });
  for (; j < m; j++) out.push({ op: "+", line: b[j]!, oldNo: null, newNo: j + 1 });
  return out;
}
