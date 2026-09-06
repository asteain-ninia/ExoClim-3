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

/**
 * 解き方の全体上書き(**診断専用**。既定 null では 1 命令も効かない)。
 *
 * `scripts/diag_transport_equiv.ts` が、パイプラインを丸ごと参照実装
 * (線緩和 SOR)で走らせて新経路と突き合わせるために使う。
 * step06 の `COUPLING_OVERRIDE` / `VIRGA_OVERRIDE` と同じ作りで、
 * **通常実行では触られない**。較正やゲームからは設定しないこと。
 */
export const TRANSPORT_SOLVER_OVERRIDE: { mode: 'auto' | 'relaxation' | null } = { mode: null };

export interface MoistureTransportOptions {
  /** 水平拡散係数 m²/s(渦による混合。0 で純移流) */
  /**
   * 渦拡散 m²/s。**スカラーか、セルごとの場**を渡せる(2026-08-15)。
   *
   * 場を渡せるようにしたのは、ストームトラックの混合を保存的に表すため。
   * 移動性低気圧が海と陸を混ぜるのは月平均で見れば実効的な拡散であり、
   * **拡散は保存的なので水が湧かない**。源泉に足すと陸で水が湧き出す
   * (docs/設計_ストーム供給を保存型へ繋ぐ_2026-08-15.md)。
   *
   * **面の値は両側セルの平均**にする(共有面で一意 = 保存的)。
   * スカラーを渡したときは全セル同値なので、従来と厳密に一致する。
   */
  diffusivityM2PerS?: number | ArrayLike<number>;
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
   * [cell] 背景凝結率 1/月(**二成分閉包**、2026-08-26 監査 #3。
   * docs/事前登録_凝結閉包の二成分化_2026-08-26.md)。
   * 渡すと C = lin·W + rate·max(0, W − capacity) になる — 層状の背景凝結
   * (W に比例、ゆっくり)と湿潤対流(閾値超過分だけ、速い)の和。
   * 渡さない・全 0 は従来と厳密に一致。
   */
  linearRatePerMonth?: ArrayLike<number>;
  /**
   * [cell] 線形凝結の床 mm(**W の熱力学係留**、2026-09-02。
   * docs/事前登録_Wの熱力学係留_2026-09-02.md)。
   * 渡すと線形項が lin·W → lin·max(0, W − floor) になる — 凝結を駆動するのは
   * W の量ではなく**飽和からの距離**(床 = rhFloor·W_sat(T))。床下の W は
   * 凝結を免除され輸送で生き残る。渡さない・全 0 は従来と厳密に一致。
   * 床は非線形(枝)なので、指定時は直接解法を使わず緩和経路で解く。
   */
  linearFloorMm?: ArrayLike<number>;
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
   * 逐次過緩和(SOR)の係数。**渡さなければ 1.6 から始めて、発散を検知したら
   * 1.0 へ落として解き直す**(自動)。明示すると自動の落としは行わない。
   * **答えを変えない** — 収束点では w = wGs なので ω に依らない。
   *
   * 1 より大きくすると拡散支配の配置では速くなるが、**拡散の無い純移流では
   * 発散する**(2026-08-09 に ω=1.5 を既定にして全セル NaN を作った)。
   * 上げるなら、その配置で収束することを実測してからにすること。
   */
  relaxation?: number;
  /**
   * 解き方の選択(2026-08-23、積み残し 11)。**答えを変えない** — どちらも
   * 同じ方程式の同じ不動点へ収束する。速度だけの量なので探索空間には入れない。
   *
   *   'auto'（既定）  閾値凝結が無いときは **BiCGSTAB(前処理 = 線緩和 2 掃引)**。
   *                   閾値凝結があるときは従来の線緩和 SOR。
   *   'relaxation'    常に従来の線緩和 SOR(参照実装。同値検証で使う)。
   *
   * `relaxation`(ω)を明示したときは 'relaxation' と同じ扱いにする。
   * ω の掃引(scripts/bench_transport_relaxation.ts)が測っているのは
   * 線緩和そのものなので、Krylov に化けると測定の意味が変わるため。
   */
  solver?: 'auto' | 'relaxation';
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
  /**
   * 費やした**線緩和の掃引数**(Krylov 経路では前処理として走った掃引の合計)。
   * 解き方が変わっても「1 掃引 = 全セルを 1 回なめる仕事」で数え方を揃える。
   * Krylov から線緩和へ落ちた場合は両方の合計(費用を隠さない)。
   */
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
  // m²/月。スカラーでも場でも同じ口で引けるようにする
  const diffSrc = options.diffusivityM2PerS ?? 0;
  const diffIsField = typeof diffSrc !== 'number';
  const diffAt = (idx: number): number =>
    (diffIsField ? ((diffSrc as ArrayLike<number>)[idx] ?? 0) : (diffSrc as number)) *
    SECONDS_PER_MONTH;
  /** 場でも「どこかで拡散が効くか」の判定に使う(全ゼロなら分岐を省ける) */
  const diffusivity = diffIsField ? 1 : (diffSrc as number) * SECONDS_PER_MONTH;
  const tolerance = options.tolerance ?? 1e-5;
  const maxIterations = options.maxIterations ?? 4000;
  // 逐次過緩和の係数。**不動点は変わらない**(収束したとき w = wGs なので
  // ω に依らない)。速度だけの量なので較正定数ではなく、探索空間にも入れない。
  //
  // 既定は 1.6 から始めて、**発散を検知したら 1.0 へ落として最初からやり直す**。
  // 1.6 は実測で選んだ(scripts/bench_transport_relaxation.ts、地球 1° 月 0):
  //   ω    1.0   1.2   1.4   1.6   1.8   1.9
  //   掃引  384   259   171   119   152   発散
  // 拡散支配の配置(地球の設定はこちら)では過緩和が桁で効くが、拡散の無い
  // 純移流では発散する(2026-08-09 に ω=1.5 固定で全セル NaN を作った)。
  // どちらの配置が来るかは惑星のパラメータ次第なので、**固定値にせず自動で
  // 落とす**。答えは残差で判定するので、どちらに転んでも解は同じである。
  let relaxation = options.relaxation ?? 1.6;
  const allowFallback = options.relaxation === undefined;
  // **容量が全セル 0 なら「閾値凝結なし」と厳密に同じ**なので、ここで畳む。
  //   C = rate·max(0, W − 0) = rate·W   (W ≥ 0 は風上流束の M 行列性から従う)
  // 畳んでおくと、容量 0 を渡した呼び出しも線形経路(下の Krylov)へ入り、
  // 「容量 0 は従来と厳密に一致する」不変量が**同じ道筋を通ることで**保たれる。
  const capacityGiven = options.holdingCapacityMm ?? null;
  let capacityIsZero = capacityGiven !== null;
  if (capacityGiven) {
    for (let i = 0; i < N; i++) {
      if ((capacityGiven[i] ?? 0) > 0) {
        capacityIsZero = false;
        break;
      }
    }
  }
  const capacity = capacityIsZero ? null : capacityGiven;
  const linGiven = options.linearRatePerMonth ?? null;
  let linIsZero = linGiven !== null;
  if (linGiven) {
    for (let i = 0; i < N; i++) {
      if ((linGiven[i] ?? 0) > 0) {
        linIsZero = false;
        break;
      }
    }
  }
  /** 背景凝結率(全 0 なら null = 従来と厳密一致) */
  const linRate = linIsZero ? null : linGiven;
  // 線形凝結の床(全 0 か lin 不在なら null = 従来と厳密一致)
  const floorGiven = options.linearFloorMm ?? null;
  let floorIsZero = floorGiven !== null;
  if (floorGiven && linRate) {
    for (let i = 0; i < N; i++) {
      if ((floorGiven[i] ?? 0) > 0) {
        floorIsZero = false;
        break;
      }
    }
  }
  const linFloor = floorIsZero || !linRate ? null : floorGiven;
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
      const rate =
        Math.max(1e-6, condensationRatePerMonth[i] ?? 0) + (linRate ? Math.max(0, linRate[i] ?? 0) : 0);
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
  const cEArr = new Float64Array(N);
  const cWArr = new Float64Array(N);
  const cNArr = new Float64Array(N);
  const cSArr = new Float64Array(N);
  const diagArr = new Float64Array(N);
  const rateArr = new Float64Array(N);
  const linArr = new Float64Array(N);
  const exArr = new Float64Array(N);
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
      // **面ごとの拡散(共有面で両側の平均 = 保存的)。**
      // スカラーを渡したときは 4 面とも同値なので、従来と厳密に一致する
      const dC = diffusivity ? diffAt(i) : 0;
      const dE = diffusivity ? 0.5 * (dC + diffAt(iE)) : 0;
      const dW = diffusivity ? 0.5 * (dC + diffAt(iW)) : 0;
      const dN = diffusivity && iN >= 0 ? 0.5 * (dC + diffAt(iN)) : 0;
      const dS = diffusivity && iS >= 0 ? 0.5 * (dC + diffAt(iS)) : 0;
      const outRate =
        (lenMeridionalM * (Math.max(0, unE) + Math.max(0, -unW)) +
          lenN * Math.max(0, unN) +
          lenS * Math.max(0, -unS)) /
          area +
        (diffusivity
          ? (lenMeridionalM * (dE + dW)) / (area * dxC) +
            (lenN * dN + lenS * dS) / (area * dyCenterM)
          : 0);
      outRateArr[i] = outRate;

      // 係数を隣ごとに分けて持つ。方程式は
      //   diag·w_i − cE·w_E − cW·w_W − cN·w_N − cS·w_S = S_i
      // で、diag = rate + ex + outRate。**すべて反復不変**である
      cEArr[i] = (lenMeridionalM * (Math.max(0, -unE) + dE / dxC)) / area;
      cWArr[i] = (lenMeridionalM * (Math.max(0, unW) + dW / dxC)) / area;
      cNArr[i] = iN >= 0 ? (lenN * (Math.max(0, -unN) + dN / dyCenterM)) / area : 0;
      cSArr[i] = iS >= 0 ? (lenS * (Math.max(0, unS) + dS / dyCenterM)) / area : 0;
      const rateI = Math.max(1e-6, condensationRatePerMonth[i] ?? 0);
      const linI = linRate ? Math.max(0, linRate[i] ?? 0) : 0;
      const exI = vExport ? Math.max(0, vExport[i] ?? 0) : 0;
      rateArr[i] = rateI;
      linArr[i] = linI;
      exArr[i] = exI;
      // 凝結する枝の対角。閾値ありのときは掃引ごとに枝を選び直す。
      // 背景凝結 lin は枝に依らず常に効く(だから両方の枝の対角に入る)
      diagArr[i] = rateI + linI + exI + outRate;
    }
  }

  // ---- 行ごとの周期三重対角の分解を先に作る ----
  // **経度方向を陰的に解く(線緩和)**ための下ごしらえ。
  //
  // なぜ要るか(2026-08-09 の診断): 緯度 89.5° では dx = a·Δλ·cos(lat) ≈ 970 m
  // まで縮むので、拡散の結合 K·Δt/dx² が 4.1e6 に達する(赤道は 320)。
  // 極の 1 行は事実上「無限に伝導する」状態で、点緩和では 1 掃引につき
  // 1 セルしか情報が進まない。**行を丸ごと直接解けば、この剛性は消える。**
  //
  // 行の行列は風と格子だけで決まり反復では変わらないので、分解は 1 度でよい。
  // 周期境界(経度)は Sherman–Morrison で扱う。
  //
  // **閾値凝結(capacity)でも線緩和を使う。** C = rate·max(0, W − cap) は
  // 非線形なので分解を使い回せないが、現在値から枝(W > cap か)を選んで
  // 半陰的に解けばよい。分解は掃引ごとに作り直す — 分解も求解も同じ O(W) なので
  // 1 掃引あたりの費用は 2 倍以内に収まる。
  // (2026-08-04 に閾値凝結を棄却したときのソルバは点緩和で、しかも
  //  収束判定が壊れていた。ここを直して測り直すために要る)
  const denArr = new Float64Array(N);
  const cpArr = new Float64Array(N);
  const zArr = new Float64Array(N);
  const gammaArr = new Float64Array(H);
  const rowDiag = new Float64Array(W);
  const rowZTmp = new Float64Array(W);

  /** 行 row の周期三重対角を分解する。対角は rowDiag から読む */
  const factorizeRow = (row: number): void => {
    const base = row * W;
    const gamma = -(rowDiag[0] ?? 1);
    gammaArr[row] = gamma;
    const bp = (col: number): number => {
      const d = rowDiag[col] ?? 1;
      if (col === 0) return d - gamma;
      if (col === W - 1) {
        const cLast = -(cEArr[base + W - 1] ?? 0);
        const aFirst = -(cWArr[base] ?? 0);
        return d - (cLast * aFirst) / gamma;
      }
      return d;
    };
    let prevCp = 0;
    for (let col = 0; col < W; col++) {
      const a = -(cWArr[base + col] ?? 0);
      const c = -(cEArr[base + col] ?? 0);
      const den = bp(col) - (col === 0 ? 0 : a * prevCp);
      denArr[base + col] = den;
      const cp = den !== 0 ? c / den : 0;
      cpArr[base + col] = cp;
      prevCp = cp;
    }
    // u = [gamma, 0, …, 0, c_{W−1}] に対する解 z
    rowZTmp.fill(0);
    rowZTmp[0] = gamma;
    rowZTmp[W - 1] = -(cEArr[base + W - 1] ?? 0);
    let prev = 0;
    for (let col = 0; col < W; col++) {
      const a = -(cWArr[base + col] ?? 0);
      const den = denArr[base + col] ?? 1;
      const val = ((rowZTmp[col] ?? 0) - (col === 0 ? 0 : a * prev)) / (den !== 0 ? den : 1);
      zArr[base + col] = val;
      prev = val;
    }
    for (let col = W - 2; col >= 0; col--) {
      zArr[base + col] =
        (zArr[base + col] ?? 0) - (cpArr[base + col] ?? 0) * (zArr[base + col + 1] ?? 0);
    }
  };

  // 閾値なしなら対角は反復不変なので、分解は 1 度だけ作る(床も枝を持つ)
  if (!capacity && !linFloor) {
    for (let row = 0; row < H; row++) {
      const base = row * W;
      for (let col = 0; col < W; col++) rowDiag[col] = diagArr[base + col] ?? 1;
      factorizeRow(row);
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
  // 線緩和の作業配列(行ごとに使い回す)
  const rowRhs = new Float64Array(W);
  const rowY = new Float64Array(W);

  // ============================================================
  // 線形経路: 線緩和を前処理に使う BiCGSTAB(2026-08-23、積み残し 11)
  // ============================================================
  //
  // **なぜ解き方を変えたか**(docs/実験記録_輸送ソルバの高速化_2026-08-23.md):
  //   閾値凝結が無いとき、この系は **A w = S の線形方程式**である
  //   (床 max(0,·) は不動点では不活性 — A は M 行列で S ≥ 0 なら解も ≥ 0)。
  //   地球 1° の実測で、線緩和 SOR の縮小比は **0.93/掃引**しかなく、
  //   1 評価あたり 228 回 × 平均 145 掃引 × 1.6ms = **55 秒 = 全体の 29%** を
  //   占めていた。ω を最適値(1.8)へ寄せても 1.34 倍、実装の詰め
  //   (逆数の先取り・残差評価の間引き)を足しても 1.75 倍で頭打ち。
  //   **残りは反復数にしかない。**
  //   線緩和 2 掃引を前処理にした BiCGSTAB は、同じ方程式を **2.69 倍少ない
  //   掃引**(1 評価で 33,162 → 12,308)で解く。輸送部分は 55.0 → 25.1 秒
  //   (2.2 倍)、1 評価の全体は **1.26〜1.32 倍**になった。
  //   採点は動かない(ケッペン小 43.8% / 大 74.4% / 年降水 RMSE 608mm が一致)。
  //
  // **不動点は変わらない。** A も S も収束判定
  // (max|S − C(W) − ∇·(WV)| / 平均S ≤ tolerance)も 1 ビットも変えていない。
  // 違うのは同じ解へ寄る道筋だけで、ω が答えを変えないのと同じ理由である。
  //
  // **なぜ GPU にしなかったか**: この掃引は赤黒 SOR ではなく、行ごとの
  // 周期三重対角を直接解く線緩和である。列方向(Thomas 漸化式)も
  // 行方向(ガウス=ザイデル)も逐次なので、1 掃引の中で並列にできるのは
  // 月の 12 本だけ — ディスパッチには 3 桁足りない。GPU へ載せるには
  // 赤黒化(= 極の剛性で破綻)か PCR + zebra への作り替えが要り、
  // さらに f32 では下の同値要求(相対 1e-6)に届かない。
  // 輸送は全体の 29% なので上限は 1.4 倍しかなく、**危険な作り替えに
  // 見合わない**と判断した(較正は並列プロセスで回るので CPU の利得は
  // そのまま掛かるが、GPU は EBM と取り合いになる、という事情もある)。
  //
  // 前処理は**零から固定回数だけ掃く**ので、線緩和が発散する配置
  // (拡散の無い純移流)でも数値が爆発することはない。ただし**前処理として
  // 有害にはなる** — 過緩和した掃引は誤差を増幅する演算子なので、そのまま
  // 使うと純移流で 30 倍遅くなる(実測)。だから ω は下の試し打ちで選ぶ。
  // それでも BiCGSTAB は破綻しうる(ρ→0 / ω→0)ので、**破綻・非有限・
  // 予算超過はすべて従来の線緩和へ落とす**。収束しない解は黙って返さない。

  /** 前処理に使う線緩和の掃引数(実測で 2 が最良: k=1 で 1.39s、2 で 0.57s、4 で 0.61s) */
  const PRECOND_SWEEPS = 2;
  /**
   * 前処理の ω の候補。**配置ごとに実測で選ぶ**(下の「ω の安全性を試し打ちする」)。
   * 先頭が試す値、末尾が安全側の値。
   *
   * 固定できない理由は従来の線緩和とまったく同じで、**拡散支配か移流支配かで
   * 逆転する**からである(2026-08-23 の実測、1° 合成場):
   *   拡散 0      ω=1.6 で 1303 掃引 / ω=1.0 で **30 掃引**
   *   拡散 3e6    ω=1.6 で **108 掃引** / ω=1.0 で 206 掃引
   * 過緩和した線緩和は移流支配では発散するので、2 掃引だけ掛けても
   * **誤差を増幅する演算子**になり、前処理として害になる。
   */
  const PRECOND_OMEGAS = [1.6, 1.0];
  /** Krylov に賭ける掃引の上限。これを超えたら線緩和へ落とす(無駄打ちを短く切る) */
  const KRYLOV_SWEEP_BUDGET = 2000;

  /**
   * 線緩和 1 掃引を任意の右辺へ適用する(前処理用)。
   * 本体のループと違い **床で切らない** — ここで解くのは補正量であって
   * 水蒸気量ではないので、負を許さないと前処理にならない。
   */
  const relaxSweepInto = (
    x: Float64Array,
    rhs: Float64Array,
    omega: number,
    forward: boolean,
  ): void => {
    for (let rr = 0; rr < H; rr++) {
      const row = forward ? rr : H - 1 - rr;
      const base = row * W;
      for (let col = 0; col < W; col++) {
        const i = base + col;
        const north = row > 0 ? (cNArr[i] ?? 0) * (x[i - W] ?? 0) : 0;
        const south = row < H - 1 ? (cSArr[i] ?? 0) * (x[i + W] ?? 0) : 0;
        rowRhs[col] = (rhs[i] ?? 0) + north + south;
      }
      let prev = 0;
      for (let col = 0; col < W; col++) {
        const a = -(cWArr[base + col] ?? 0);
        const den = denArr[base + col] ?? 1;
        const val = ((rowRhs[col] ?? 0) - (col === 0 ? 0 : a * prev)) / (den !== 0 ? den : 1);
        rowY[col] = val;
        prev = val;
      }
      for (let col = W - 2; col >= 0; col--) {
        rowY[col] = (rowY[col] ?? 0) - (cpArr[base + col] ?? 0) * (rowY[col + 1] ?? 0);
      }
      const gamma = gammaArr[row] ?? -1;
      const aFirst = -(cWArr[base] ?? 0);
      const num = (rowY[0] ?? 0) + (aFirst * (rowY[W - 1] ?? 0)) / gamma;
      const denom = 1 + (zArr[base] ?? 0) + (aFirst * (zArr[base + W - 1] ?? 0)) / gamma;
      const fac = denom !== 0 ? num / denom : 0;
      for (let col = 0; col < W; col++) {
        const i = base + col;
        x[i] = (x[i] ?? 0) + omega * ((rowY[col] ?? 0) - fac * (zArr[i] ?? 0) - (x[i] ?? 0));
      }
    }
  };

  /** y ← A x。**本体の掃引が使う係数そのもの**(別の離散化を持ち込まない) */
  const applyA = (x: Float64Array, y: Float64Array): void => {
    for (let row = 0; row < H; row++) {
      const base = row * W;
      for (let col = 0; col < W; col++) {
        const i = base + col;
        const iE = base + (col + 1 === W ? 0 : col + 1);
        const iW = base + (col === 0 ? W - 1 : col - 1);
        let acc =
          (diagArr[i] ?? 0) * (x[i] ?? 0) -
          (cEArr[i] ?? 0) * (x[iE] ?? 0) -
          (cWArr[i] ?? 0) * (x[iW] ?? 0);
        if (row > 0) acc -= (cNArr[i] ?? 0) * (x[i - W] ?? 0);
        if (row < H - 1) acc -= (cSArr[i] ?? 0) * (x[i + W] ?? 0);
        y[i] = acc;
      }
    }
  };

  /** 無次元残差 max|v| / 平均S。**NaN を素通りさせない**書き方にする */
  const scaledMaxAbs = (v: Float64Array): number => {
    let m = 0;
    for (let i = 0; i < N; i++) {
      const d = Math.abs(v[i] ?? 0);
      if (!(d <= m)) m = d;
    }
    return m / meanSource;
  };

  const dotOf = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < N; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
    return s;
  };

  // ω を明示された呼び出しは従来経路へ回す(ω の掃引が測っているのは
  // 線緩和そのものなので、Krylov に化けると測定の意味が変わる)
  const solverMode = TRANSPORT_SOLVER_OVERRIDE.mode ?? options.solver ?? 'auto';
  const useKrylov =
    capacity === null &&
    linFloor === null &&
    solverMode === 'auto' &&
    options.relaxation === undefined;
  let krylovDone = false;
  let krylovSweeps = 0;
  if (useKrylov) {
    const scratch = new Float64Array(8 * N);
    const rVec = scratch.subarray(0, N);
    const rHat = scratch.subarray(N, 2 * N);
    const pVec = scratch.subarray(2 * N, 3 * N);
    const vVec = scratch.subarray(3 * N, 4 * N);
    const sVec = scratch.subarray(4 * N, 5 * N);
    const tVec = scratch.subarray(5 * N, 6 * N);
    const pHat = scratch.subarray(6 * N, 7 * N);
    const sHat = scratch.subarray(7 * N, 8 * N);
    let precondOmega = PRECOND_OMEGAS[0] ?? 1.6;
    const applyPrecond = (rhs: Float64Array, out: Float64Array, omega: number): void => {
      out.fill(0);
      for (let j = 0; j < PRECOND_SWEEPS; j++) relaxSweepInto(out, rhs, omega, j % 2 === 0);
      krylovSweeps += PRECOND_SWEEPS;
    };
    const precond = (rhs: Float64Array, out: Float64Array): void =>
      applyPrecond(rhs, out, precondOmega);
    applyA(cur, vVec);
    for (let i = 0; i < N; i++) rVec[i] = (sourceMmPerMonth[i] ?? 0) - (vVec[i] ?? 0);
    rHat.set(rVec);
    const res0 = scaledMaxAbs(rVec);
    // **参照実装より緩い解を返さない。** 許容差 1e-5 で止めた解はそれ自体が
    // 厳密解から 1e-6 ほど離れており(scripts/diag_transport_equiv.ts の
    // 「物差し」節)、止め方が違えばその範囲で答えがずれる。Krylov は
    // 1 桁詰めるのが安い(実測 +2 割の掃引)ので、**内側の目標を 1 桁厳しく
    // 取って**、返す場を従来より厳密解へ寄せる。届かなければ許容差そのもので
    // 受ける(下の最終確認)。
    const innerTol = tolerance * 0.1;
    if (Number.isFinite(res0) && res0 > innerTol) {
      // ---- ω の安全性を試し打ちする(同次反復の増幅率)----
      //
      // 見るのは「誤差だけを掃いたとき縮むか」= 右辺を 0 にした緩和
      //   e ← G_ω e     (relaxSweepInto に rhs = 0 を渡すとこれになる)
      // で、**過緩和が発散する配置では増幅率が 1 を超える**。
      // 前処理として残差を減らせるかを 1 掃引で測る素朴な指標は使えない
      // (2026-08-23 に実測: 過緩和は 1 回だけ見ると常に負けて見え、
      //  拡散支配でも ω=1.0 を選んでしまい 2 倍損をした)。
      //
      // 判定は**慣らし 1 巡の後の 1 巡**(前進 + 後退)で行う。実測の切れ目は
      // 拡散 1e5(増幅 2.4 〜 3.6)と 3e5(0.60 〜 0.98)の間にあり、
      // ω=1.6 が有利になる境目と一致する。
      // 種は決定的(乱数を使わない = 同じ入力で同じ結果)。
      // 費用は 4 掃引で、krylovSweeps に足して隠さない。
      {
        const trial = PRECOND_OMEGAS[0] ?? 1.6;
        const safe = PRECOND_OMEGAS[PRECOND_OMEGAS.length - 1] ?? 1.0;
        sVec.fill(0); // 同次(右辺 0)
        for (let i = 0; i < N; i++) sHat[i] = Math.sin(i * 0.7) + Math.cos(i * 0.13);
        let growth = 1;
        for (let k = 0; k < 4; k++) {
          const before = scaledMaxAbs(sHat);
          relaxSweepInto(sHat, sVec, trial, k % 2 === 0);
          const after = scaledMaxAbs(sHat);
          if (k >= 2) growth *= after / Math.max(1e-300, before);
        }
        krylovSweeps += 4;
        precondOmega = Number.isFinite(growth) && growth < 1 ? trial : safe;
      }
      let rho = 1;
      let alpha = 1;
      let omegaK = 1;
      pVec.fill(0);
      vVec.fill(0);
      const budget = Math.min(maxIterations, KRYLOV_SWEEP_BUDGET);
      while (krylovSweeps + 2 * PRECOND_SWEEPS <= budget) {
        const rhoNew = dotOf(rHat, rVec);
        if (!Number.isFinite(rhoNew) || rhoNew === 0) break;
        const beta = (rhoNew / rho) * (alpha / omegaK);
        if (!Number.isFinite(beta)) break;
        for (let i = 0; i < N; i++) {
          pVec[i] = (rVec[i] ?? 0) + beta * ((pVec[i] ?? 0) - omegaK * (vVec[i] ?? 0));
        }
        rho = rhoNew;
        precond(pVec, pHat);
        applyA(pHat, vVec);
        const denAlpha = dotOf(rHat, vVec);
        if (!Number.isFinite(denAlpha) || denAlpha === 0) break;
        alpha = rho / denAlpha;
        for (let i = 0; i < N; i++) sVec[i] = (rVec[i] ?? 0) - alpha * (vVec[i] ?? 0);
        if (scaledMaxAbs(sVec) <= innerTol) {
          for (let i = 0; i < N; i++) cur[i] = (cur[i] ?? 0) + alpha * (pHat[i] ?? 0);
          break;
        }
        precond(sVec, sHat);
        applyA(sHat, tVec);
        const tt = dotOf(tVec, tVec);
        if (!Number.isFinite(tt) || tt === 0) break;
        omegaK = dotOf(tVec, sVec) / tt;
        if (!Number.isFinite(omegaK) || omegaK === 0) break;
        for (let i = 0; i < N; i++) {
          cur[i] = (cur[i] ?? 0) + alpha * (pHat[i] ?? 0) + omegaK * (sHat[i] ?? 0);
          rVec[i] = (sVec[i] ?? 0) - omegaK * (tVec[i] ?? 0);
        }
        const res = scaledMaxAbs(rVec);
        if (!Number.isFinite(res) || res > 1e6 * res0) break; // 破綻
        if (res <= innerTol) break;
      }
    }
    {
      // **返す場そのもので確かめ直す。** 漸化式で持ち回した残差は丸めで
      // 真の残差から離れうるし、床で切った後の残差でなければ意味がない。
      // 破綻して途中で抜けた場合もここで落ちる(黙って採用しない)
      for (let i = 0; i < N; i++) if (!((cur[i] ?? 0) >= 0)) cur[i] = 0;
      applyA(cur, vVec);
      for (let i = 0; i < N; i++) vVec[i] = (sourceMmPerMonth[i] ?? 0) - (vVec[i] ?? 0);
      const finalRes = scaledMaxAbs(vVec);
      if (Number.isFinite(finalRes) && finalRes <= tolerance) {
        residual = finalRes;
        converged = true;
        krylovDone = true;
        iterations = krylovSweeps;
      }
    }
    // **収束を確かめられなければ従来の線緩和へ落とす。**
    // 初期値へ戻すのは、途中で止めた Krylov の反復子から線緩和を始めると
    // 「どこから来た解か」が実行ごとに変わりうるため(決定性を保つ)
    if (!krylovDone) cur.set(initial);
  }

  let sweeps = 0;
  // **Krylov で解けたときは従来の線緩和には入らない**(同じ方程式の別解法)。
  // 落ちてきたときは 1 から回し、費用は krylovSweeps を足して報告する
  for (let it = krylovDone ? maxIterations + 1 : 1; it <= maxIterations; it++) {
    sweeps++;
    iterations = krylovSweeps + sweeps;
    let maxImbalance = 0;
    // 行の掃引順を交互にする(南北方向の情報は行から行へ伝わるので、
    // 風向と揃った掃引が来る回で一気に進む)。決定的なので再現する。
    // 経度方向は行の中で直接解くので、列の順序は答えに影響しない
    const rowForward = it % 2 === 1;
    for (let rr = 0; rr < H; rr++) {
      const row = rowForward ? rr : H - 1 - rr;
      {
        // ---- 行を丸ごと解く(経度方向は陰的)----
        const base = row * W;
        for (let col = 0; col < W; col++) {
          const i = base + col;
          const iN = row > 0 ? i - W : -1;
          const iS = row < H - 1 ? i + W : -1;
          const wi = cur[i] ?? 0;
          const wN = iN >= 0 ? (cur[iN] ?? 0) : 0;
          const wS = iS >= 0 ? (cur[iS] ?? 0) : 0;
          let rhs = (sourceMmPerMonth[i] ?? 0) + (cNArr[i] ?? 0) * wN + (cSArr[i] ?? 0) * wS;
          // 閾値ありのときは現在値から枝を選ぶ(半陰的)。
          //   凝結する枝: diag = rate + ex + outRate、rhs に + rate·cap
          //   通過する枝: diag = ex + outRate（凝結しない = 水は下流へ)
          let diagI = diagArr[i] ?? 1;
          let condNow = ((rateArr[i] ?? 0) + (linArr[i] ?? 0)) * wi;
          if (capacity) {
            const cap = Math.max(0, capacity[i] ?? 0);
            if (wi > cap) {
              rhs += (rateArr[i] ?? 0) * cap;
              condNow = (rateArr[i] ?? 0) * (wi - cap) + (linArr[i] ?? 0) * wi;
            } else {
              // 通過する枝でも背景凝結 lin は残る(二成分閉包)
              diagI = Math.max(1e-9, (linArr[i] ?? 0) + (exArr[i] ?? 0) + (outRateArr[i] ?? 0));
              condNow = (linArr[i] ?? 0) * wi;
            }
          }
          // 床(W の熱力学係留): lin·W → lin·(W − floor)⁺。
          // 上の cap 両枝はどちらも lin を対角と condNow に含むので、
          // ここで床の枝ぶんだけ差し引けば両者と合成できる
          if (linFloor) {
            const fl = Math.max(0, linFloor[i] ?? 0);
            if (fl > 0) {
              if (wi > fl) {
                rhs += (linArr[i] ?? 0) * fl;
                condNow -= (linArr[i] ?? 0) * fl;
              } else {
                diagI = Math.max(1e-9, diagI - (linArr[i] ?? 0));
                condNow -= (linArr[i] ?? 0) * wi;
              }
            }
          }
          rowRhs[col] = rhs;
          rowDiag[col] = diagI;
          // **反復前の残差**(南北は既知、東西は現在値で評価)
          const absImb = Math.abs(
            (sourceMmPerMonth[i] ?? 0) +
              (cNArr[i] ?? 0) * wN +
              (cSArr[i] ?? 0) * wS +
              (cEArr[i] ?? 0) * (cur[base + ((col + 1) % W)] ?? 0) +
              (cWArr[i] ?? 0) * (cur[base + ((col - 1 + W) % W)] ?? 0) -
              condNow -
              (exArr[i] ?? 0) * wi -
              (outRateArr[i] ?? 0) * wi,
          );
          // **NaN を素通りさせない**
          if (!(absImb <= maxImbalance)) maxImbalance = absImb;
        }
        if (capacity || linFloor) factorizeRow(row);
        // 周期三重対角を解く(分解は反復不変なので使い回す)
        let prev = 0;
        for (let col = 0; col < W; col++) {
          const a = -(cWArr[base + col] ?? 0);
          const den = denArr[base + col] ?? 1;
          const val = ((rowRhs[col] ?? 0) - (col === 0 ? 0 : a * prev)) / (den !== 0 ? den : 1);
          rowY[col] = val;
          prev = val;
        }
        for (let col = W - 2; col >= 0; col--) {
          rowY[col] = (rowY[col] ?? 0) - (cpArr[base + col] ?? 0) * (rowY[col + 1] ?? 0);
        }
        const gamma = gammaArr[row] ?? -1;
        const aFirst = -(cWArr[base] ?? 0);
        const num = (rowY[0] ?? 0) + (aFirst * (rowY[W - 1] ?? 0)) / gamma;
        const denom =
          1 + (zArr[base] ?? 0) + (aFirst * (zArr[base + W - 1] ?? 0)) / gamma;
        const fac = denom !== 0 ? num / denom : 0;
        for (let col = 0; col < W; col++) {
          const i = base + col;
          const wLine = (rowY[col] ?? 0) - fac * (zArr[i] ?? 0);
          const wi = cur[i] ?? 0;
          // 逐次過緩和。**不動点は変わらない**
          cur[i] = Math.max(0, wi + relaxation * (wLine - wi));
        }
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
    // **非負性はモデルの不変量**(風上流束を使う理由そのもの)。線緩和は
    // 掃引ごとに床で切るので既に非負だが、Krylov の反復子は補正の重ね合わせ
    // なので、丸めの範囲で負に出うる。ここで一度だけ床で受ける
    // (不動点は S ≥ 0 と M 行列性から非負なので、床は答えを変えない)
    const wi = Math.max(0, cur[i] ?? 0);
    waterMm[i] = wi;
    // 凝結で除いた水は必ず同じセルの降水に計上する(漏れを作らない)。
    // 閾値ありのときは「持てる量を超えたぶん」だけが降る
    const excess = capacity ? Math.max(0, wi - Math.max(0, capacity[i] ?? 0)) : wi;
    // 床(熱力学係留)ありなら lin は床上の超過分だけ凝結する
    const linBase = linFloor ? Math.max(0, wi - Math.max(0, linFloor[i] ?? 0)) : wi;
    condensationMm[i] =
      Math.max(1e-6, condensationRatePerMonth[i] ?? 0) * excess +
      (linRate ? Math.max(0, linRate[i] ?? 0) * linBase : 0);
    exportedMm[i] = vExport ? Math.max(0, vExport[i] ?? 0) * wi : 0;
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

// ===================================================================
// 水蒸気の 2 層化(段 L-0、2026-09-06。docs/計画_水蒸気の2層化_2026-09-06.md)
//
// 境界層 W_b と自由対流圏 W_f を、それぞれの風で別々に運ぶ。層の間の交換は
// 「鉛直輸出」の口(verticalExportRatePerMonth)をそのまま使う:
//   境界層の解では σ_up·W_b が線形シンクとして抜け(exportedMm)、それを
//   自由対流圏の**源**に渡す。自由対流圏では σ_dn·W_f が抜けて境界層の源へ戻る。
// 8/4 に「抜いた水の返し先が無い」で棄却された鉛直輸出は、2 層にすると
// 返し先(もう一方の層)が定義される。層の間は Gauss–Seidel で回し、
// 往復する水(X_dn)の変化が平均源の tol 倍を切ったら止める。
//
// 保存: 収束すれば S = C_b + C_f + 面フラックスの和 が全球で閉じる
// (テスト tests/unit/sim/two_layer.test.ts で固定)。
// ===================================================================

export interface LayerClosure {
  /** [cell] 対流(閾値超過)の凝結率 1/月。閾値が無ければ C = rate·W */
  condensationRatePerMonth: Float32Array;
  linearRatePerMonth?: ArrayLike<number>;
  holdingCapacityMm?: ArrayLike<number>;
  linearFloorMm?: ArrayLike<number>;
}

export interface TwoLayerOptions {
  diffusivityM2PerS?: number | ArrayLike<number>;
  maxIterations?: number;
  /** 内側の輸送ソルバの残差許容(単層と同じ既定) */
  tolerance?: number;
  /** 層間の往復水の収束判定: max|ΔX_dn| ≤ tol × 平均源(既定 1e-4) */
  layerTolerance?: number;
  /** Gauss–Seidel の上限回数(既定 20) */
  maxPasses?: number;
  initialBoundaryMm?: ArrayLike<number>;
  initialFreeMm?: ArrayLike<number>;
}

export interface TwoLayerResult {
  /** [cell] W_b + W_f */
  waterMm: Float32Array;
  waterBoundaryMm: Float32Array;
  waterFreeMm: Float32Array;
  /** [cell] C_b + C_f = 降水 */
  condensationMm: Float32Array;
  condensationBoundaryMm: Float32Array;
  condensationFreeMm: Float32Array;
  /** [cell] 最後の往復: 上向き X_up = σ_up·W_b、下向き X_dn = σ_dn·W_f */
  exchangeUpMm: Float32Array;
  exchangeDownMm: Float32Array;
  passes: number;
  /** 層間の往復が収束したか */
  converged: boolean;
  /** 内側の輸送ソルバが収束しなかった回数と最悪残差(層ごとに数える) */
  nonConvergedSolves: number;
  worstResidual: number;
  iterations: number;
}

export function solveTwoLayerTransport(
  grid: Grid,
  radiusKm: number,
  windBoundary: { u: Float32Array; v: Float32Array },
  windFree: { u: Float32Array; v: Float32Array },
  sourceMmPerMonth: Float32Array,
  closureBoundary: LayerClosure,
  closureFree: LayerClosure,
  sigmaUpPerMonth: Float32Array,
  sigmaDownPerMonth: Float32Array,
  options: TwoLayerOptions = {},
): TwoLayerResult {
  const N = grid.cellCount;
  const tol = options.layerTolerance ?? 1e-4;
  const maxPasses = options.maxPasses ?? 20;
  // 平均源(面積重み)— 収束判定の尺
  let sSum = 0;
  let wSum = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = Math.max(0, Math.cos((latDegOfRow(grid, row) * Math.PI) / 180));
    for (let col = 0; col < grid.widthCells; col++) {
      sSum += w * (sourceMmPerMonth[row * grid.widthCells + col] ?? 0);
      wSum += w;
    }
  }
  const meanS = Math.max(1e-9, sSum / Math.max(1e-9, wSum));

  const srcB = new Float32Array(N);
  let xDown: ArrayLike<number> = new Float32Array(N);
  let prevB: ArrayLike<number> | undefined = options.initialBoundaryMm;
  let prevF: ArrayLike<number> | undefined = options.initialFreeMm;
  let rb: MoistureTransportResult | null = null;
  let rf: MoistureTransportResult | null = null;
  let nonConverged = 0;
  let worst = 0;
  let iterations = 0;
  let converged = false;
  let passes = 0;
  const common = {
    ...(options.diffusivityM2PerS !== undefined ? { diffusivityM2PerS: options.diffusivityM2PerS } : {}),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
  };
  const closureOpts = (c: LayerClosure): Partial<MoistureTransportOptions> => ({
    ...(c.linearRatePerMonth ? { linearRatePerMonth: c.linearRatePerMonth } : {}),
    ...(c.holdingCapacityMm ? { holdingCapacityMm: c.holdingCapacityMm } : {}),
    ...(c.linearFloorMm ? { linearFloorMm: c.linearFloorMm } : {}),
  });
  for (passes = 1; passes <= maxPasses; passes++) {
    for (let i = 0; i < N; i++) srcB[i] = (sourceMmPerMonth[i] ?? 0) + (xDown[i] ?? 0);
    rb = solveMoistureTransport(grid, radiusKm, windBoundary.u, windBoundary.v, srcB, closureBoundary.condensationRatePerMonth, {
      ...common,
      ...closureOpts(closureBoundary),
      verticalExportRatePerMonth: sigmaUpPerMonth,
      ...(prevB ? { initialGuessMm: prevB } : {}),
    });
    rf = solveMoistureTransport(grid, radiusKm, windFree.u, windFree.v, rb.exportedMm, closureFree.condensationRatePerMonth, {
      ...common,
      ...closureOpts(closureFree),
      verticalExportRatePerMonth: sigmaDownPerMonth,
      ...(prevF ? { initialGuessMm: prevF } : {}),
    });
    for (const r of [rb, rf]) {
      iterations += r.iterations;
      if (!r.converged) {
        nonConverged++;
        worst = Math.max(worst, r.residual);
      }
    }
    let dMax = 0;
    for (let i = 0; i < N; i++) dMax = Math.max(dMax, Math.abs((rf.exportedMm[i] ?? 0) - (xDown[i] ?? 0)));
    xDown = rf.exportedMm;
    prevB = rb.waterMm;
    prevF = rf.waterMm;
    if (dMax <= tol * meanS) {
      converged = true;
      break;
    }
  }
  if (!rb || !rf) throw new Error('2 層輸送: 反復が 1 回も走らなかった');
  if (passes > maxPasses) passes = maxPasses;
  const waterMm = new Float32Array(N);
  const condensationMm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    waterMm[i] = (rb.waterMm[i] ?? 0) + (rf.waterMm[i] ?? 0);
    condensationMm[i] = (rb.condensationMm[i] ?? 0) + (rf.condensationMm[i] ?? 0);
  }
  return {
    waterMm,
    waterBoundaryMm: rb.waterMm,
    waterFreeMm: rf.waterMm,
    condensationMm,
    condensationBoundaryMm: rb.condensationMm,
    condensationFreeMm: rf.condensationMm,
    exchangeUpMm: rb.exportedMm,
    exchangeDownMm: rf.exportedMm,
    passes,
    converged,
    nonConvergedSolves: nonConverged,
    worstResidual: worst,
    iterations,
  };
}
