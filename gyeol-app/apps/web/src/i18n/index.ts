import { ko } from './ko';
import { en } from './en';
import { ja } from './ja';
import { zh } from './zh';

export type Lang = 'ko' | 'en' | 'ja' | 'zh';
export const LANGS: { id: Lang; name: string }[] = [
  { id: 'ko', name: '한국어' },
  { id: 'en', name: 'English' },
  { id: 'ja', name: '日本語' },
  { id: 'zh', name: '简体中文' },
];

export type Dict = Record<keyof typeof ko, string>;
export const DICTS: Record<Lang, Partial<Dict>> = { ko, en, ja, zh };

function detect(): Lang {
  const l = (navigator.language || 'ko').toLowerCase();
  if (l.startsWith('ko')) return 'ko';
  if (l.startsWith('ja')) return 'ja';
  if (l.startsWith('zh')) return 'zh';
  return 'en';
}

let lang: Lang = 'ko';

export function setLang(setting: Lang | 'auto') {
  lang = setting === 'auto' ? detect() : setting;
  document.documentElement.lang = lang;
}

export const getLang = () => lang;

/** 번역. {이름} 자리에 vars 값을 넣는다. 없는 키는 한국어 → 키 그대로 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = (DICTS[lang] as Record<string, string>)[key] ?? (ko as Record<string, string>)[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : s;
}
