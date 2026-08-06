// build_html2.js — cleaner HTML: split threads, strip noise, group by date
const fs = require('fs');

const posts = JSON.parse(fs.readFileSync('C:/Temp/mdm_threads/design_only.json', 'utf8'));

// --- split a raw thread text into individual posts (author marker separates them) ---
function splitThreads(text) {
  return text
    .split(/\nmdmstudio_design\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

// --- remove noise lines from a single post ---
const EMOJI_RE = /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{00A9}\u{00AE}\u{25B6}\u{25C0}\u{2705}\u{2764}\u{2B50}]+$/u;

function isNoise(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^@\S+\s*$/.test(t)) return true;                      // @mention alone
  if (/^(번역하기|리포스트|관련 스레드|전체보기|더 보기|답글)$/.test(t)) return true;
  if (/^·\s*(작성자)?\s*$/.test(t)) return true;              // · / · 작성자
  if (/^답글 \d+개 더 보기$/.test(t)) return true;
  if (/^[\d]+(일|시간|분|주|개월|년)$/.test(t)) return true;  // 6일 / 3시간
  if (/^[ㄱ-ㅎㅏ-ㅣ]{1,4}$/.test(t)) return true;             // stray jamo
  if (/^[\d,\s/]{1,12}$/.test(t)) return true;                // "45" / "1 / 5"
  if (/^[\d]+\s*(천|만|억)$/.test(t)) return true;            // "4천" "1만"
  if (/^[-–—•·.\s]{1,8}$/.test(t)) return true;               // separators
  if (EMOJI_RE.test(t)) return true;                          // emoji-only line
  if (/^(www\.|https?:\/\/)\S+$/.test(t)) return true;        // bare URL line
  if (/^(\.\.\.|…)$/.test(t)) return true;
  if (/^mdmstudio_design$/.test(t)) return true;              // author marker
  if (/^©\s*20\d\d$/.test(t)) return true;                    // © 2026 footer
  if (/^(개인정보처리방침|쿠키 정책|Threads 약관|이용약관)$/.test(t)) return true;
  return false;
}

function cleanPost(text) {
  return text
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => !isNoise(l))
    .join('\n')
    .trim();
}

// --- split into title + body ---
function splitTitleBody(text) {
  const lines = text.split('\n');
  let title = lines[0] ? lines[0].trim() : '';
  let body = lines.slice(1).join('\n').trim();
  // if title looks like garbage, promote first meaningful line
  if (!title || /^[\d,\s/]+$/.test(title) || title.length > 90) {
    const idx = lines.findIndex(l => l.trim().length >= 4 && !/^[\d,\s/]+$/.test(l.trim()));
    if (idx > 0) {
      title = lines[idx].trim();
      body = lines.slice(0, idx).concat(lines.slice(idx + 1)).join('\n').trim();
    }
  }
  // strip bracketed title markers like [text] for display
  const m = title.match(/^\[(.+?)\]\s*$/);
  if (m) title = m[1];
  return { title: title.slice(0, 80), body };
}

// --- build cleaned post list ---
const cleaned = [];
for (const p of posts) {
  for (const chunk of splitThreads(p.text)) {
    const text = cleanPost(chunk);
    if (text.length < 10) continue;
    const { title, body } = splitTitleBody(text);
    if (!title) continue;
    cleaned.push({ date: p.date, title, body });
  }
}

// --- group by date ---
const groups = new Map();
for (const c of cleaned) {
  if (!groups.has(c.date)) groups.set(c.date, []);
  groups.get(c.date).push(c);
}
const orderedDates = Array.from(groups.keys()).sort().reverse(); // newest first

// --- HTML ---
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const toc = orderedDates
  .map(d => `<a href="#d-${d}">${d} (${groups.get(d).length})</a>`)
  .join('');

const sections = orderedDates
  .map(d => {
    const articles = groups.get(d)
      .map(c => {
        const bodyHtml = c.body ? `<p class="body">${esc(c.body).replace(/\n/g, '<br>')}</p>` : '';
        return `<article><h3>${esc(c.title)}</h3>${bodyHtml}</article>`;
      })
      .join('\n');
    return `<section id="d-${d}">\n<h2>📅 ${d}</h2>\n${articles}\n</section>`;
  })
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MDM 디자인 꿀팁 모음 — ${cleaned.length}개</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; max-width: 820px; margin: 0 auto; padding: 28px 20px 80px; line-height: 1.8; background: #fdfdfd; color: #1a1a1a; font-size: 16px; }
  h1 { font-size: 1.7em; margin: 0 0 4px; }
  .desc { color: #666; font-size: 0.95em; margin: 0 0 20px; }
  nav.toc { background: #f4f4f4; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 16px; margin: 16px 0 28px; font-size: 0.9em; line-height: 2; }
  nav.toc a { color: #2563eb; text-decoration: none; margin-right: 14px; white-space: nowrap; }
  section { margin-bottom: 34px; }
  section > h2 { font-size: 1.15em; border-bottom: 2px solid #333; padding-bottom: 6px; margin: 0 0 14px; }
  article { padding: 12px 0; border-bottom: 1px solid #eee; }
  article:last-child { border-bottom: none; }
  article h3 { font-size: 1.05em; margin: 0 0 6px; color: #111; }
  article .body { margin: 0; font-size: 0.95em; color: #333; }
  footer { color: #999; font-size: 0.85em; margin-top: 40px; text-align: center; }
</style>
</head>
<body>
<h1>🎨 MDM(@mdmstudio_design) 디자인 꿀팁 모음</h1>
<p class="desc">전체 909개 글에서 디자인 관련 글만 정리 · 총 ${cleaned.length}개 (날짜순, 최신순)</p>
<nav class="toc">${toc}</nav>
${sections}
<footer>수집일 2026-08-06 · 스레드 프로필 전체 스크롤 수집 · 텍스트 전용 정리본</footer>
</body>
</html>
`;

fs.writeFileSync('C:/Temp/mdm_threads/design_tips.html', html, 'utf8');
console.log('OK —', cleaned.length, 'posts in', orderedDates.length, 'date groups,', html.length, 'bytes');
