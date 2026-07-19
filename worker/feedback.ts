// 朗读完整度反馈:参考文本与转写文本的词级对齐(LCS),纯确定性算法。
// MVP 定位是"诊断反馈"而非精确音素评分。
import type { RecordingFeedback } from "../shared/types";
import { tokenizeWords } from "./util";

export function computeFeedback(refText: string, transcript: string): RecordingFeedback {
  const ref = tokenizeWords(refText);
  const hyp = tokenizeWords(transcript);

  // LCS 对齐
  const m = ref.length;
  const n = hyp.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = ref[i - 1] === hyp[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯找出匹配词
  const matchedRef = new Set<number>();
  const matchedHyp = new Set<number>();
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (ref[i - 1] === hyp[j - 1]) {
      matchedRef.add(i - 1);
      matchedHyp.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const missed = ref.filter((_, idx) => !matchedRef.has(idx));
  const extra = hyp.filter((_, idx) => !matchedHyp.has(idx));
  const coverage = m === 0 ? 0 : Math.round((matchedRef.size / m) * 100);

  // 去重但保持顺序
  const dedupe = (arr: string[]) => [...new Set(arr)];
  const missedU = dedupe(missed);
  const extraU = dedupe(extra);

  let suggestions: string;
  if (m === 0) {
    suggestions = "参考文本为空,无法评估。";
  } else if (coverage >= 95) {
    suggestions = "非常完整!几乎没有漏读,继续保持,可以尝试提高语速或挑战更长的段落。";
  } else if (coverage >= 80) {
    suggestions =
      `整体不错,但有少量词没有被识别到:${missedU.slice(0, 8).join(", ")}。` +
      `建议单独朗读这些词,注意重音和元音发音。`;
  } else if (coverage >= 50) {
    suggestions =
      `完整度一般,较多词未被识别:${missedU.slice(0, 10).join(", ")}。` +
      `建议先放慢语速逐句跟读,确认每个单词的发音后再连读整段。`;
  } else {
    suggestions =
      "识别到的内容较少,可能是语速过快、离麦克风太远或环境噪音较大。建议靠近麦克风、放慢语速,先从单句开始练习。";
  }

  return {
    transcript,
    coverage,
    missed_words: missedU,
    extra_words: extraU,
    matched_count: matchedRef.size,
    ref_word_count: m,
    suggestions,
  };
}
