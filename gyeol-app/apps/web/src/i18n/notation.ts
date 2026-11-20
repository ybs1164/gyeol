export const notationKo = {
  'notation.first': '선공', 'notation.second': '후공', 'notation.close': '닫기',
  'notation.description': '{color}: {cell}을 돌리고 그 {dir}에 놓기',
  'notation.apply': '수 두기', 'notation.before': '{n}수 직전', 'notation.after': '{n}수 둔 뒤',
  'notation.coordinates': '판 좌표 표시', 'notation.moveList': '수순 펼쳐 보기',
} as const;
type NotationDict = Record<keyof typeof notationKo, string>;
export const notationEn: NotationDict = {
  'notation.first': 'First', 'notation.second': 'Second', 'notation.close': 'Close',
  'notation.description': '{color}: turn {cell} and place {dir} of it',
  'notation.apply': 'Play move', 'notation.before': 'Before move {n}', 'notation.after': 'After move {n}',
  'notation.coordinates': 'Show board coordinates', 'notation.moveList': 'Show moves',
};
export const notationJa: NotationDict = {
  'notation.first': '先手', 'notation.second': '後手', 'notation.close': '閉じる',
  'notation.description': '{color}：{cell}を回し、その{dir}に置く',
  'notation.apply': '手を進める', 'notation.before': '{n}手目の直前', 'notation.after': '{n}手目の直後',
  'notation.coordinates': '盤の座標を表示', 'notation.moveList': '手順を表示',
};
export const notationZh: NotationDict = {
  'notation.first': '先手', 'notation.second': '后手', 'notation.close': '关闭',
  'notation.description': '{color}：转动{cell}，在其{dir}放置',
  'notation.apply': '落子', 'notation.before': '第{n}手之前', 'notation.after': '第{n}手之后',
  'notation.coordinates': '显示棋盘坐标', 'notation.moveList': '展开着法',
};
