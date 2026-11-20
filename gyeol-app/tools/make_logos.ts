/** 게임 타일과 같은 화살표로 앱 로고 SVG 생성: npx tsx tools/make_logos.ts */
import { writeFileSync } from 'node:fs';
import { ARROW_INNER, ARROW_OUTER } from '../apps/web/src/components/tileArt';

const face = `<rect width="100" height="100" rx="10" fill="#3f8f47"/>
<path d="${ARROW_OUTER}" fill="#2d6b34"/>
<path d="${ARROW_INNER}" fill="#f3ecdd"/>`;

function tile(matrix: string) {
  // 옆면은 같은 윤곽을 수직으로 겹쳐서 만든다. 화살표는 앞면과 함께 투영한다.
  const side = Array.from({ length: 13 }, (_, i) => 12 - i).map(dy =>
    `<g transform="translate(0 ${dy})"><g transform="${matrix}"><rect width="100" height="100" rx="10" fill="#d9c8a6"/></g></g>`,
  ).join('\n');
  return `${side}\n<g transform="${matrix}">${face}</g>`;
}

const views = {
  // 38도 기울기·14도 회전. 투영된 타일과 두께를 포함해 사방 여백을 맞춘다.
  hero: { viewBox: '0 0 160 160', matrix: 'matrix(0.970296 0.190639 -0.241922 0.764599 43.5813 26.2381)' },
  front: { viewBox: '-4 -4 108 120', matrix: 'translate(0 0)' },
};

for (const [name, view] of Object.entries(views)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.viewBox}" fill="none">\n${tile(view.matrix)}\n</svg>\n`;
  writeFileSync(new URL(`../apps/web/public/tiles/${name}.svg`, import.meta.url), svg);
  console.log(`tiles/${name}.svg`);
}
