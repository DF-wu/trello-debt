import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountFromDesc, amountFromSmartFields, cardAmount, summarizeList, buildSummaryDesc, isSummaryCard } from '../js/rules.js';

test('amountFromDesc：純數字、跳脫、算式、等號右邊', () => {
  assert.equal(amountFromDesc('920'), 920);
  assert.equal(amountFromDesc('3591\\.51'), 3591.51);
  assert.equal(amountFromDesc('1155+1050'), 2205);
  assert.equal(amountFromDesc('970 +970\n\n![img](x)'), 1940);
  assert.equal(amountFromDesc('151\\*4.8\\*1.015*1.03 = 757.74216\n\n取 758'), 757.74);
  assert.equal(amountFromDesc('39593+1156+6030=46779'), 46779);
  assert.equal(amountFromDesc('\n\n  1,200 NTD\n'), 1200);
  assert.equal(amountFromDesc('金額：'), null);
  assert.equal(amountFromDesc('299美金 加運費 11000'), null);
  assert.equal(amountFromDesc('---'), null);
  assert.equal(amountFromDesc(''), null);
  assert.equal(amountFromDesc(undefined), null);
  assert.equal(amountFromDesc('alert(1)'), null);
});

test('amountFromSmartFields 讀 __CFT_DATA__', () => {
  const card = {
    pluginData: [
      { idPlugin: 'x', value: '{"card_pos_v1":{}}' },
      { idPlugin: 'sf', value: '{"__CFT_DATA__":{"113659":{"v":758},"id":"c","board_id":"b"}}' },
    ],
  };
  assert.equal(amountFromSmartFields(card), 758);
  assert.equal(amountFromSmartFields(card, '113659'), 758);
  assert.equal(amountFromSmartFields(card, '999'), null);
  assert.equal(amountFromSmartFields({ pluginData: [{ value: 'not json' }] }), null);
  assert.equal(amountFromSmartFields({}), null);
});

test('cardAmount：Smart Field 優先，其次說明', () => {
  const sf = { desc: '1', pluginData: [{ value: '{"__CFT_DATA__":{"1":{"v":5}}}' }] };
  assert.deepEqual(cardAmount(sf), { amount: 5, source: 'smartfield' });
  assert.deepEqual(cardAmount({ desc: '42' }), { amount: 42, source: 'desc' });
  assert.deepEqual(cardAmount({ desc: 'x' }), { amount: null, source: null });
});

test('summarizeList 跳過 Summary 卡、列出讀不到的', () => {
  const r = summarizeList([
    { id: 's', name: '--------[Summary] --------', desc: '總計 999' },
    { id: 'a', name: 'a', desc: '100' },
    { id: 'b', name: 'b', desc: '', pluginData: [{ value: '{"__CFT_DATA__":{"1":{"v":20.5}}}' }] },
    { id: 'c', name: 'c', desc: '沒有數字' },
  ]);
  assert.equal(r.total, 120.5);
  assert.equal(r.count, 2);
  assert.deepEqual(r.unparsed.map((u) => u.id), ['c']);
  assert.ok(isSummaryCard({ name: '總計' }));
});

test('buildSummaryDesc 換掉舊的自動行、保留其他內容', () => {
  const first = buildSummaryDesc('', { total: 1200, count: 3, date: '2026-10-04' });
  assert.equal(first, '總計 1,200（3 筆，2026-10-04 自動計算）');
  const again = buildSummaryDesc(`${first}\n\n手寫備註`, { total: 1300, count: 4, date: '2026-10-05' });
  assert.equal(again, '總計 1,300（4 筆，2026-10-05 自動計算）\n\n手寫備註');
  const keep = buildSummaryDesc('39593+1156=40749', { total: 1, count: 1, date: 'd' });
  assert.equal(keep, '總計 1（1 筆，d 自動計算）\n\n39593+1156=40749');
});
