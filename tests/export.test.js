import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportRows, toCsv, buildTextReport, creationDateFromId, safeFilename, summarizeList } from '../js/rules.js';

const cards = [
  { id: '6a7779a0a9ced87b3ed189f9', name: '--------[Summary] --------', desc: '總計', shortUrl: 'https://t/s' },
  { id: '69c026db5dc041ed517f76b8', name: '舊卡, 有逗號', desc: '1\n\n![圖](https://x/y.png)', shortUrl: 'https://t/a', badges: { attachments: 2 }, pluginData: [{ value: '{"__CFT_DATA__":{"113659":{"v":880}}}' }] },
  { id: '6a82de038c0da0dc82b6dc1b', name: '新卡 "引號"', desc: '120\n\n雞腿', shortUrl: 'https://t/b', badges: { attachments: 0 } },
  { id: '6a82de038c0da0dc82b6dc1c', name: '讀不到', desc: '沒數字', shortUrl: 'https://t/c' },
];

test('creationDateFromId', () => {
  assert.equal(creationDateFromId('6a7779a0a9ced87b3ed189f9').getTime(), 0x6a7779a0 * 1000);
  assert.equal(creationDateFromId('zz'), null);
  assert.equal(creationDateFromId(undefined), null);
});

test('buildExportRows 依建卡時間排序、去掉圖片、帶附件數', () => {
  const summary = summarizeList(cards);
  const rows = buildExportRows(summary, cards);
  assert.deepEqual(rows.map((r) => r.name), ['舊卡, 有逗號', '新卡 "引號"']);
  assert.equal(rows[0].amount, 880);
  assert.equal(rows[0].source, 'Smart Fields');
  assert.equal(rows[0].attachments, 2);
  assert.equal(rows[0].desc, '1');
  assert.equal(rows[1].source, '說明');
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('toCsv：BOM、CRLF、跳脫逗號與引號、總計列、讀不到列', () => {
  const summary = summarizeList(cards);
  const csv = toCsv(buildExportRows(summary, cards), summary, '爸爸債務');
  assert.ok(csv.startsWith('﻿日期,項目,金額,'));
  const lines = csv.slice(1).split('\r\n');
  assert.ok(lines[1].includes('"舊卡, 有逗號",880,Smart Fields,2,https://t/a,1'));
  assert.ok(lines[2].includes('"新卡 ""引號""",120,說明,0,https://t/b,120 雞腿'));
  assert.ok(lines.includes('總計,爸爸債務,1000,2 筆'));
  assert.ok(lines.some((l) => l.startsWith('讀不到金額,讀不到')));
  assert.equal(csv.slice(-2), '\r\n');
});

test('buildTextReport', () => {
  const summary = summarizeList(cards);
  const text = buildTextReport(buildExportRows(summary, cards), summary, '爸爸債務', '2026-10-04');
  assert.equal(text.split('\n')[0], '爸爸債務（2026-10-04）');
  assert.equal(text.split('\n')[1], '共 2 筆，總計 $1,000');
  assert.match(text, /新卡 "引號"　\$120/);
  assert.match(text, /讀不到金額（未計入）：讀不到/);
});

test('safeFilename', () => {
  assert.equal(safeFilename('2026.8.9 結賬 paid / x'), '2026.8.9_結賬_paid_x');
  assert.equal(safeFilename(''), 'export');
});
