// 折線ユーティリティ: 経度ラップでの分割と Chaikin 平滑化。
// 流線・等値線などの描画前処理に使う(データ側はセル精度のまま)。

/** [lat, lon, ...] のフラット折線を、経度ジャンプ(>180°)で分割する */
export function splitAtLonWrap(points: number[]): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  for (let k = 0; k + 1 < points.length; k += 2) {
    const lat = points[k] ?? 0;
    const lon = points[k + 1] ?? 0;
    if (current.length >= 2) {
      const prevLon = current[current.length - 1] ?? 0;
      if (Math.abs(lon - prevLon) > 180) {
        segments.push(current);
        current = [];
      }
    }
    current.push(lat, lon);
  }
  if (current.length >= 4) segments.push(current);
  else if (current.length >= 2 && segments.length === 0) segments.push(current);
  return segments;
}

/** Chaikin の角切り平滑化(端点は固定)。iterations 回適用 */
export function chaikinSmooth(points: number[], iterations: number): number[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const n = pts.length / 2;
    if (n < 3) return pts;
    const out: number[] = [pts[0] ?? 0, pts[1] ?? 0];
    for (let k = 0; k < n - 1; k++) {
      const aLat = pts[k * 2] ?? 0;
      const aLon = pts[k * 2 + 1] ?? 0;
      const bLat = pts[(k + 1) * 2] ?? 0;
      const bLon = pts[(k + 1) * 2 + 1] ?? 0;
      out.push(aLat * 0.75 + bLat * 0.25, aLon * 0.75 + bLon * 0.25);
      out.push(aLat * 0.25 + bLat * 0.75, aLon * 0.25 + bLon * 0.75);
    }
    out.push(pts[(n - 1) * 2] ?? 0, pts[(n - 1) * 2 + 1] ?? 0);
    pts = out;
  }
  return pts;
}

/** ラップ分割 → 平滑化 をまとめて行う(描画用) */
export function smoothForDrawing(points: number[], iterations = 2): number[][] {
  return splitAtLonWrap(points).map((seg) => chaikinSmooth(seg, iterations));
}
