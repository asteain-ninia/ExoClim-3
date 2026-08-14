#!/usr/bin/env bash
# 「宣言だけして end_turn する」(報告寝落ち症)を機械的に禁止する Stop フック。
#
# 背景: docs/教訓.md §11。セッション a689aede は 44 回の end_turn で合計 77.8 時間、
# bfe3cfa8 は 322 回で 229.2 時間、機械を冷やしたまま利用者の入力を待って止まった。
# 止まる直前の文はほぼ必ず「次は〜します」という宣言だった。
#
# 利用者の要求(2026-08-14):
#   「終わりではきちんと停止しつつ、途中で停止しない。
#     待ちのときは待つ、待ちじゃないときは動く。」
#
# 停止を許す条件(上から順に判定):
#   0. /compact など通常の停止、および stop_hook_active(差し戻し済み)。
#      → **差し戻しは 1 ターンにつき 1 回まで。** 無限ループで利用者を閉じ込めない。
#         「本当に終わり」のときは、この 1 回を受けたあと 2 回目で止まれる。
#   1. .claude/停止        — 利用者の停止指示(reset_guard.sh が発話から自動検出)。
#   2. .claude/裁定待ち.md — AI が書いた、利用者の裁定が要る問い。
#   3. 追跡中の背景ジョブがある — 「待ちのときは待つ」。完了で必ず呼び戻される。
#      **口先で「待っています」と書いても通らない。** 実物のジョブが要る。
#      追跡されないジョブ(前世代の nohup 投げっぱなし)を待ちたいなら、
#      run_in_background で待機ジョブを立てて通知を armed にすること。
#   1 と 2 は次の利用者発話で自動的に消える(UserPromptSubmit フック)。

set -u

root="${CLAUDE_PROJECT_DIR:-e:/WORKSPACE/ExoClim-3}"
d="$root/.claude"
halt="$d/停止"
pending="$d/裁定待ち.md"
counter="$d/.自走カウンタ"
limit=30

payload=$(cat 2>/dev/null || true)

# 逃げ道 0: **通常の停止**であって自走の中断ではないもの(2026-08-14)。
# Stop フックは /clear・/compact・resume・利用者の中断でも発火する。
# 利用者は「1 セッションを長く使って自動 compact に任せる」運用なので、
# ここを塞ぐと運用そのものが壊れる。必ず通す。
# stop_hook_active は「すでに一度差し戻した」印。二重差し戻しをしない。
# 語は狭く採る。`clear` や `resume` のような一般語で照合すると、
# ペイロードのどこかに偶然現れただけで通過してしまい、穴になる。
# /clear と resume はセッションが終わる側なので差し戻しても実害がない。
case "$payload" in
  *'stop_hook_active":true'* | *'stop_hook_active": true'* | *compact*)
    exit 0
    ;;
esac

# 逃げ道 1: 利用者による強制解除
if [ -f "$halt" ]; then
  exit 0
fi

# 逃げ道 2: 裁定待ちの宣言がある
if [ -f "$pending" ]; then
  printf '{"systemMessage":"裁定待ちのため停止を許可しました (.claude/裁定待ち.md)"}\n'
  exit 0
fi

# 逃げ道 3: ハーネスが追跡している背景ジョブが動いている(2026-08-14 追加)。
#
# 前任の死因は「投げっぱなし」だった — nohup で投げて通知が来ない状態で
# end_turn していた。逆に run_in_background で投げたジョブは**完了時に必ず
# 呼び戻される**ので、そこで待つのは寝落ちではない。
#
# 口先では区別できないので機械で確かめる: このセッションの tasks ディレクトリに
# 10 分以内に更新されたファイルがあるか。文章で「待っています」と書いても
# 通らない。実際に追跡中のジョブが要る。
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$sid" ]; then
  for base in "${TEMP:-}" "${TMP:-}" "/c/Users/ASTEAI~1/AppData/Local/Temp"; do
    [ -n "$base" ] || continue
    tasks="$base/claude/e--WORKSPACE-ExoClim-3/$sid/tasks"
    [ -d "$tasks" ] || continue
    if [ -n "$(find "$tasks" -type f -mmin -10 2>/dev/null | head -1)" ]; then
      printf '{"systemMessage":"追跡中の背景ジョブがあるので停止を許可しました(完了時に呼び戻されます)"}\n'
      exit 0
    fi
    break
  done
fi

n=0
if [ -f "$counter" ]; then
  n=$(cat "$counter" 2>/dev/null || echo 0)
fi
case "$n" in
  '' | *[!0-9]*) n=0 ;;
esac
n=$((n + 1))
printf '%s' "$n" > "$counter"

# 暴走止め: 利用者の発話なしに limit 回続けて差し戻したら諦めて止まる
if [ "$n" -gt "$limit" ]; then
  printf '{"systemMessage":"自走の差し戻しが %s 回に達したので停止を許可しました。手が本当に尽きている可能性があります。"}\n' "$limit"
  exit 0
fi

printf '{"decision":"block","reason":"%s"}\n' "いま貴女はターンを終えようとしました。このプロジェクトでは報告はターンの終わりではありません。\\n\\n直前の自分の文を読み返してください。「次は〜します」「〜を実装します」「指示がなければ〜しておきます」と書いたなら、それは行動の代わりになりません。**その行動を、いま、この場で実行してください。**\\n\\n手が空いているように見えるときの確認順:\\n1. 待っている計算はあるか。あるなら run_in_background で待機ジョブを立てる — 完了で呼び戻されるので、そのターンは正しく終われます。**前景の sleep はハーネスが禁止しています。**\\n2. 直前に自分が宣言した次の一手はあるか。あるなら実行する。\\n3. 無いなら docs/ の検証待ち・保留項目から次の一手を選んで事前登録を書き、実行する。\\n\\n本当に利用者の裁定なしには進めないときだけ、.claude/裁定待ち.md に問いと既定案を書いてください。既定案が測れるものなら、問いを書いたうえで既定案を実行してから止まること。\\n\\nなお差し戻しは 1 ターン 1 回だけです。作業が本当に尽きているなら、次の停止は通ります。"
exit 0
