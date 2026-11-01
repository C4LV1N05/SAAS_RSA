/**
 * Simple illustrated "photos" for the demo menu (original drawings, so the demo
 * has no third-party image licensing). Real restaurants upload their own photos.
 */
const W = 800;

const table = (bg: string, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <defs>
    <radialGradient id="light" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient>
  </defs>
  <rect width="${W}" height="${W}" fill="${bg}"/>
  ${inner}
  <rect width="${W}" height="${W}" fill="url(#light)"/>
</svg>`;

const plate = (inner: string) => `
  <circle cx="400" cy="410" r="330" fill="#000" opacity=".18"/>
  <circle cx="400" cy="400" r="330" fill="#f4f6f9"/>
  <circle cx="400" cy="400" r="330" fill="none" stroke="#1b2f4e" stroke-width="16"/>
  <circle cx="400" cy="400" r="250" fill="#fbfcfe"/>
  ${inner}`;

const wood = '#7a4a2a';
const slate = '#3b4249';

const chips = (x: number, y: number) =>
  Array.from({ length: 9 }, (_, i) => {
    const a = (i * 37) % 70 - 35;
    return `<rect x="${x + (i % 3) * 34}" y="${y + Math.floor(i / 3) * 30}" width="26" height="110" rx="8" fill="${i % 2 ? '#e9b949' : '#f2c75c'}" transform="rotate(${a} ${x + (i % 3) * 34 + 13} ${y + Math.floor(i / 3) * 30 + 55})"/>`;
  }).join('');

const grill = (cx: number, cy: number) =>
  [-60, -20, 20, 60].map((o) => `<line x1="${cx + o - 50}" y1="${cy - 70}" x2="${cx + o + 50}" y2="${cy + 70}" stroke="#3a1d10" stroke-width="10" stroke-linecap="round" opacity=".7"/>`).join('');

export const DEMO_IMAGES: Record<string, string> = {
  'Rump 300g': table(wood, plate(`
    <path d="M250 330 C 300 250, 470 250, 520 320 C 560 380, 520 480, 420 490 C 320 500, 220 430, 250 330 Z" fill="#8a3b1f"/>
    <path d="M270 340 C 320 280, 460 280, 500 330" stroke="#c96a3b" stroke-width="14" fill="none" stroke-linecap="round"/>
    ${grill(385, 380)}
    ${chips(470, 420)}
    <circle cx="300" cy="500" r="18" fill="#3f8a3a"/><circle cx="325" cy="515" r="14" fill="#4fa046"/>`)),

  'Sirloin 250g': table(slate, plate(`
    <path d="M230 360 C 260 280, 430 270, 500 330 C 540 370, 500 450, 400 460 C 300 470, 210 430, 230 360 Z" fill="#7d331a"/>
    <path d="M250 360 C 300 300, 420 300, 470 340" stroke="#e8e0c8" stroke-width="16" fill="none" stroke-linecap="round" opacity=".85"/>
    ${grill(370, 370)}
    <rect x="340" y="320" width="70" height="44" rx="10" fill="#f5d77a"/>
    <ellipse cx="480" cy="510" rx="90" ry="45" fill="#4f8f3c"/><ellipse cx="450" cy="500" rx="40" ry="22" fill="#6cb04f"/><ellipse cx="520" cy="520" rx="36" ry="18" fill="#3e7a30"/>`)),

  'Smash burger': table(wood, `
    <ellipse cx="400" cy="640" rx="300" ry="50" fill="#000" opacity=".25"/>
    <rect x="130" y="560" width="540" height="70" rx="34" fill="#c98a3d"/>
    <path d="M130 540 L 670 540 L 640 585 L 160 585 Z" fill="#5b2f17"/>
    <path d="M140 500 Q 400 560 660 500 L 650 540 L 150 540 Z" fill="#f2b33d"/>
    <path d="M130 470 L 670 470 L 650 515 L 150 515 Z" fill="#4a2512"/>
    <path d="M150 455 Q 220 430 280 458 Q 340 432 400 458 Q 460 430 520 458 Q 580 432 650 455 L 650 475 L 150 475 Z" fill="#5aa53f"/>
    <path d="M130 455 C 130 250, 670 250, 670 455 Z" fill="#d9973f"/>
    <path d="M190 400 C 210 300, 400 280, 470 300" stroke="#efc27a" stroke-width="18" fill="none" stroke-linecap="round" opacity=".7"/>
    ${Array.from({ length: 14 }, (_, i) => `<ellipse cx="${210 + (i * 83) % 380}" cy="${330 + (i * 47) % 100}" rx="9" ry="5" fill="#fbf1d6" transform="rotate(${(i * 40) % 180} ${210 + (i * 83) % 380} ${330 + (i * 47) % 100})"/>`).join('')}`),

  'Boerewors bites': table(slate, plate(`
    ${[[300, 330], [420, 300], [500, 400], [330, 450], [430, 470]].map(([x, y], i) => `
      <rect x="${x! - 55}" y="${y! - 26}" width="110" height="52" rx="26" fill="#7a3418" transform="rotate(${i * 33 - 30} ${x} ${y})"/>
      <rect x="${x! - 40}" y="${y! - 14}" width="60" height="10" rx="5" fill="#b65a32" transform="rotate(${i * 33 - 30} ${x} ${y})"/>`).join('')}
    <circle cx="520" cy="260" r="62" fill="#1b2f4e"/><circle cx="520" cy="260" r="50" fill="#c8452b"/>
    <circle cx="505" cy="250" r="9" fill="#f2b33d"/><circle cx="535" cy="270" r="7" fill="#4fa046"/><circle cx="520" cy="240" r="6" fill="#f2b33d"/>`)),

  'Chicken livers': table(wood, plate(`
    <circle cx="380" cy="400" r="170" fill="#e2733a"/>
    <circle cx="380" cy="400" r="170" fill="none" stroke="#c75d2b" stroke-width="10"/>
    ${[[330, 360], [420, 350], [380, 430], [310, 450], [450, 440], [370, 300]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="44" ry="30" fill="#6b2a1c"/><ellipse cx="${x! - 10}" cy="${y! - 8}" rx="14" ry="8" fill="#9a4632"/>`).join('')}
    <rect x="500" y="440" width="150" height="90" rx="20" fill="#e8c27d" transform="rotate(-20 575 485)"/>
    <rect x="515" y="452" width="120" height="66" rx="14" fill="#f5dfac" transform="rotate(-20 575 485)"/>`)),

  'Glass of Chenin Blanc': table(slate, `
    <ellipse cx="400" cy="700" rx="150" ry="22" fill="#000" opacity=".3"/>
    <ellipse cx="400" cy="690" rx="120" ry="18" fill="#dfe6ee"/>
    <rect x="390" y="470" width="20" height="220" fill="#dfe6ee"/>
    <path d="M250 150 L 550 150 C 560 330, 500 470, 400 480 C 300 470, 240 330, 250 150 Z" fill="#eef3f8" opacity=".55"/>
    <path d="M262 290 L 538 290 C 525 400, 480 465, 400 470 C 320 465, 275 400, 262 290 Z" fill="#efe08a"/>
    <ellipse cx="400" cy="290" rx="138" ry="16" fill="#f7ecac"/>
    <path d="M290 180 C 285 260, 300 340, 330 400" stroke="#fff" stroke-width="14" fill="none" stroke-linecap="round" opacity=".6"/>`),

  'Craft lager': table(wood, `
    <ellipse cx="400" cy="705" rx="170" ry="24" fill="#000" opacity=".3"/>
    <path d="M260 160 L 540 160 L 515 690 L 285 690 Z" fill="#e3a12f"/>
    <path d="M285 690 L 515 690 L 518 640 L 282 640 Z" fill="#c9861f"/>
    <path d="M255 110 C 280 60, 340 80, 360 100 C 390 60, 450 70, 470 100 C 500 70, 560 90, 548 170 L 252 170 Z" fill="#fbf6ea"/>
    ${Array.from({ length: 16 }, (_, i) => `<circle cx="${300 + (i * 61) % 200}" cy="${240 + (i * 97) % 400}" r="${4 + (i % 3) * 2}" fill="#f6d27a" opacity=".8"/>`).join('')}
    <path d="M300 200 L 318 650" stroke="#fff" stroke-width="16" stroke-linecap="round" opacity=".35"/>`),

  'Rooibos iced tea': table(slate, `
    <ellipse cx="400" cy="705" rx="160" ry="24" fill="#000" opacity=".3"/>
    <path d="M270 170 L 530 170 L 505 690 L 295 690 Z" fill="#eef3f8" opacity=".35"/>
    <path d="M276 260 L 524 260 L 505 690 L 295 690 Z" fill="#b5401f"/>
    <rect x="320" y="300" width="80" height="80" rx="12" fill="#f3f7fb" opacity=".55" transform="rotate(12 360 340)"/>
    <rect x="410" y="340" width="74" height="74" rx="12" fill="#f3f7fb" opacity=".5" transform="rotate(-10 447 377)"/>
    <circle cx="500" cy="200" r="70" fill="#f2d33d"/><circle cx="500" cy="200" r="56" fill="#fbe98a"/>
    ${[0, 60, 120, 180, 240, 300].map((a) => `<line x1="500" y1="200" x2="${500 + 52 * Math.cos((a * Math.PI) / 180)}" y2="${200 + 52 * Math.sin((a * Math.PI) / 180)}" stroke="#f2d33d" stroke-width="5"/>`).join('')}
    <rect x="430" y="80" width="18" height="330" rx="9" fill="#1b2f4e" transform="rotate(14 439 245)"/>`),
};
