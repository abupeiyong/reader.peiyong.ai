// 音标学习页(#/phonetics):英音 / 美音切换,元音画在元音图上按舌位摆,
// 辅音按发音方式分组。点音标出声并展开例词,点例词逐词朗读 —— 发音走和查词同一条
// TTS 链路(ElevenLabs → melotts → 浏览器合成)。
import { useState } from "react";
import { Icon } from "../components/Icon";
import { speakWord, type Accent } from "../lib/speech";
import {
  ACCENT_CHARTS,
  CONSONANT_GROUPS,
  VOWEL_QUAD_POINTS,
  phonemeSpeech,
  type AccentChart,
  type Phoneme,
} from "../lib/phonetics";

/** 当前展开的音素:同一时刻只开一个,所以要连所在分组一起记 */
interface Selection {
  group: string;
  ipa: string;
}

export default function PhoneticsPage() {
  const [chart, setChart] = useState<AccentChart>(ACCENT_CHARTS[0]);
  const [sel, setSel] = useState<Selection | null>(null);

  // 点音标 = 出声 + 展开例词。重复点同一个只是再听一次,例词不收起 ——
  // 不然想多听两遍就把刚打开的例词弄没了。
  const pick = (group: string, p: Phoneme, accent: Accent) => {
    setSel({ group, ipa: p.ipa });
    void speakWord(phonemeSpeech(p), accent);
  };

  const accent = chart.accent;
  const detailOf = (group: string, items: Phoneme[]) =>
    sel?.group === group ? items.find((p) => p.ipa === sel.ipa) : undefined;

  return (
    <div className="library">
      <header className="lib-header">
        <a className="lib-brand" href="#/">
          <Icon name="arrow-left" size={18} /> Library
        </a>
        <div className="lib-user">
          <a className="btn btn-ghost" href="#/settings">
            <Icon name="settings" /> Settings
          </a>
        </div>
      </header>

      <main className="lib-main">
        <div className="lib-toolbar">
          <h2>Phonetics</h2>
          <div className="lib-actions">
            {ACCENT_CHARTS.map((c) => (
              <button
                key={c.accent}
                className={`chip ${c.accent === accent ? "active" : ""}`}
                onClick={() => {
                  setChart(c);
                  setSel(null);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <p className="hint-text ipa-intro">
          Tap a symbol to hear the sound, then tap any example word to hear it in a real word — everything is spoken in
          the accent selected above. A symbol is read as a short cue plus its key word (“puh, pen”); sounds that cannot
          stand on their own in English, such as /ŋ/, are read as the key word alone.
        </p>

        <section className="chart-block">
          <div className="chart-title">Vowels · {chart.label} vowel diagram</div>
          <div className="vowel-wrap">
            <div className="vowel-axis-y">
              <span>Close</span>
              <span>Mid</span>
              <span>Open</span>
            </div>
            <div className="vowel-main">
              <div className="vowel-axis-x">
                <span>Front</span>
                <span>Central</span>
                <span>Back</span>
              </div>
              <div className="vowel-plot">
                <svg className="vowel-quad" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <polygon points={VOWEL_QUAD_POINTS} vectorEffect="non-scaling-stroke" />
                </svg>
                {chart.vowels.map((v) => (
                  <button
                    key={v.ipa}
                    className={`vowel-dot ${sel?.group === "vowels" && sel.ipa === v.ipa ? "active" : ""}`}
                    style={{ left: `${v.x}%`, top: `${v.y}%` }}
                    title={`/${v.ipa}/ as in ${v.keyword}`}
                    onClick={() => pick("vowels", v, accent)}
                  >
                    <span className="ipa-sym">{v.ipa}</span>
                    <span className="ipa-key">{v.keyword}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <PhonemeDetail phoneme={detailOf("vowels", chart.vowels)} accent={accent} />
        </section>

        <PhonemeSection
          title="Diphthongs"
          hint="One vowel sliding into another — the mouth keeps moving."
          group="diphthongs"
          items={chart.diphthongs}
          accent={accent}
          sel={sel}
          onPick={pick}
        />

        {CONSONANT_GROUPS.map((g) => (
          <PhonemeSection
            key={g.name}
            title={`Consonants · ${g.name}`}
            hint={g.hint}
            group={g.name}
            items={g.items}
            accent={accent}
            sel={sel}
            onPick={pick}
          />
        ))}
      </main>
    </div>
  );
}

/** 一组音素:方块网格 + 展开的例词 */
function PhonemeSection({
  title,
  hint,
  group,
  items,
  accent,
  sel,
  onPick,
}: {
  title: string;
  hint: string;
  group: string;
  items: Phoneme[];
  accent: Accent;
  sel: Selection | null;
  onPick: (group: string, p: Phoneme, accent: Accent) => void;
}) {
  const open = sel?.group === group ? items.find((p) => p.ipa === sel.ipa) : undefined;
  return (
    <section className="chart-block">
      <div className="chart-title">{title}</div>
      <p className="hint-text ipa-group-hint">{hint}</p>
      <div className="ipa-grid">
        {items.map((p) => (
          <button
            key={p.ipa}
            className={`ipa-tile ${open?.ipa === p.ipa ? "active" : ""}`}
            title={`/${p.ipa}/ as in ${p.keyword}`}
            onClick={() => onPick(group, p, accent)}
          >
            <span className="ipa-sym">{p.ipa}</span>
            <span className="ipa-key">{p.keyword}</span>
          </button>
        ))}
      </div>
      <PhonemeDetail phoneme={open} accent={accent} />
    </section>
  );
}

/** 展开的音素详情:再听一次音 + 点词朗读 */
function PhonemeDetail({ phoneme, accent }: { phoneme: Phoneme | undefined; accent: Accent }) {
  if (!phoneme) return null;
  return (
    <div className="ipa-detail">
      <button
        className="btn btn-sm"
        title="Play the sound again"
        onClick={() => void speakWord(phonemeSpeech(phoneme), accent)}
      >
        <Icon name="volume" /> /{phoneme.ipa}/
      </button>
      <div className="ipa-words">
        {phoneme.examples.map((w) => (
          <button key={w} className="ipa-word" title="Pronounce" onClick={() => void speakWord(w, accent)}>
            {w}
          </button>
        ))}
      </div>
    </div>
  );
}
