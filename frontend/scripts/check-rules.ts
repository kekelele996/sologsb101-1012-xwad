import { evaluateDue, totalSuspendedDays, overlapDays } from '../src/types/suspension';
import { reconcileLedgers } from '../src/types/reconcile';
import type { SeisStation } from '../src/types/station';
import type { Instrument } from '../src/types/instrument';
import type { Calibration } from '../src/types/calibration';
import type { SuspensionWindow } from '../src/types/suspension';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)})`);
}

const TODAY = '2026-10-03';
const CYCLE = 365;

console.log('overlapDays:');
assert(overlapDays({ startDate: '2026-01-01', endDate: '2026-01-10' }, 0, 0) === 0, '区间不重叠为 0');
assert(overlapDays({ startDate: '2026-01-01', endDate: '2026-01-10' }, day('2026-01-05'), day('2026-01-05')) === 1, '单日重叠为 1（含当日）');
assert(overlapDays({ startDate: '2026-01-01', endDate: '2026-01-10' }, day('2026-01-01'), day('2026-01-10')) === 10, '整段 10 天含首尾');
assert(overlapDays({ startDate: '2026-01-01', endDate: '' }, day('2026-01-01'), day('2026-01-05')) === 5, '未复测窗口按到 toDay 计');

console.log('totalSuspendedDays 重叠去重:');
assert(
  totalSuspendedDays(
    [
      { startDate: '2026-01-01', endDate: '2026-01-10' },
      { startDate: '2026-01-05', endDate: '2026-01-15' },
    ],
    day('2026-01-01'),
    day('2026-01-31')
  ) === 15,
  '重叠窗口合并计 15 天'
);

console.log('evaluateDue:');
// 1. 正常无停测
{
  const r = evaluateDue({ baseDate: '2026-01-01', cycleDays: CYCLE, windows: [], stationState: '运行', today: TODAY });
  assert(r.state === 'normal' && r.dueInDays === 90, `正常在周期内剩余 90 天，state=${r.state} due=${r.dueInDays}`);
  assert(r.deductedDays === 0, '无停测扣减 0 天');
}
// 2. 无停测硬超期
{
  const r = evaluateDue({ baseDate: '2025-01-01', cycleDays: CYCLE, windows: [], stationState: '运行', today: TODAY });
  assert(r.state === 'overdue' && r.dueInDays === -275, `硬超期 275 天，state=${r.state} due=${r.dueInDays}`);
}
// 3. 停测已复测：扣减后到期，复测后照旧算超期
//    基准 2024-09-05（+365 = 2025-09-05 名义到期），停测 2024-12-01~2025-07-20 共 232 天
//    到今天累计停测 232 天 → 实际到期 2026-04-25 → 超期 161 天
{
  const windows = [{ startDate: '2024-12-01', endDate: '2025-07-20' }];
  const r = evaluateDue({ baseDate: '2024-09-05', cycleDays: CYCLE, windows, stationState: '运行', today: TODAY });
  assert(r.deductedDays === 232, `已复测停测扣减 232 天（got ${r.deductedDays}）`);
  assert(r.effectiveDueDate === '2026-04-25', `实际到期 2026-04-25（got ${r.effectiveDueDate}）`);
  assert(r.state === 'overdue', '复测后已到期 → 照旧算超期，进更换提醒');
  assert(r.inSuspension === false, '已不在停测窗口内');
}
// 4. 停测中，扣减后够不到期 → suspended-ok，不进提醒
//    基准 2024-09-30，名义到期 2025-09-30；停测从 2025-08-29 开始未结束
//    到今天停了 400 天 → 实际到期 2026-11-05 → 还剩 33 天
{
  const windows = [{ startDate: '2025-08-29', endDate: '' }];
  const r = evaluateDue({ baseDate: '2024-09-30', cycleDays: CYCLE, windows, stationState: '停测', today: TODAY });
  assert(r.inSuspension === true, '今天在停测窗口内');
  assert(r.state === 'suspended-ok', `停测中扣减后未到期 → suspended-ok（got ${r.state}）`);
  assert((r.dueInDays ?? -1) === 33, `顺延后续剩 33 天（got ${r.dueInDays}）`);
}
// 5. 停测前就已到期的，停测中仍算超期
//    基准 2024-10-04，名义到期 2025-10-04；停测从 2026-03-01 开始（名义到期后 148 天才停）
//    到期时没在停测，是硬超期；到今天停了 216 天 → 实际到期 2026-05-08 → 仍超期 148 天（365+216=581 天前基准）
{
  const windows = [{ startDate: '2026-03-01', endDate: '' }];
  const r = evaluateDue({ baseDate: '2024-10-04', cycleDays: CYCLE, windows, stationState: '停测', today: TODAY });
  assert(r.state === 'overdue', '名义到期日早于停测起始日 → 停测前已超期，保持超期');
  assert(r.dueInDays === -148 || r.dueInDays === -147, `仍超期约 148 天（got ${r.dueInDays}）`);
}
// 6. 只标停测状态、中心没登记时段 → pending-period，dueInDays=null，不算超期
{
  const r = evaluateDue({ baseDate: '2023-06-11', cycleDays: CYCLE, windows: [], stationState: '停测', today: TODAY });
  assert(r.state === 'pending-period', `待登记时段 → pending-period（got ${r.state}）`);
  assert(r.dueInDays === null, '挂起时不给出超期天数');
  assert(r.effectiveDueDate === null, '挂起时不给实际到期日');
  assert(r.awaitingPeriod === true, 'awaitingPeriod=true');
}
// 7. 状态运行即使有历史停测窗口，也按正常计算
{
  const windows = [{ startDate: '2024-01-01', endDate: '2024-02-01' }];
  const r = evaluateDue({ baseDate: '2026-01-01', cycleDays: CYCLE, windows, stationState: '运行', today: TODAY });
  assert(r.state === 'normal', '窗口早于基准日不影响本周期');
}

console.log('reconcileLedgers:');
const stations: SeisStation[] = [
  mkStation('s1', 'arr1', 'LTX01'),
  mkStation('s2', 'arr1', 'LTX02'),
  mkStation('s3', 'arr1', 'LTX03'),
  // s4 中心存在但计量站无标定
  mkStation('s4', 'arr1', 'LTX04'),
];
const instruments: Instrument[] = [
  mkInstrument('i1', 's1'),
  mkInstrument('i2', 's2'),
  mkInstrument('i3', 's3'),
];
const mkCal = (id: string, iid: string, date: string, acknowledgedAt: number | null): Calibration =>
  ({
    id, instrumentId: iid, date, sensitivity: 1500, selfNoise: 1, responseVerdict: '合格',
    operator: 'x', agency: 'y', acknowledgedAt, remark: '', createdAt: 1, updatedAt: 1,
  });
const calibrations: Calibration[] = [
  mkCal('c1', 'i1', '2026-01-01', null),
  mkCal('c2', 'i2', '2026-02-01', 12345), // 已认账
  mkCal('c3', 'i3', '2026-03-01', null),
];
// 计量站还挂着一个台站档案已删除的仪器 → 中心缺档案
instruments.push(mkInstrument('i9', 's-gone'));
calibrations.push(mkCal('c9', 'i9', '2026-04-01', null));

const windows: SuspensionWindow[] = [];
const report = reconcileLedgers({ stations, windows, instruments, calibrations, now: 999 });
const byCode = new Map(report.items.map((i) => [i.stationCode, i]));
assert(report.total === 5, `共 5 个台站码（got ${report.total}）`);
assert(byCode.get('LTX01')?.status === 'matched', 'LTX01 对平');
assert(byCode.get('LTX02')?.status === 'matched' && byCode.get('LTX02')?.acknowledgedAt === 12345, 'LTX02 对平且带认账时间');
assert(byCode.get('LTX04')?.status === 'calibration-missing', 'LTX04 计量站缺标定');
assert(byCode.get('?s-gone')?.status === 'center-missing', '仪器挂在已删台站下 → 中心缺档案');
assert(report.matched === 3 && report.failed === 2, `对平 3 / 失败 2（got ${report.matched}/${report.failed}）`);

console.log('reconcile 台站码重复:');
{
  const dupStations = [mkStation('a', 'arr1', 'DUP'), mkStation('b', 'arr1', 'DUP')];
  const dupInstruments = [mkInstrument('ia', 'a')];
  const dupCalibs = [mkCal('ca', 'ia', '2026-01-01', null)];
  const r = reconcileLedgers({ stations: dupStations, windows: [], instruments: dupInstruments, calibrations: dupCalibs });
  assert(r.items[0]?.status === 'duplicated-code', '重复台站码判 duplicated-code');
}

if (failed > 0) {
  console.error(`\n${failed} 个断言失败`);
  process.exit(1);
}
console.log('\n全部通过');

function day(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00`) / 86400000);
}
function mkStation(id: string, arrayId: string, code: string): SeisStation {
  return {
    id, arrayId, code, lat: 1, lng: 1, elevM: 1, bedrock: '花岗岩', obsStatus: '运行',
    siteNote: '', createdAt: 1, updatedAt: 1,
  };
}
function mkInstrument(id: string, stationId: string): Instrument {
  return {
    id, stationId, type: '宽频带', model: 'M', serialNo: id, installDate: '2020-01-01',
    state: '在用', remark: '', createdAt: 1, updatedAt: 1,
  };
}
