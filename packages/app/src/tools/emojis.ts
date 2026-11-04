/**
 * The reactions the bot can use, by name. Emoji reactions were unusable while
 * the model had to supply platform ids it was never given, so the runtime owns
 * this mapping and the wake prompt lists only the names.
 */
export const REACTION_EMOJIS: Readonly<Record<string, string>> = {
  赞: "76",
  爱心: "66",
  呲牙: "13",
  微笑: "14",
  流泪: "5",
  大哭: "9",
  斜眼笑: "178",
  OK: "124",
  摸鱼: "285",
  仔细分析: "314",
  比心: "319",
  庆祝: "320",
  打call: "311"
};

export const REACTION_EMOJI_NAMES = Object.keys(REACTION_EMOJIS);
