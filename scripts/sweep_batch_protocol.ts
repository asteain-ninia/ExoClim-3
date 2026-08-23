// 掃引バッチ実行器の「仕事」の型(掃引に固有の部分だけ)。
//
// スレッド間の共通プロトコル(GPU 要求の往復・BatchWorkerData)は
// scripts/gpu_batch_protocol.ts へ移した(2026-08-23、較正と共有するため)。
// ここに残すのは 1 仕事の指示 = 水準の指定だけ。結果は LevelReport
// (scripts/sweep_lib.ts)。値はすべて postMessage の構造化複製を通れる形に限る。

/** worker が受け取る 1 水準の指示 */
export interface SweepJob {
  key: string;
  value: number;
  targets: string[];
}
