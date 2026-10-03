/**
 * 全新库验证：播种后按业务规则跑 evaluateDue 与对账两轮（重试不回退结论）。
 */
import 'fake-indexeddb/auto';
import { db, seedDemoData } from '../src/utils/db';
import { evaluateDue } from '../src/types/suspension';
import { reconcileLedgers } from '../src/types/reconcile';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
} as Storage;

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
}

async function main(): Promise<void> {
  await db.open();
  await seedDemoData();

  const stations = await db.stations.toArray();
  const instruments = await db.instruments.toArray();
  const calibrations = await db.calibrations.toArray();
  const windows = await db.suspensions.toArray();

  const codeById = new Map(stations.map((s) => [s.id, s.code]));
  const stateByCode = new Map(stations.map((s) => [s.code, s.obsStatus]));
  const winByCode = new Map<string, typeof windows>();
  windows.forEach((w) => {
    const list = winByCode.get(w.stationCode) ?? [];
    list.push(w);
    winByCode.set(w.stationCode, list);
  });

  const today = new Date().toISOString().slice(0, 10);
  const overdueCodes = new Set<string>();
  const heldCodes = new Set<string>();
  /** LTX02：两台仪器名义到期日均早于停测起始日，停测前已超期 → 保持超期 */
  let ltx02OverdueCount = 0;
  instruments.forEach((instrument) => {
    const code = codeById.get(instrument.stationId) ?? '';
    const own = calibrations
      .filter((c) => c.instrumentId === instrument.id)
      .sort((a, b) => b.date.localeCompare(a.date));
    const due = evaluateDue({
      baseDate: own[0]?.date ?? instrument.installDate,
      cycleDays: 365,
      windows: winByCode.get(code) ?? [],
      stationState: stateByCode.get(code) ?? '运行',
      today,
    });
    if (due.state === 'overdue') {
      overdueCodes.add(code);
      if (code === 'LTX02') ltx02OverdueCount += 1;
    }
    if (due.state === 'suspended-ok' || due.state === 'pending-period') {
      heldCodes.add(code);
    }
  });

  console.log(`今日 ${today}：超期台站 ${[...overdueCodes].join(',') || '无'}；挂起台站 ${[...heldCodes].join(',') || '无'}`);
  assert(overdueCodes.has('LTX03'), 'LTX03 复测后已到期 → 超期，照旧排标定');
  assert(ltx02OverdueCount === 2, 'LTX02 两台仪器停测前名义到期日已过 → 保持超期，不错误挂起');
  assert(!heldCodes.has('LTX02'), 'LTX02 不属于"停测期间够不到期"，不挂起');
  assert(heldCodes.has('HX01'), 'HX01 停测中扣减后够不到期 → 挂起，不进更换提醒');
  assert(heldCodes.has('HX02'), 'HX02 只标停测状态无时段 → pending-period，不算超期');

  // 两轮对账：重试时已认账的不回退
  const round1 = reconcileLedgers({ stations, windows, instruments, calibrations, now: 111 });
  assert(round1.failed === 0, `播种数据全部对平（failed=${round1.failed}）`);
  // 模拟第一轮写认账时间
  const matched = new Set(round1.items.map((i) => i.stationCode));
  calibrations.forEach((c) => {
    const instrument = instruments.find((i) => i.id === c.instrumentId);
    const code = instrument ? codeById.get(instrument.stationId) : undefined;
    if (code && matched.has(code)) c.acknowledgedAt = 111;
  });
  const round2 = reconcileLedgers({ stations, windows, instruments, calibrations, now: 222 });
  const stillAcked = round2.items.every((i) => i.status !== 'matched' || i.acknowledgedAt === 111);
  assert(stillAcked, '重试对账：认账时间保持 111，不被第二轮（222）回退');

  db.close();
  if (failed > 0) {
    console.error(`\n${failed} 个断言失败`);
    process.exit(1);
  }
  console.log('\n播种与对账闭环验证通过');
}

void main();
