// PipelineResult の全数値リーフを汎用列挙する(変更レビュー FB P2-2)。
// 手書きの検査対象リストではなく再帰列挙なので、PipelineResult に新しい場が
// 追加されても自動的に検査対象へ入る(更新漏れが構造的に起きない)。
// 決定性ダイジェストと有限性検査は必ず同じ列挙を使う。

export type NumericLeaf =
  | { path: string; kind: 'array'; value: ArrayLike<number> }
  | { path: string; kind: 'number'; value: number }
  | { path: string; kind: 'text'; value: string };

function isTypedArray(v: unknown): v is ArrayLike<number> {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

export function collectNumericLeaves(
  value: unknown,
  path = '$',
  out: NumericLeaf[] = [],
): NumericLeaf[] {
  if (value === null || value === undefined) return out;
  if (typeof value === 'number') {
    out.push({ path, kind: 'number', value });
    return out;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    out.push({ path, kind: 'text', value: String(value) });
    return out;
  }
  if (isTypedArray(value)) {
    out.push({ path, kind: 'array', value });
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((x) => typeof x === 'number')) {
      out.push({ path, kind: 'array', value: value as number[] });
      return out;
    }
    for (let i = 0; i < value.length; i++) collectNumericLeaves(value[i], `${path}[${i}]`, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      collectNumericLeaves((value as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
  }
  return out;
}

// FNV-1a。8 バイトのバッファは 1 個だけ再利用する(P2-2 の割当指摘への対処)
const buf = new DataView(new ArrayBuffer(8));

export function digestOf(value: unknown): string {
  let h = 0x811c9dc5;
  const mixByte = (b: number) => {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  };
  const mixNumber = (x: number) => {
    buf.setFloat64(0, x);
    for (let b = 0; b < 8; b++) mixByte(buf.getUint8(b));
  };
  for (const leaf of collectNumericLeaves(value)) {
    for (let i = 0; i < leaf.path.length; i++) mixByte(leaf.path.charCodeAt(i) & 0xff);
    if (leaf.kind === 'array') {
      const arr = leaf.value;
      mixNumber(arr.length);
      for (let i = 0; i < arr.length; i++) mixNumber(arr[i] as number);
    } else if (leaf.kind === 'number') {
      mixNumber(leaf.value);
    } else {
      for (let i = 0; i < leaf.value.length; i++) mixByte(leaf.value.charCodeAt(i) & 0xff);
    }
  }
  return (h >>> 0).toString(16);
}

/** 非有限リーフの一覧(パス付き)。空なら全出力が有限 */
export function nonFiniteLeaves(value: unknown): string[] {
  const out: string[] = [];
  for (const leaf of collectNumericLeaves(value)) {
    if (leaf.kind === 'number') {
      if (!Number.isFinite(leaf.value)) out.push(`${leaf.path} = ${String(leaf.value)}`);
    } else if (leaf.kind === 'array') {
      const arr = leaf.value;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i] as number)) {
          out.push(`${leaf.path}[${i}] = ${String(arr[i])}`);
          break; // 同一配列は先頭の 1 件で十分
        }
      }
    }
  }
  return out;
}
