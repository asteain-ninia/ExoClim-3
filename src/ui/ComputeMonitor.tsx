// 実行中の進捗帯: 全体進捗・現在の段・中断。
//
// **途中経過の場は本表示(MapCanvas)に出す**(2026-08-03 の利用者判断)。
// 以前はここに別枠のサムネイルを置いていたが、同じものを二か所に出すより、
// 本表示がそのまま育っていくほうが分かりやすい。ここに残すのは
// 「いま何をしているか」と「止める手段」だけ。
//
// 表示が確定値でないことは、この帯が出ていること自体が示す。
// 帯が消えたときが確定値(教訓 §1: 未完成の場を答えと取り違えさせない)。

import { useEffect, useState } from 'react';
import { useResultsStore } from '@/store/results';
import { RUN_STAGE_LABELS } from '@/sim/run_control';

/**
 * これ以上進捗が来なければ「止まっている」と言う秒数。
 * 気温の途中経過はモデル内 1 年ごと(実測 約 10 秒)、進捗の文字列は
 * 1 か月ごと(約 1 秒)に来るので、45 秒の沈黙は明らかに異常。
 *
 * **なぜ要るか**: 2026-08-03、接続の破棄で isComputing が true のまま固まり、
 * ワーカーは終了済みなのに「計算中 16/26 年目」が永久に残る不具合が出た。
 * 黙って止まると利用者は「重いのかな」と待ち続けるしかない。
 * 停滞は必ず表に出す(GPU を別プロセスと取り合っている場合も同じ)。
 */
const STALL_SECONDS = 45;

export function ComputeMonitor({ onCancel }: { onCancel: () => void }) {
  const isComputing = useResultsStore((s) => s.isComputing);
  const progress = useResultsStore((s) => s.progress);
  const accelInfo = useResultsStore((s) => s.accelInfo);
  const lastProgressAt = useResultsStore((s) => s.lastProgressAt);

  // 沈黙を測るために自分で時計を回す(進捗が来ないと再描画されないため)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isComputing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isComputing]);

  if (!isComputing) return null;

  const silentSec = lastProgressAt === null ? 0 : Math.floor((now - lastProgressAt) / 1000);
  const stalled = silentSec >= STALL_SECONDS;

  const pct = progress ? Math.round(progress.overall * 100) : 0;
  const stageLabel = progress ? RUN_STAGE_LABELS[progress.stage] : '準備中';

  return (
    <section className="monitor" data-testid="compute-monitor">
      <div className="monitor-bar" role="progressbar" aria-valuenow={pct}>
        <div className="monitor-bar-fill" style={{ width: `${pct}%` }} />
        <span className="monitor-bar-text" data-testid="monitor-percent">
          {pct}%
        </span>
      </div>
      <div className="monitor-head">
        <span className="monitor-stage" data-testid="monitor-stage">
          {stageLabel}
          {progress?.detail ? ` — ${progress.detail}` : ''}
        </span>
        {/* GPU なのか CPU に落ちたのかは**走っている最中に**要る情報。
            落ちていたら待ち時間の桁が変わるので、完了まで黙っていてはいけない */}
        {accelInfo && (
          <span className="monitor-accel" data-testid="monitor-accel">
            {accelInfo}
          </span>
        )}
        <button className="monitor-cancel" onClick={onCancel} data-testid="cancel-button">
          中止
        </button>
      </div>
      {stalled && (
        <div className="monitor-note monitor-note--warn" data-testid="stall-note">
          <strong>{silentSec} 秒間、進捗が届いていません。</strong>{' '}
          GPU を別のプロセス(較正など)と取り合っているか、計算が中断された
          可能性があります。「中止」して押し直すと確実に作り直せます。
        </div>
      )}
      {progress?.budgetExtended && (
        <div className="monitor-note monitor-note--warn">
          許容差に届かなかったため予算を増やして計算し直しています。
          <strong>残り時間の見積もりは伸びます。</strong>
        </div>
      )}
    </section>
  );
}
