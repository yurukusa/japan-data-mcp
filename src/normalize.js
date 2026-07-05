// 英語化・正規化の中核。上流の3源は日本語のメタデータを返すので、
// エージェント（英語圏の機械顧客）がそのまま消費できる英語キー・英語ラベルの
// 構造へ変換する。全文の機械翻訳は別の課金の壁になるため段階0では扱わず、
// 「英語のメタデータ＋ローマ字＋出典の明記」までを差別化の範囲とする（仕様1節）。

// 元号は上流が英語表記（Meiji/Taisho/...）で返すが、和暦だけの箇所もあるため対応表を持つ。
const ERA_EN = {
  Meiji: 'Meiji', Taisho: 'Taisho', Showa: 'Showa', Heisei: 'Heisei', Reiwa: 'Reiwa',
  明治: 'Meiji', 大正: 'Taisho', 昭和: 'Showa', 平成: 'Heisei', 令和: 'Reiwa',
};

// 法令の種別。上流は Act / CabinetOrder などの英語の enum を返すので、
// 人間が読める英語のラベルへ広げる（エージェントの要約用）。
const LAW_TYPE_EN = {
  Act: 'Act (法律)',
  CabinetOrder: 'Cabinet Order (政令)',
  MinisterialOrdinance: 'Ministerial Ordinance (省令)',
  Rule: 'Rule (規則)',
  ImperialOrdinance: 'Imperial Ordinance (勅令)',
  Constitution: 'Constitution (憲法)',
};

export function normalizeEra(era) {
  return ERA_EN[era] || era || null;
}

export function normalizeLawType(t) {
  return LAW_TYPE_EN[t] || t || null;
}

// e-Gov 法令 API の law_info / revision_info を、英語キーの平らな構造へ落とす。
// title_romaji は上流の law_title_kana（読み仮名）をそのまま渡す。仮名は
// ヘボン式に近い読みで、英語圏の利用者の同定に足りる（完全な翻字ではない旨を明示）。
export function normalizeLaw(item) {
  const li = item.law_info || {};
  const ri = item.revision_info || {};
  return {
    law_id: li.law_id || null,
    law_number_ja: li.law_num || null,
    law_type: normalizeLawType(li.law_type),
    era: normalizeEra(li.law_num_era),
    year: li.law_num_year ?? null,
    promulgation_date: li.promulgation_date || null,
    title_ja: ri.law_title || null,
    title_reading_kana: ri.law_title_kana || null,
    category_ja: ri.category || null,
    last_updated: ri.updated || null,
    revision_id: ri.law_revision_id || null,
  };
}

// 全ての応答に必ず載せる出典と免責。政府標準利用規約2.0とe-Statのクレジット表示、
// 法人番号の「国税庁が保証したものではない」旨は、規約上の義務なので削れない（仕様4節）。
export const ATTRIBUTION = {
  law: 'Source: e-Gov Law Search API (Digital Agency, Japan). Government of Japan Standard Terms of Use v2.0. Original text is Japanese; English fields are normalized metadata, not an official translation.',
  corporation: 'Source: Corporate Number Web-API (National Tax Agency, Japan). Not guaranteed by the National Tax Agency.',
  statistics: 'Source: e-Stat API (Statistics Bureau of Japan). Credit display required; datasets with reserved third-party rights are excluded.',
};
