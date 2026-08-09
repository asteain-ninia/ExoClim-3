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
  /** 収束判定: 平均 W に対する相対変化 */
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
  // 面の法線速度と局所時間刻みは**風と格子だけで決まり、反復では変わらない**。
  // 内側ループで毎回組み直すと、1 セルあたり除算 2 回と max 8 回を
  // 数千反復ぶん繰り返すことになる。値は同じ(Float64 で保持するので
  // 丸めも変わらない)ので、**結果はビット一致する**。
  const faceE = new Float64Array(N);
  const faceW = new Float64Array(N);
  const faceN = new Float64Array(N);
  const faceS = new Float64Array(N);
  const dtArr = new Float64Array(N);
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
      dtArr[i] = 0.8 / Math.max(1e-9, outRate + 1e-9);
    }
  }

  // 収束判定の基準量: 源泉の面積平均(mm/月)。残差を無次元にするために使う。
  // **1 反復あたりの変化量ではなく、方程式そのものの残差**で判定する
  // (下の注記を参照)
  let meanSource = 0;
  for (let i = 0; i < N; i++) meanSource += Math.max(0, sourceMmPerMonth[i] ?? 0);
  meanSource = Math.max(1e-9, meanSource / N);

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
  for (let it = 1; it <= maxIterations; it++) {
    iterations = it;
    let maxImbalance = 0;
    const forward = it % 2 === 1;
    for (let rr = 0; rr < H; rr++) {
      const row = forward ? rr : H - 1 - rr;
      const area = areaM2[row] ?? 1;
      const dxC = dxCenterM[row] ?? 1;
      const lenN = lenNorthM[row] ?? 0;
      const lenS = lenSouthM[row] ?? 0;
      for (let cc = 0; cc < W; cc++) {
        const col = forward ? cc : W - 1 - cc;
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

        // 風上流束(外向き正)。東面: un>0 なら自セルから流出
        const fluxE = lenMeridionalM * (Math.max(0, unE) * wi + Math.min(0, unE) * wE);
        // 西面: un>0 は西セルから流入(= 自セルから見ると −)
        const fluxW = lenMeridionalM * (Math.max(0, unW) * wW + Math.min(0, unW) * wi);
        const fluxN = iN >= 0 ? lenN * (Math.max(0, unN) * wi + Math.min(0, unN) * wN) : 0;
        const fluxS = iS >= 0 ? lenS * (Math.max(0, unS) * wS + Math.min(0, unS) * wi) : 0;
        // 拡散(外向き正: 自セルが高いほど流出)
        const diffE = diffusivity ? (lenMeridionalM * diffusivity * (wi - wE)) / dxC : 0;
        const diffW = diffusivity ? (lenMeridionalM * diffusivity * (wi - wW)) / dxC : 0;
        const diffN = diffusivity && iN >= 0 ? (lenN * diffusivity * (wi - wN)) / dyCenterM : 0;
        const diffS = diffusivity && iS >= 0 ? (lenS * diffusivity * (wi - wS)) / dyCenterM : 0;

        const netOutflow = fluxE - fluxW + fluxN - fluxS + diffE + diffW + diffN + diffS;
        const divergence = netOutflow / area; // mm/月

        // 局所時間刻み: 流出係数から CFL を評価(定常解を求めるので局所で可)。反復不変
        const dt = dtArr[i] ?? 0;

        // 凝結項は陰的(λG が大きくても安定)。
        // 閾値ありのときは C = rate·max(0, W − cap) を陰的に解く:
        //   w = explicit − dt·rate·max(0, w − cap)
        //   w > cap の枝: w = (explicit + dt·rate·cap) / (1 + dt·rate)
        //     (この枝が有効なのは explicit > cap のときで、判定は explicit だけで済む)
        //   それ以外: w = explicit(凝結なし = 通過する)
        const rate = Math.max(1e-6, condensationRatePerMonth[i] ?? 0);
        // 鉛直輸出も陰的に扱う(W に比例して柱から抜ける。降水にはならない)
        const ex = vExport ? Math.max(0, vExport[i] ?? 0) : 0;
        const explicit = wi + dt * ((sourceMmPerMonth[i] ?? 0) - divergence);
        let w: number;
        if (capacity) {
          const cap = Math.max(0, capacity[i] ?? 0);
          // 閾値ありのとき、凝結は超過分にだけ効き、鉛直輸出は柱全体に効く:
          //   w = explicit − dt·rate·max(0, w − cap) − dt·ex·w
          const withCond = (explicit + dt * rate * cap) / (1 + dt * (rate + ex));
          w = withCond > cap ? withCond : Math.max(0, explicit / (1 + dt * ex));
        } else {
          w = Math.max(0, explicit / (1 + dt * (rate + ex)));
        }
        w = Math.max(0, w);
        cur[i] = w;

        // **方程式の残差**: S − C(w) − ∇·(wV) を新しい w で評価する。
        // 発散は更新前の w_i で作った値なので厳密には遅れているが、
        // 収束すれば遅れは消えるので判定として正しく閉じる。
        const cond = capacity
          ? rate * Math.max(0, w - Math.max(0, capacity[i] ?? 0))
          : rate * w;
        const imbalance = (sourceMmPerMonth[i] ?? 0) - cond - ex * w - divergence;
        const absImb = Math.abs(imbalance);
        if (absImb > maxImbalance) maxImbalance = absImb;
      }
    }
    residual = maxImbalance / meanSource;
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
