// 対応 spec: docs/FB_2026-07-31.md P2-1(中期案「保存型の水蒸気輸送」)。
// 2026-08-01 の外部レビュー(Codex CLI)の設計に沿う。
//
// 目的: 現行の「風上追跡による供給場 q」は湿潤源への**到達可能性**であって
// 水蒸気量ではない。そのため −∇·(qV) が物理的な水蒸気収束にならず、R4
// (収束→降水)がアラビアと中国東部を判別できなかった(FB対応記録 R4 参照)。
// ここでは可降水量 W(mm)を状態として持ち、収支を閉じた定常解を解く。
//
//   0 = S_i − C_i(W) − (1/A_i) Σ_f Φ_if
//   S_i = 海面蒸発 + 陸面蒸発散                     [mm/月]
//   Φ_{i→j} = L_f { u_n⁺ W_i + u_n⁻ W_j − κ (W_j − W_i)/d_f }   風上流束 + 拡散
//   C_i = λ_i G_i W_i                              凝結(= 降水)[mm/月]
//
// λ_i = U_ref / L_i(凝結の時定数。既存の moistureDecay*Km は「水が消える
// 距離」ではなく凝結寿命として写す)。G_i は既存の持上げ・抑制倍率を
// 「降水の乗数」ではなく「凝結率の係数」として使う。
//
// 実装上の要点(レビュー指摘):
//  - 移流は**風上流束**(中心平均は負値を作る)。共有面で一度だけ計算する
//    ので保存的(Σ A_i div = 0)。経度は周期境界、極の辺長は 0。
//  - 凝結項は陰的に扱う(λG が大きくても無条件安定)。
//  - 局所時間刻みで定常解へ緩和する(CFL は面流束から評価)。
//  - 凝結で除いた水は必ず同じセルの降水に計上する(漏れを作らない)。

import type { Grid } from '@/domain/grid';
import { latDegOfRow, wrapCol } from '@/domain/grid';

/** 1 か月の秒数(30.44 日) */
export const SECONDS_PER_MONTH = 30.44 * 86400;

export interface MoistureTransportOptions {
  /** 水平拡散係数 m²/s(渦による混合。0 で純移流) */
  diffusivityM2PerS?: number;
  /**
   * 収束判定: **方程式の残差** max|S − C(W) − ∇·(WV)| を平均 S で割った値。
   * 2026-08-09 まで「1 反復あたりの変化量」だったが、緩和の遅い系で
   * 嘘をつくので改めた(docs/検証_輸送の収束と初期値依存_2026-08-09.md)。
   */
  tolerance?: number;
  /**
   * 反復上限。**既定は実測で決めてある**(2026-08-04、
   * scripts/exp_transport_convergence.ts): 地球 1° の 12 か月で 1451 反復で
   * 収束し、そこから上限を 2 倍・4 倍にしてもビット一致した。
   * 旧既定の 400 は届いておらず、上限が答えを決める状態だった
   * (EBM で 3 回踏んだ隠しパラメータと同じ型 — 教訓 §9)。
   * 収束したかは戻り値の converged で必ず確かめること。
   */
  maxIterations?: number;
  /**
   * [cell] 柱の保持容量 mm(**閾値凝結**を使うときに渡す)。
   *
   * 渡さない場合の凝結は C = rate·W で、**通過する水を必ず降らせる**。
   * これは保存則と噛み合わない: 凝結率を下げても水は消えず下流で降るだけなので、
   * 「抑制」が総量を動かせない(2026-08-04 実測: 砂漠 6 月がむしろ悪化した)。
   *
   * 渡した場合は C = rate·max(0, W − capacity) となり、**持てる量を超えたぶん
   * だけ降る**。暑い乾燥域は capacity が Clausius-Clapeyron で大きいので、
   * 水が通過しても降らずに下流へ運ばれる — 実在の亜熱帯が乾いているのは
   * 水を消しているからではなく、貿易風で赤道側へ**輸出**しているからである。
   * 持ち上げは capacity を下げる形で入る(断熱冷却で凝結しやすくなる物理)。
   */
  holdingCapacityMm?: ArrayLike<number>;
  /**
   * [cell] 鉛直輸出率 1/月(**沈降域で柱から抜ける水蒸気**)。
   *
   * なぜ要るか(2026-08-04 実測、docs/実験記録_保存型水蒸気輸送_2026-08-04.md):
   *   2 次元の柱収支は「乾いた収束」を表せない。サハラの熱的低気圧は地表で
   *   収束流を作るので、柱収支しか無ければ収束した水蒸気を必ずどこかで
   *   降らせるしかない。実物が降らないのは、水蒸気が逆転層の下に閉じ込められ
   *   中層が乾いて沈降しているからで、**鉛直積分した W には入らない情報**である。
   *
   * これは水の破壊ではなく、単層モデルが解けない**鉛直方向の輸送**の
   * パラメタリゼーション。抜けた水は exportedMm に計上されるので、
   * 呼び出し側が上昇域へ返して全球で閉じること(ハドレー循環の閉包)。
   */
  verticalExportRatePerMonth?: ArrayLike<number>;
  /**
   * [cell] 反復の初期値 mm(**温間開始**)。同じ月を結合反復で何度も解き直す
   * ときに前回の解を渡すと、反復数が大きく減る。
   *
   * **答えは変わらない。** 到達する定常解は初期値に依らず(線形化した系の
   * 唯一の不動点で、風上流束・陰的凝結ともに単調)、収束判定は同じ許容差で
   * 行うため。変わるのは所要反復だけである。
   * 渡さないときは局所平衡 S/λ から始める(従来どおり)。
   */
  initialGuessMm?: ArrayLike<number>;
  /**
   * 逐次過緩和(SOR)の係数。**渡さなければ 1.9 から始めて、発散を検知したら
   * 1.0 へ落として解き直す**(自動)。明示すると自動の落としは行わない。
   * **答えを変えない** — 収束点では w = wGs なので ω に依らない。
   *
   * 1 より大きくすると拡散支配の配置では速くなるが、**拡散の無い純移流では
   * 発散する**(2026-08-09 に ω=1.5 を既定にして全セル NaN を作った)。
   * 上げるなら、その配置で収束することを実測してからにすること。
   */
  relaxation?: number;
}

export interface MoistureTransportResult {
  /** [cell] 可降水量 mm */
  waterMm: Float32Array;
  /** [cell] 凝結量 = 降水 mm/月 */
  condensationMm: Float32Array;
  /**
   * [cell] 鉛直輸出量 mm/月(柱から抜けたが降水にならなかった水蒸気)。
   * **呼び出し側がこれを上昇域へ返して全球で閉じること**(ハドレー循環の閉包)。
   * 返さなければ水が消え、全球水収支が合わなくなる。
   */
  exportedMm: Float32Array;
  iterations: number;
  /**
   * 最終反復での**方程式の残差** max|S − C(W) − ∇·(WV)| / 平均S(無次元)。
   *
   * **1 反復あたりの変化量ではない。** 2026-08-09 まで変化量で判定しており、
   * 緩和の遅い系で「収束した」と嘘をついていた(初期値の違う 2 本が
   * どちらも収束と報告しながら降水が 10% 違った)。
   */
  residual: number;
  converged: boolean;
}

/**
 * 月別の定常な保存型水蒸気輸送を解く。
 * source と condensationRate は同じ長さの [cell] 配列。
 * condensationRate は 1/月(λ_i G_i)。0 のセルは水蒸気が溜まり続けるため、
 * 呼び出し側で最小値を与えること(下限は本関数でも安全側に効かせる)。
 */
export function solveMoistureTransport(
  grid: Grid,
  radiusKm: number,
  windU: Float32Array,
  windV: Float32Array,
  sourceMmPerMonth: Float32Array,
  condensationRatePerMonth: Float32Array,
  options: MoistureTransportOptions = {},
): MoistureTransportResult {
  const W = grid.widthCells;
  const H = grid.heightCells;
  const N = grid.cellCount;
  const diffusivity = (options.diffusivityM2PerS ?? 0) * SECONDS_PER_MONTH; // m²/月
  const tolerance = options.tolerance ?? 1e-5;
  const maxIterations = options.maxIterations ?? 4000;
  // 逐次過緩和の係数。**不動点は変わらない**(収束したとき w = wGs なので
  // ω に依らない)。速度だけの量なので較正定数ではなく、探索空間にも入れない。
  //
  // 既定は 1.9 から始めて、**発散を検知したら 1.0 へ落として最初からやり直す**。
  // 拡散支配の配置(地球の設定はこちら)では過緩和が桁で効くが、拡散の無い
  // 純移流では発散する(2026-08-09 に ω=1.5 固定で全セル NaN を作った)。
  // どちらの配置が来るかは惑星のパラメータ次第なので、**固定値にせず自動で
  // 落とす**。答えは残差で判定するので、どちらに転んでも解は同じである。
  let relaxation = options.relaxation ?? 1.9;
  const allowFallback = options.relaxation === undefined;
  const capacity = options.holdingCapacityMm ?? null;
  const vExport = options.verticalExportRatePerMonth ?? null;

  const aM = radiusKm * 1000;
  const dPhi = (grid.resolutionDeg * Math.PI) / 180;
  const dLam = (grid.resolutionDeg * Math.PI) / 180;
  const lenMeridionalM = aM * dPhi; // 東西面の辺長(経線方向)
  const dxCenterM = new Float64Array(H); // 東西のセル中心間距離
  const areaM2 = new Float64Array(H);
  const lenNorthM = new Float64Array(H);
  const lenSouthM = new Float64Array(H);
  for (let row = 0; row < H; row++) {
    const cosC = Math.max(1e-6, Math.cos((latDegOfRow(grid, row) * Math.PI) / 180));
    areaM2[row] = aM * aM * dLam * dPhi * cosC;
    dxCenterM[row] = aM * dLam * cosC;
    const cosFace = (rowFace: number): number =>
      Math.max(0, Math.cos(((90 - rowFace * grid.resolutionDeg) * Math.PI) / 180));
    lenNorthM[row] = aM * dLam * cosFace(row);
    lenSouthM[row] = aM * dLam * cosFace(row + 1);
  }
  const dyCenterM = aM * dPhi;

  // 風を m/月へ(移流の時間単位を揃える)
  const uM = new Float64Array(N);
  const vM = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    uM[i] = (windU[i] ?? 0) * SECONDS_PER_MONTH;
    vM[i] = (windV[i] ?? 0) * SECONDS_PER_MONTH;
  }

  const waterMm = new Float32Array(N);
  const condensationMm = new Float32Array(N);
  const exportedMm = new Float32Array(N);
  const cur = new Float64Array(N);
  // 初期値: 温間開始があればそれ、無ければ源 / 凝結率(局所平衡)。
  // どちらも負にならず、定常解へ近い
  const warm = options.initialGuessMm ?? null;
  for (let i = 0; i < N; i++) {
    if (warm) {
      cur[i] = Math.max(0, warm[i] ?? 0);
    } else {
      const rate = Math.max(1e-6, condensationRatePerMonth[i] ?? 0);
      cur[i] = Math.max(0, (sourceMmPerMonth[i] ?? 0) / rate);
    }
  }

  // ---- 反復不変量を先に作る ----
  // 面の法線速度と流出係数は**風と格子だけで決まり、反復では変わらない**。
  // 内側ループで毎回組み直すと、1 セルあたり除算 2 回と max 8 回を
  // 数千反復ぶん繰り返すことになる。値は同じ(Float64 で保持するので
  // 丸めも変わらない)ので、**結果はビット一致する**。
  const faceE = new Float64Array(N);
  const faceW = new Float64Array(N);
  const faceN = new Float64Array(N);
  const faceS = new Float64Array(N);
  const outRateArr = new Float64Array(N);
  for (let row = 0; row < H; row++) {
    const area = areaM2[row] ?? 1;
    const dxC = dxCenterM[row] ?? 1;
    const lenN = lenNorthM[row] ?? 0;
    const lenS = lenSouthM[row] ?? 0;
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const iE = row * W + wrapCol(grid, col + 1);
      const iW = row * W + wrapCol(grid, col - 1);
      const iN = row > 0 ? (row - 1) * W + col : -1;
      const iS = row < H - 1 ? (row + 1) * W + col : -1;
      const unE = 0.5 * ((uM[i] ?? 0) + (uM[iE] ?? 0));
      const unW = 0.5 * ((uM[i] ?? 0) + (uM[iW] ?? 0));
      const unN = iN >= 0 ? 0.5 * ((vM[i] ?? 0) + (vM[iN] ?? 0)) : 0;
      const unS = iS >= 0 ? 0.5 * ((vM[i] ?? 0) + (vM[iS] ?? 0)) : 0;
      faceE[i] = unE;
      faceW[i] = unW;
      faceN[i] = unN;
      faceS[i] = unS;
      const outRate =
        (lenMeridionalM * (Math.max(0, unE) + Math.max(0, -unW)) +
          lenN * Math.max(0, unN) +
          lenS * Math.max(0, -unS)) /
          area +
        (diffusivity
          ? (2 * lenMeridionalM * diffusivity) / (area * dxC) +
            ((lenN + lenS) * diffusivity) / (area * dyCenterM)
          : 0);
      outRateArr[i] = outRate;
    }
  }

  // 収束判定の基準量: 源泉の面積平均(mm/月)。残差を無次元にするために使う。
  // **1 反復あたりの変化量ではなく、方程式そのものの残差**で判定する
  // (下の注記を参照)
  let meanSource = 0;
  for (let i = 0; i < N; i++) meanSource += Math.max(0, sourceMmPerMonth[i] ?? 0);
  meanSource = Math.max(1e-9, meanSource / N);

  // 発散したときに戻すための初期値の控え
  const initial = Float64Array.from(cur);
  let bestResidual = Number.POSITIVE_INFINITY;
  let fellBack = false;

  let residual = Number.POSITIVE_INFINITY;
  let iterations = 0;
  let converged = false;
  // その場更新(ガウス=ザイデル)+ 掃引方向の交互化で緩和を速める。
  // 掃引順は決定的なので結果は再現する(Jacobi の 3〜5 倍速い実測)
  //
  // **収束判定は「方程式の残差」で行う**(2026-08-09 に直した)。
  // 以前は 1 反復あたりの変化量 max|Δw| / 平均W を見ていたが、これは
  // 緩和の遅い系では**解が不動点から遠くてもいくらでも小さくなる**。
  // 実測(scripts/check_transport_warmstart.ts): 初期値の違う 2 本が
  // どちらも「収束」と報告しながら、降水が最大 9.8e-2(平均比)違った —
  // 許容差 1e-5 の 4 桁上である。**判定そのものが嘘だった。**
  //
  // 全球の水収支(閉包)も証拠にならない。発散項は隣接セルで打ち消し合うので
  // 全球和は自動的に 0 になり、**局所解が大きくずれていても閉包は合う**。
  // 閉包が見ているのは不均衡の平均であって最大ではない。
  let sweeps = 0;
  for (let it = 1; it <= maxIterations; it++) {
    sweeps++;
    iterations = sweeps;
    let maxImbalance = 0;
    // 掃引順を 4 通り回す(行 × 列 の昇降の組合せ)。移流は情報が風下へ伝わる
    // ので、風向と揃った掃引が来る回で一気に伝播する。決定的なので再現する
    const dir = (it - 1) % 4;
    const rowForward = dir < 2;
    const colForward = dir % 2 === 0;
    for (let rr = 0; rr < H; rr++) {
      const row = rowForward ? rr : H - 1 - rr;
      const area = areaM2[row] ?? 1;
      const dxC = dxCenterM[row] ?? 1;
      const lenN = lenNorthM[row] ?? 0;
      const lenS = lenSouthM[row] ?? 0;
      for (let cc = 0; cc < W; cc++) {
        const col = colForward ? cc : W - 1 - cc;
        const i = row * W + col;
        const iE = row * W + wrapCol(grid, col + 1);
        const iW = row * W + wrapCol(grid, col - 1);
        const iN = row > 0 ? (row - 1) * W + col : -1;
        const iS = row < H - 1 ? (row + 1) * W + col : -1;

        // 面の法線速度は両側セルの平均(共有面で一意 → 保存的)。反復不変
        const unE = faceE[i] ?? 0;
        const unW = faceW[i] ?? 0;
        const unN = faceN[i] ?? 0;
        const unS = faceS[i] ?? 0;

        const wi = cur[i] ?? 0;
        const wE = cur[iE] ?? 0;
        const wW = cur[iW] ?? 0;
        const wN = iN >= 0 ? (cur[iN] ?? 0) : wi;
        const wS = iS >= 0 ? (cur[iS] ?? 0) : wi;

        // 正味流出は w_i について 1 次なので、係数と定数へ分けられる:
        //   netOutflow = a·w_i − b
        // a/area は既に作ってある outRate と同じ量である。
        // b は**隣から入ってくるぶん**(風上流束の流入側 + 拡散の流入側)。
        let inflow =
          lenMeridionalM * Math.max(0, -unE) * wE +
          lenMeridionalM * Math.max(0, unW) * wW +
          (iN >= 0 ? lenN * Math.max(0, -unN) * wN : 0) +
          (iS >= 0 ? lenS * Math.max(0, unS) * wS : 0);
        if (diffusivity) {
          inflow +=
            (lenMeridionalM * diffusivity * wE) / dxC +
            (lenMeridionalM * diffusivity * wW) / dxC +
            (iN >= 0 ? (lenN * diffusivity * wN) / dyCenterM : 0) +
            (iS >= 0 ? (lenS * diffusivity * wS) / dyCenterM : 0);
        }
        const inflowRate = inflow / area; // mm/月
        const outRate = outRateArr[i] ?? 0; // 1/月(a/area)

        const rate = Math.max(1e-6, condensationRatePerMonth[i] ?? 0);
        // 鉛直輸出も陰的に扱う(W に比例して柱から抜ける。降水にはならない)
        const ex = vExport ? Math.max(0, vExport[i] ?? 0) : 0;
        const src = sourceMmPerMonth[i] ?? 0;

        // **反復前の残差**(この反復子がどれだけ方程式を満たしていないか)。
        // 更新後ではなく更新前で測るのが正しい — 更新後は「次の反復子」の
        // 残差の一部を先取りしてしまい、収束を実際より良く見せる
        const condNow = capacity
          ? rate * Math.max(0, wi - Math.max(0, capacity[i] ?? 0))
          : rate * wi;
        const absImb = Math.abs(src + inflowRate - condNow - ex * wi - outRate * wi);
        // **NaN を素通りさせない**(`absImb > maxImbalance` は NaN で false)
        if (!(absImb <= maxImbalance)) maxImbalance = absImb;

        // 局所方程式を **w_i について厳密に解く**(点ガウス=ザイデル)。
        // 以前は dt = 0.8/outRate の擬似時間更新で、解かずに 0.8 倍へ
        // 減衰させていた。楕円型(この系は拡散が凝結より 2 桁速い)では
        // これが収束を大きく損なう
        let wGs: number;
        if (capacity) {
          const cap = Math.max(0, capacity[i] ?? 0);
          const withCond = (src + inflowRate + rate * cap) / (rate + ex + outRate);
          wGs =
            withCond > cap ? withCond : (src + inflowRate) / Math.max(1e-9, ex + outRate);
        } else {
          wGs = (src + inflowRate) / (rate + ex + outRate);
        }
        // 逐次過緩和。**不動点は変わらない**(収束したときに w = wGs なので、
        // ω を掛けても解は同じ)。速度だけの量なので較正定数ではない
        cur[i] = Math.max(0, wi + relaxation * (wGs - wi));
      }
    }
    residual = maxImbalance / meanSource;
    // **非有限に対して閉じる。** NaN は大小比較が全て false になるので、
    // 黙って「収束した」になる(2026-08-09 に実際に踏んだ)
    const diverging = !Number.isFinite(residual) || residual > 10 * bestResidual;
    if (diverging) {
      if (allowFallback && !fellBack) {
        // 過緩和が効かない配置(拡散が弱く移流が支配する)。
        // **1.0 へ落として最初からやり直す**。答えは変わらない
        fellBack = true;
        relaxation = 1.0;
        cur.set(initial);
        bestResidual = Number.POSITIVE_INFINITY;
        residual = Number.POSITIVE_INFINITY;
        // 落とした後は**反復の予算を仕切り直す**(発散して捨てた掃引を
        // 数えたままだと、上限に足りずに未収束で終わる)。
        // 最悪の仕事量は 2 倍になるが、iterations には総掃引数を返すので
        // 費用は隠れない
        it = 0;
        continue;
      }
      residual = Number.POSITIVE_INFINITY;
      converged = false;
      break;
    }
    if (residual < bestResidual) bestResidual = residual;
    if (residual <= tolerance) {
      converged = true;
      break;
    }
  }

  for (let i = 0; i < N; i++) {
    waterMm[i] = cur[i] ?? 0;
    // 凝結で除いた水は必ず同じセルの降水に計上する(漏れを作らない)。
    // 閾値ありのときは「持てる量を超えたぶん」だけが降る
    const excess = capacity
      ? Math.max(0, (cur[i] ?? 0) - Math.max(0, capacity[i] ?? 0))
      : (cur[i] ?? 0);
    condensationMm[i] = Math.max(1e-6, condensationRatePerMonth[i] ?? 0) * excess;
    exportedMm[i] = vExport ? Math.max(0, vExport[i] ?? 0) * (cur[i] ?? 0) : 0;
  }
  return { waterMm, condensationMm, exportedMm, iterations, residual, converged };
}

/** 全球の水収支残差 |Σ A(S − P)| / Σ A·S(面積重み) */
export function globalBalanceResidual(
  grid: Grid,
  sourceMmPerMonth: ArrayLike<number>,
  condensationMm: ArrayLike<number>,
): number {
  let net = 0;
  let total = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      net += w * ((sourceMmPerMonth[i] ?? 0) - (condensationMm[i] ?? 0));
      total += w * (sourceMmPerMonth[i] ?? 0);
    }
  }
  return Math.abs(net) / Math.max(1e-9, total);
}
