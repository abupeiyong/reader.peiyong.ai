// 音标学习页(#/phonetics):美音 IPA,元音画在元音图上按舌位摆,
// 辅音按发音方式分组。点音标出声并展开例词,点例词逐词朗读。
// 音标放的是入库的 IPA 标准录音(public/phonetics/,来自 Wikimedia Commons),没有录音的
// 音标和例词才走查词那条发音链路(有道词典录音 → ElevenLabs → melotts → 浏览器合成),
// 口音用 speakWord 的默认值 —— 美音。
import { useState } from "react";
import { Icon } from "../components/Icon";
import { playRecording, speakWord } from "../lib/speech";
import {
  CONSONANT_GROUPS,
  DIPHTHONGS,
  RECORDING_CREDIT,
  VOWELS,
  VOWEL_QUAD_POINTS,
  phonemeRecording,
  type Phoneme,
} from "../lib/phonetics";

/** 发这个音:先放标准录音,没有(双元音、/ɝ/)或者放不出来再退回 TTS 念代表词 */
async function pronounce(p: Phoneme) {
  const recording = phonemeRecording(p.ipa);
  // playRecording 要在点击的手势里同步调起 play(),所以别在它前面 await 任何东西
  if (recording && (await playRecording(recording))) return;
  await speakWord(p.keyword);
}

/** 当前展开的音素:同一时刻只开一个,所以要连所在分组一起记 */
interface Selection {
  group: string;
  ipa: string;
}

export default function PhoneticsPage() {
  const [sel, setSel] = useState<Selection | null>(null);

  // 点音标 = 出声 + 展开例词。重复点同一个只是再听一次,例词不收起 ——
  // 不然想多听两遍就把刚打开的例词弄没了。
  const pick = (group: string, p: Phoneme) => {
    setSel({ group, ipa: p.ipa });
    void pronounce(p);
  };

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
          <h2>Phonetics · American IPA</h2>
        </div>

        <p className="hint-text ipa-intro">
          Tap a symbol to hear the sound itself, then tap any example word to hear it inside a real word. Symbols play
          standard IPA recordings of native articulation — consonants are recorded between vowels, the way phonetics
          references demonstrate them. Diphthongs (and /ɝ/) have no single reference recording, so they are spoken as
          their key word, as are all example words — always in an American accent.
        </p>

        <section className="chart-block">
          <div className="chart-title">Vowels · American vowel diagram</div>
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
                {VOWELS.map((v) => (
                  <button
                    key={v.ipa}
                    className={`vowel-dot ${sel?.group === "vowels" && sel.ipa === v.ipa ? "active" : ""}`}
                    style={{ left: `${v.x}%`, top: `${v.y}%` }}
                    title={`/${v.ipa}/ as in ${v.keyword}`}
                    onClick={() => pick("vowels", v)}
                  >
                    <span className="ipa-sym">{v.ipa}</span>
                    <span className="ipa-key">{v.keyword}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <PhonemeDetail phoneme={detailOf("vowels", VOWELS)} />
        </section>

        <PhonemeSection
          title="Diphthongs"
          hint="One vowel sliding into another — the mouth keeps moving."
          group="diphthongs"
          items={DIPHTHONGS}
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
            sel={sel}
            onPick={pick}
          />
        ))}

        <p className="hint-text ipa-credit">
          Symbol recordings:{" "}
          <a href={RECORDING_CREDIT.href} target="_blank" rel="noreferrer">
            {RECORDING_CREDIT.text}
          </a>{" "}
          (
          <a href={RECORDING_CREDIT.filesHref} target="_blank" rel="noreferrer">
            per-file credits
          </a>
          )
        </p>
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
  sel,
  onPick,
}: {
  title: string;
  hint: string;
  group: string;
  items: Phoneme[];
  sel: Selection | null;
  onPick: (group: string, p: Phoneme) => void;
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
            onClick={() => onPick(group, p)}
          >
            <span className="ipa-sym">{p.ipa}</span>
            <span className="ipa-key">{p.keyword}</span>
          </button>
        ))}
      </div>
      <PhonemeDetail phoneme={open} />
    </section>
  );
}

/** 展开的音素详情:再听一次音 + 点词朗读 */
function PhonemeDetail({ phoneme }: { phoneme: Phoneme | undefined }) {
  if (!phoneme) return null;
  return (
    <div className="ipa-detail">
      <button className="btn btn-sm" title="Play the sound again" onClick={() => void pronounce(phoneme)}>
        <Icon name="volume" /> /{phoneme.ipa}/
      </button>
      <div className="ipa-words">
        {phoneme.examples.map((w) => (
          <button key={w} className="ipa-word" title="Pronounce" onClick={() => void speakWord(w)}>
            {w}
          </button>
        ))}
      </div>
    </div>
  );
}
