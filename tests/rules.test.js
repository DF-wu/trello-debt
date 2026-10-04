import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCard, fillTemplate, formatAmount, parseAmount, pickCategory, splitKeywords, RulesError } from '../js/rules.js';

const settings = {
  categories: [
    { id: 'food', name: '吃', listId: 'L1', labelIds: ['lab1'], keywords: ['午餐', '便當'] },
    { id: 'shop', name: '買', listId: 'L2', labelIds: [], keywords: ['蝦皮'] },
    { id: 'misc', name: '其他', listId: 'L3', labelIds: [], keywords: [] },
  ],
  defaultCategoryId: 'misc',
  titleTemplate: '{title} ${amount}',
  descTemplate: '金額：{amount}\n{content}',
  amountFieldId: '',
  position: 'top',
};

test('parseAmount 接受各種輸入', () => {
  assert.equal(parseAmount('1,234'), 1234);
  assert.equal(parseAmount(' NT$ 99 '), 99);
  assert.equal(parseAmount('12.5元'), 12.5);
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount(null)));
});

test('formatAmount 千分位', () => {
  assert.equal(formatAmount(1234), '1,234');
  assert.equal(formatAmount(12.5), '12.5');
  assert.equal(formatAmount('x'), 'x');
  assert.equal(formatAmount(null), '');
});

test('splitKeywords 支援中英逗號、頓號、換行', () => {
  assert.deepEqual(splitKeywords('午餐, 便當、咖啡\n飲料；茶'), ['午餐', '便當', '咖啡', '飲料', '茶']);
  assert.deepEqual(splitKeywords(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(splitKeywords(undefined), []);
});

test('fillTemplate 保留未知變數', () => {
  assert.equal(fillTemplate('{title} {nope}', { title: 'x' }), 'x {nope}');
  assert.equal(fillTemplate(undefined, {}), '');
});

test('pickCategory：明確指定 > 關鍵字 > 預設', () => {
  assert.equal(pickCategory({ title: '午餐', categoryId: 'shop' }, settings).id, 'shop');
  assert.equal(pickCategory({ title: '今天午餐' }, settings).id, 'food');
  assert.equal(pickCategory({ title: 'x', content: '蝦皮買的' }, settings).id, 'shop');
  assert.equal(pickCategory({ title: '沒關鍵字' }, settings).id, 'misc');
  assert.equal(pickCategory({ title: 'x', categoryId: 'ghost' }, settings).id, 'misc');
  assert.equal(pickCategory({ title: 'x' }, { categories: [] }), null);
});

test('buildCard 組出卡片參數', () => {
  const card = buildCard({ title: '便當', amount: 120, content: '雞腿', createdAt: 0 }, settings);
  assert.equal(card.idList, 'L1');
  assert.equal(card.name, '便當 $120');
  assert.equal(card.desc, '金額：120\n雞腿');
  assert.deepEqual(card.idLabels, ['lab1']);
  assert.equal(card.pos, 'top');
  assert.deepEqual(card.customFields, []);
  assert.equal(card.categoryName, '吃');
});

test('buildCard 金額自訂欄位與 bottom', () => {
  const card = buildCard({ title: 't', amount: 99.5 }, { ...settings, amountFieldId: 'cf1', position: 'bottom' });
  assert.deepEqual(card.customFields, [{ id: 'cf1', value: { number: '99.5' } }]);
  assert.equal(card.pos, 'bottom');
});

test('buildCard 標題空白時退回原標題', () => {
  const card = buildCard({ title: 'abc', amount: 1 }, { ...settings, titleTemplate: '   ' });
  assert.equal(card.name, 'abc');
});

test('buildCard 沒有清單時丟 RulesError', () => {
  assert.throws(() => buildCard({ title: 'x', amount: 1 }, { categories: [] }), RulesError);
  assert.throws(() => buildCard({ title: 'x', amount: 1 }, { categories: [{ id: 'a', name: 'a', listId: '' }] }), RulesError);
});

test('buildCard 不會修改設定裡的 labelIds', () => {
  const card = buildCard({ title: '午餐', amount: 1 }, settings);
  card.idLabels.push('zzz');
  assert.deepEqual(settings.categories[0].labelIds, ['lab1']);
});
