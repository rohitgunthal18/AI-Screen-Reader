/**
 * Smoke test for the pure logic: segmentation, normalization, speechify.
 * Run with: node test/speechify.test.mjs
 *
 * These modules are deliberately free of chrome.* so they can be exercised in
 * plain node — the transforms are regex-heavy and regexes need real input.
 */
import assert from 'node:assert';
import { speechify, stripBrackets, expandAbbreviations, collapseUrls, normalizeProse, linearizeTable } from '../src/lib/speechify.js';
import { segmentSentences, mergeShort } from '../src/lib/segmenter.js';
import { BlockKind } from '../src/lib/protocol.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

console.log('\nbracket safety (Fish S2 reads [x] as emotion markup)');
t('strips wikipedia citations', () => {
  assert.strictEqual(stripBrackets('Gandhi was born in 1869.[1][2]').trim(), 'Gandhi was born in 1869.');
});
t('strips [citation needed] and [edit]', () => {
  assert.strictEqual(normalizeProse('The war ended.[citation needed] Next[edit] section.'), 'The war ended. Next section.');
});
t('keeps words but drops brackets for other content', () => {
  assert.ok(!normalizeProse('The result [see below] was clear.').includes('['));
  assert.ok(normalizeProse('The result [see below] was clear.').includes('see below'));
});
t('no stray brackets survive', () => {
  assert.ok(!/[[\]]/.test(normalizeProse('a [1] b [note 3] c [x] d ] e [')));
});

console.log('\nabbreviations and units');
t('expands e.g. and i.e.', () => {
  assert.ok(expandAbbreviations('Use fruit, e.g. apples.').includes('for example'));
  assert.ok(expandAbbreviations('The CPU, i.e. the brain.').includes('that is'));
});
t('expands currency including rupees', () => {
  assert.ok(expandAbbreviations('It cost ₹500 today.').includes('500 rupees'));
  assert.ok(expandAbbreviations('It cost $20.').includes('20 dollars'));
});
t('expands units only after digits', () => {
  assert.ok(expandAbbreviations('It is 5km away.').includes('5 kilometers'));
  // "Mumbai" contains "m" + "b"; must not be corrupted
  assert.strictEqual(expandAbbreviations('Mumbai is big.'), 'Mumbai is big.');
});
t('does not corrupt words containing abbreviation letters', () => {
  assert.strictEqual(expandAbbreviations('Vsauce and Doctor Who.'), 'Vsauce and Doctor Who.');
});
t('percent and ampersand', () => {
  assert.ok(expandAbbreviations('Growth of 12% here.').includes('12 percent'));
  assert.ok(expandAbbreviations('Tom & Jerry').includes('and'));
});

console.log('\nURLs');
t('collapses url to spoken domain', () => {
  assert.ok(collapseUrls('See https://arxiv.org/abs/2301.00001 now.').includes('arxiv dot org'));
});
t('collapses email', () => {
  assert.ok(collapseUrls('Mail me at rohit@example.com ok').includes('at example'));
});

console.log('\nsegmentation');
t('does not split on Dr. or decimals', () => {
  const s = segmentSentences('Dr. Bose measured 3.14 units. Then he left.', 'en');
  assert.strictEqual(s.length, 2, `got ${s.length}: ${JSON.stringify(s)}`);
});
t('splits normal sentences', () => {
  assert.strictEqual(segmentSentences('One. Two. Three.', 'en').length, 3);
});
t('handles devanagari danda', () => {
  assert.ok(segmentSentences('यह एक वाक्य है। यह दूसरा है।', 'hi').length >= 2);
});
t('mergeShort respects the cap', () => {
  const merged = mergeShort(['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(400)], 900);
  assert.ok(merged.every((m) => m.length <= 900));
  assert.strictEqual(merged.length, 2);
});
t('first chunk uses the smaller cap, later chunks do not', () => {
  const s = Array.from({ length: 8 }, () => 'x'.repeat(100));
  const merged = mergeShort(s, 420, 180);
  // 19s of silence before the first word is the failure this guards against.
  assert.ok(merged[0].length <= 180, `first chunk ${merged[0].length} > 180`);
  assert.ok(merged.slice(1).some((m) => m.length > 180), 'later chunks stayed small');
  assert.ok(merged.every((m) => m.length <= 420));
});
t('ramp applies once per document, not once per paragraph', () => {
  const doc = {
    ok: true, title: 'T', lang: 'en', url: 'u', strategy: 'readability',
    blocks: [1, 2, 3].map((i) => ({
      id: `b${i}`, kind: BlockKind.PARAGRAPH, uid: `u${i}`,
      text: Array.from({ length: 6 }, (_, j) => `Sentence ${j} of paragraph ${i} runs on a while.`).join(' '),
    })),
  };
  const { utterances: us } = speechify(doc, { maxChunkChars: 420, firstChunkChars: 180 });
  assert.ok(us[0].text.length <= 180, `opening ${us[0].text.length} > 180`);
  const later = us.filter((u) => u.blockId !== 'b1');
  assert.ok(later.some((u) => u.text.length > 180), 'every paragraph got the small cap');
});

console.log('\nspeechify end to end');
const extraction = {
  ok: true, title: 'T', lang: 'en', url: 'https://x.com', strategy: 'readability',
  blocks: [
    { id: 'b1', kind: BlockKind.HEADING, level: 2, text: 'Indian Economy[edit]', uid: 'u1' },
    { id: 'b2', kind: BlockKind.PARAGRAPH, text: 'India grew 7% in 2024.[1] It is now approx. $3.5 trillion.', uid: 'u2' },
    { id: 'b3', kind: BlockKind.CODE, text: 'const a=1;\nconst b=2;', uid: 'u3', meta: { lines: 2 } },
    { id: 'b4', kind: BlockKind.FIGURE, text: 'image', uid: 'u4' },
    { id: 'b5', kind: BlockKind.LIST_ITEM, text: 'Agriculture sector', uid: 'u5' },
  ],
};
const { utterances, stats } = speechify(extraction, { skipCode: true, maxChunkChars: 900, speed: 1 });

t('produces utterances', () => assert.ok(utterances.length >= 4, `got ${utterances.length}`));
t('every utterance keeps its uid for highlighting', () => {
  assert.ok(utterances.filter((u) => u.kind !== BlockKind.FIGURE).every((u) => u.uid));
});
t('no utterance spans two blocks', () => {
  assert.strictEqual(new Set(utterances.map((u) => u.blockId)).size <= extraction.blocks.length, true);
});
t('only our own pause markup remains in brackets', () => {
  for (const u of utterances) {
    const brackets = u.text.match(/\[[^\]]*\]/g) || [];
    for (const b of brackets) assert.ok(['[break]', '[long-break]'].includes(b), `stray markup ${b} in "${u.text}"`);
  }
});
t('skips code body when skipCode', () => {
  const code = utterances.find((u) => u.kind === BlockKind.CODE);
  assert.ok(code.text.includes('skipped'), code.text);
  assert.ok(!code.text.includes('const'));
});
t('drops junk figure caption', () => {
  assert.strictEqual(utterances.filter((u) => u.kind === BlockKind.FIGURE).length, 0);
  assert.strictEqual(stats.skipped.figures, 1);
});
t('bytes and estimate are sane', () => {
  assert.ok(stats.totalBytes > 0);
  assert.ok(stats.estSeconds > 0);
});
t('table linearization pairs headers with cells', () => {
  const out = linearizeTable('', { cells: [['City', 'Pop'], ['Delhi', '32M']] });
  assert.ok(out.includes('City, Delhi'), out);
  assert.ok(out.includes('Pop, 32M'), out);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
